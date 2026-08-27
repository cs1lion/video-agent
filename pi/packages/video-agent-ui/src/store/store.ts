/**
 * Studio 全局状态：SSE 实时快照 + 轮询兜底、产物拉取、导演对话、微调与续跑。
 * bind(runId) 后先建立长连接；连接异常自动改为高频轮询，恢复 live 后停止无效轮询。
 */

import { create } from "zustand";
import { type ArtifactsView, api, type DeliberationRound, type RunView, type StageId } from "@/api/client";

interface StudioState {
	runId: string | null;
	run: RunView | null;
	artifacts: ArtifactsView | null;
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
	/** run 更新通道：connecting 初始；live=SSE；polling=SSE 暂不可用 */
	transport: "connecting" | "live" | "polling";
	bind(runId: string): void;
	unbind(): void;
	refresh(): Promise<void>;
	sendChat(text: string): Promise<boolean>;
	submitRefine(stageId: StageId, instruction: string, autoResume?: boolean): Promise<boolean>;
	reshot(shotId: string, instruction: string): Promise<boolean>;
	retts(shotId: string, instruction: string, voice?: string): Promise<boolean>;
	designAdjust(entityId: string, instruction: string): Promise<boolean>;
	keyframeAdjust(shotId: string, instruction: string): Promise<boolean>;
	compose(selections: Record<string, { video?: string; audio?: string }>): Promise<boolean>;
	resume(): Promise<void>;
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

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const useStudio = create<StudioState>((set, get) => ({
	runId: null,
	run: null,
	artifacts: null,
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
		set({ runId, run: get().run?.id === runId ? get().run : null, artifacts: null, error: null });
		void get().refresh();

		// SSE 是主通道：每条 run 快照到达后立即同步 UI，并短暂去抖地拉取产物
		streamClose = api.streamRun(runId, {
			onOpen: () => set({ transport: "live", error: null }),
			onError: () => set({ transport: "polling" }),
			onRun: (run) => {
				lastStreamAt = Date.now();
				set({ run, error: null });
				const id = get().runId;
				if (id !== run.id) return;
				if (artifactTimer !== undefined) clearTimeout(artifactTimer);
				artifactTimer = setTimeout(() => void get().refresh(), 90);
			},
		});

		// 原有轮询保留为兜底/watchdog：断线时 2s 生效；live 时只处理长时间静默
		timer = setInterval(() => {
			const { run, chatBusy, refining, transport } = get();
			if (transport === "live" && Date.now() - lastStreamAt < 12_000) return;
			if (
				run &&
				run.status !== "running" &&
				!chatBusy &&
				!refining &&
				!run.awaitingResume &&
				Date.now() - lastStreamAt < 12_000
			)
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
		set({ transport: "connecting" });
	},

	async refresh() {
		const runId = get().runId;
		if (!runId) return;
		try {
			const [run, artifacts] = await Promise.all([api.pollRun(runId), api.fetchArtifacts(runId)]);
			set({ run, artifacts, error: null });
		} catch (error) {
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

	async submitRefine(stageId, instruction, autoResume = false) {
		const runId = get().runId;
		if (!runId || get().refining) return false;
		set({ refining: true });
		try {
			await api.refine(runId, stageId, instruction, autoResume);
			set({ lastRefine: { stageId, instruction, at: Date.now() } });
			return true;
		} catch (error) {
			set({ error: messageOf(error) });
			return false;
		} finally {
			set({ refining: false });
			void get().refresh();
		}
	},

	async reshot(shotId, instruction) {
		const runId = get().runId;
		if (!runId || get().refining) return false;
		set({ refining: true });
		try {
			await api.reshot(runId, shotId, instruction);
			return true;
		} catch (error) {
			set({ error: messageOf(error) });
			return false;
		} finally {
			set({ refining: false });
			void get().refresh();
		}
	},

	async retts(shotId, instruction, voice) {
		const runId = get().runId;
		if (!runId || get().refining) return false;
		set({ refining: true });
		try {
			await api.retts(runId, shotId, instruction, voice);
			return true;
		} catch (error) {
			set({ error: messageOf(error) });
			return false;
		} finally {
			set({ refining: false });
			void get().refresh();
		}
	},

	async designAdjust(entityId, instruction) {
		const runId = get().runId;
		if (!runId || get().refining) return false;
		set({ refining: true });
		try {
			await api.designAdjust(runId, entityId, instruction);
			return true;
		} catch (error) {
			set({ error: messageOf(error) });
			return false;
		} finally {
			set({ refining: false });
			void get().refresh();
		}
	},

	async keyframeAdjust(shotId, instruction) {
		const runId = get().runId;
		if (!runId || get().refining) return false;
		set({ refining: true });
		try {
			await api.keyframeAdjust(runId, shotId, instruction);
			return true;
		} catch (error) {
			set({ error: messageOf(error) });
			return false;
		} finally {
			set({ refining: false });
			void get().refresh();
		}
	},

	async compose(selections) {
		const runId = get().runId;
		if (!runId || get().refining) return false;
		set({ refining: true });
		try {
			await api.composeCut(runId, selections);
			return true;
		} catch (error) {
			set({ error: messageOf(error) });
			return false;
		} finally {
			set({ refining: false });
			void get().refresh();
		}
	},

	async resume() {
		const runId = get().runId;
		if (!runId) return;
		try {
			await api.resume(runId);
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
}));
