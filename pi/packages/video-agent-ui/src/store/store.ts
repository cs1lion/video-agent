/**
 * Studio 全局状态：run 轮询（2s）、产物拉取、导演对话、微调与续跑。
 * bind(runId) 后自动开始轮询；unbind 由路由离开时调用。
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

	bind(runId) {
		if (get().runId === runId && timer !== undefined) return;
		get().unbind();
		set({ runId, run: get().run?.id === runId ? get().run : null, artifacts: null, error: null });
		void get().refresh();
		timer = setInterval(() => {
			const { run, chatBusy, refining } = get();
			if (run && run.status !== "running" && !chatBusy && !refining && !run.awaitingResume) return;
			void get().refresh();
		}, 2000);
	},

	unbind() {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
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
