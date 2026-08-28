/**
 * Studio 全局状态：SSE 实时快照 + 轮询兜底、产物拉取、导演对话、微调与续跑。
 * bind(runId) 后先建立长连接；连接异常自动改为高频轮询，恢复 live 后停止无效轮询。
 *
 * 竞态防护：refresh() 带 reqSeq 序号 + runId 复核 ——
 * 迟到的旧响应（切换 run 前发出）在写入前被丢弃，绝不覆盖更新的 SSE 快照或新 run 的视图。
 */

import { create } from "zustand";
import {
	type ArtifactsView,
	api,
	type DeliberationRound,
	type RunView,
	type StageId,
	type TeamEvent,
} from "@/api/client";

interface StudioState {
	runId: string | null;
	run: RunView | null;
	artifacts: ArtifactsView | null;
	/**
	 * 团队事件流：**刻意独立于 run 存放**，不放在 run 对象里。
	 * 原因：事件是高频增量流，若挂在 run 上，每条事件都会换掉 run 的对象引用，
	 * 于是任何订阅 run 的组件（含整页 StudioPage）都被拖着重渲染——useShallow 也拦不住。
	 * 独立成字段后，只有订阅 events 的组件（指挥台）会因新事件重渲染。
	 */
	events: TeamEvent[];
	/** 最近一次轮询/操作错误（UI 顶部横幅展示，下一次成功轮询后自动清除） */
	error: string | null;
	chatBusy: boolean;
	refining: boolean;
	/** 最近一次微调（阶段面板展示「按你的意见重塑中」横幅用） */
	lastRefine: { stageId: StageId; instruction: string; at: number } | null;
	/** 审议循环进行中（对比工作台展示「导演审议中」态） */
	deliberating: boolean;
	/** 最近一轮审议结果（对比工作台展示归因提案卡片） */
	lastDeliberation: DeliberationRound | null;
	/** run 更新通道：connecting 初始；live=SSE；polling=SSE 暂不可用或静默超时 */
	transport: "connecting" | "live" | "polling";
	bind(runId: string): void;
	unbind(): void;
	refresh(): Promise<void>;
	sendChat(text: string): Promise<boolean>;
	submitRefine(stageId: StageId, instruction: string, autoResume?: boolean): Promise<boolean>;
	reshot(shotId: string, instruction: string): Promise<boolean>;
	retts(shotId: string, instruction: string, voice?: string): Promise<boolean>;
	designAdjust(entityId: string, instruction: string): Promise<boolean>;
	designReview(entityIds?: string[]): Promise<boolean>;
	keyframeAdjust(shotId: string, instruction: string): Promise<boolean>;
	compose(selections: Record<string, { video?: string; audio?: string }>): Promise<boolean>;
	resume(confirmedShotIds?: string[]): Promise<void>;
	cancel(): Promise<void>;
	startDeliberation(input: {
		baseId: string;
		challengerId?: string;
		verdict: "base" | "challenger" | "neither";
		tags: string[];
		note?: string;
	}): Promise<DeliberationRound | null>;
}

let timer: ReturnType<typeof setInterval> | undefined;
let streamClose: (() => void) | undefined;
let artifactTimer: ReturnType<typeof setTimeout> | undefined;
let lastStreamAt = 0;
/** refresh 序号：每次调用自增；await 返回后序号已变 / runId 已换 → 丢弃本次响应 */
let reqSeq = 0;

/** 前端事件窗口上限：与后端 EVENT_CAP（400）对齐。
 *  增量通道（SSE "ev"）逐条追加后按此裁剪，避免本地数组无限增长。 */
const EVENT_CAP_UI = 400;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 合并「快照事件」与「本地增量事件」：快照决定顺序，本地多出来的
 * （增量通道已到、但这份快照还没带上的）补在末尾，按 id 去重。
 * 两条通道（SSE "run" 快照 / SSE "ev" 增量）都会带同一条事件，不去重会重复渲染。
 */
function mergeEvents(snapshot: TeamEvent[], local: TeamEvent[]): TeamEvent[] {
	if (local.length === 0) return snapshot;
	const seen = new Set(snapshot.map((e) => e.id));
	const extra = local.filter((e) => !seen.has(e.id));
	return extra.length === 0 ? snapshot : [...snapshot, ...extra].slice(-EVENT_CAP_UI);
}

export const useStudio = create<StudioState>((set, get) => {
	/**
	 * 统一的「互斥执行类 action」封装：runId 守卫 + refining 占位 + 错误横幅 + 完成后刷新。
	 * 之前 reshot/retts/designAdjust/keyframeAdjust/compose/submitRefine 是同一段模板复制 6 份，漂移风险高。
	 * onSuccess 拿到本次调用参数（submitRefine 记录 lastRefine 用）。
	 */
	const runAction = <A extends unknown[]>(
		apiFn: (runId: string, ...args: A) => Promise<unknown>,
		onSuccess?: (...args: A) => void,
	) => {
		return async (...args: A): Promise<boolean> => {
			const runId = get().runId;
			if (!runId || get().refining) return false;
			set({ refining: true });
			try {
				await apiFn(runId, ...args);
				onSuccess?.(...args);
				return true;
			} catch (error) {
				set({ error: messageOf(error) });
				return false;
			} finally {
				set({ refining: false });
				void get().refresh();
			}
		};
	};

	return {
		runId: null,
		run: null,
		artifacts: null,
		events: [],
		error: null,
		chatBusy: false,
		refining: false,
		lastRefine: null,
		deliberating: false,
		lastDeliberation: null,
		transport: "connecting",

		bind(runId) {
			if (get().runId === runId && timer !== undefined && streamClose !== undefined) return;
			get().unbind();
			reqSeq += 1; // 使上一个 run 在途的 refresh 全部作废
			set({
				runId,
				run: get().run?.id === runId ? get().run : null,
				artifacts: null,
				events: [],
				error: null,
			});
			void get().refresh();

			// SSE 是主通道：每条 run 快照到达后立即同步 UI，并短暂去抖地拉取产物
			streamClose = api.streamRun(runId, {
				onOpen: () => set({ transport: "live", error: null }),
				onError: () => set({ transport: "polling" }),
				onRun: (run) => {
					lastStreamAt = Date.now();
					// 通道收到消息即证明连接活着：从「静默降级」恢复 live（LIVE pill 如实）
					if (run.id !== get().runId) {
						set({ error: null });
						return;
					}
					// 事件独立成字段：快照只用于校正 events，不把事件塞回 run
					set({
						run,
						events: mergeEvents(run.events, get().events),
						error: null,
						transport: "live",
					});
					if (artifactTimer !== undefined) clearTimeout(artifactTimer);
					artifactTimer = setTimeout(() => void get().refresh(), 90);
				},
				// 事件级增量通道：团队事件已不再触发完整快照，不接这条消息就会「看不见」。
				// 关键：只动 events 字段、绝不重建 run 对象 —— 否则每条事件都会牵动整页重渲染。
				onEvent: (event) => {
					lastStreamAt = Date.now();
					if (!get().runId) return;
					set({ events: mergeEvents(get().events, [event]), transport: "live" });
				},
			});

			// 原有轮询保留为兜底/watchdog：断线时 2s 生效；live 时只处理长时间静默
			timer = setInterval(() => {
				const { run, chatBusy, refining, transport } = get();
				const stale = Date.now() - lastStreamAt >= 12_000;
				// SSE 静默超时：连接可能在但不推流（半死状态），LIVE pill 必须如实降级
				if (transport === "live" && stale) set({ transport: "polling" });
				if (transport === "live" && !stale) return;
				if (run && run.status !== "running" && !chatBusy && !refining && !run.awaitingResume && !stale)
					return;
				void get().refresh();
			}, 2000);
		},

		unbind() {
			if (timer !== undefined) clearInterval(timer);
			streamClose?.();
			if (artifactTimer !== undefined) clearTimeout(artifactTimer);
			timer = undefined;
			streamClose = undefined;
			artifactTimer = undefined;
			lastStreamAt = 0;
			reqSeq += 1; // unbind 后在途 refresh 全部作废
			set({ transport: "connecting", events: [] });
		},

		async refresh() {
			const runId = get().runId;
			if (!runId) return;
			const seq = ++reqSeq;
			try {
				const [run, artifacts] = await Promise.all([api.pollRun(runId), api.fetchArtifacts(runId)]);
				// 序号已变（有更新的 refresh）或已切换 run → 本次响应过期，丢弃
				if (seq !== reqSeq || get().runId !== runId) return;
				// 事件走独立字段：合并保留增量通道已到、这份快照还没带上的事件
				set({ run, artifacts, events: mergeEvents(run.events, get().events), error: null });
			} catch (error) {
				if (seq !== reqSeq || get().runId !== runId) return;
				set({ error: messageOf(error) });
			}
		},

		async sendChat(text) {
			const runId = get().runId;
			if (!runId || get().chatBusy) return false;
			set({ chatBusy: true });
			try {
				await api.chat(runId, text);
				return true;
			} catch (error) {
				set({ error: messageOf(error) });
				return false;
			} finally {
				set({ chatBusy: false });
				void get().refresh();
			}
		},

		submitRefine: runAction(
			(runId, stageId: StageId, instruction: string, autoResume?: boolean) =>
				api.refine(runId, stageId, instruction, autoResume),
			(stageId, instruction) => set({ lastRefine: { stageId, instruction, at: Date.now() } }),
		),

		reshot: runAction(api.reshot.bind(api)),

		retts: runAction(api.retts.bind(api)),

		designAdjust: runAction(api.designAdjust.bind(api)),
		designReview: runAction(api.designReview.bind(api)),

		keyframeAdjust: runAction(api.keyframeAdjust.bind(api)),

		compose: runAction(api.composeCut.bind(api)),

		async resume(confirmedShotIds) {
			const runId = get().runId;
			if (!runId) return;
			try {
				await api.resume(runId, confirmedShotIds);
				set({ error: null });
			} catch (error) {
				set({ error: messageOf(error) });
			} finally {
				void get().refresh();
			}
		},

		async cancel() {
			const runId = get().runId;
			if (!runId) return;
			try {
				await api.cancelRun(runId);
			} catch (error) {
				set({ error: messageOf(error) });
			} finally {
				void get().refresh();
			}
		},

		async startDeliberation(input) {
			const runId = get().runId;
			if (!runId || get().deliberating) return null;
			set({ deliberating: true, lastDeliberation: null });
			try {
				const result = await api.startDeliberation(runId, input);
				set({ lastDeliberation: result.round });
				return result.round;
			} catch (error) {
				set({ error: messageOf(error) });
				return null;
			} finally {
				set({ deliberating: false });
				void get().refresh();
			}
		},
	};
});
