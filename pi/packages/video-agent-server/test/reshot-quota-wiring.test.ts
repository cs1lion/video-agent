/**
 * B1 redo 路径配额接线 —— reshotRun 补拍重做与账本交互。
 *
 * 验收口径（总文档 4.2.3 余项）：redo 路径接账本后，补拍同样走
 * 「预检 → 预留 → 提交 → 结算/退还」闭环，i2v→t2v 降级各自独立预留。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { RunRecord } from "../src/pipeline.ts";
import type { ServerContext } from "../src/config.ts";
import { VIDEO_QUOTA_POOL } from "../src/config.ts";
import { QuotaLedger } from "../src/quota.ts";

// ---------------------------------------------------------------------------
// 桩实现
// ---------------------------------------------------------------------------

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** probeDuration 桩的返回值（按用例拨动：实测时长 / null = 探测失败） */
let probeSec: number | null = 3.6;

/** 共享队列行为（所有 FakeQueue 实例共享，保证测试间隔离） */
let queueFailVideo = false;
let queueI2vFailOnly = false;

class FakeQueue {
	submitCalls = 0;
	private seq = 0;
	private readonly jobs = new Map<string, unknown>();
	submit(input: { kind: "image" | "video" | "tts" | "music"; outputName: string }, projectDir: string) {
		this.submitCalls += 1;
		const id = `J${this.seq++}`;
		const relative = path.posix.join("assets", `${input.outputName}.mp4`);
		if (input.kind === "video" && queueFailVideo) {
			const job = { id, status: "failed" as const, filePath: undefined, relativePath: relative, attemptLog: [] as unknown[] };
			this.jobs.set(id, job);
			return job;
		}
		if (input.kind === "video" && queueI2vFailOnly) {
			if (this.submitCalls <= 1) {
				const job = { id, status: "failed" as const, filePath: undefined, relativePath: relative, attemptLog: [] as unknown[] };
				this.jobs.set(id, job);
				return job;
			}
		}
		const absolute = path.join(projectDir, relative);
		const job = {
			id,
			status: "done" as const,
			filePath: absolute,
			relativePath: relative,
			attemptLog: [] as unknown[],
		};
		this.jobs.set(id, job);
		void (async () => {
			await mkdir(path.dirname(absolute), { recursive: true });
			await writeFile(absolute, Buffer.from([0x00, 0x01]), "utf-8");
		})();
		return job;
	}
	async awaitJob<T>(jobId: string): Promise<T> {
		return this.jobs.get(jobId) as T;
	}
	stats() {
		return { retries: 0, adapters: {} as Record<string, { done: number }> };
	}
}

const STAGE_IDS = ["script", "visual", "prompts", "keyframes", "clips", "audio", "export"] as const;
const OLD_CLIP = "assets/clip-SH01.mp4";
const OLD_CLIP_BYTES = "old-clip-bytes";

function installMocks(): void {
	mock.module(new URL("../src/llm.ts", import.meta.url).href, {
		namedExports: {
			LlmError: class extends Error {},
			chat: async () => "ok",
			chatVisionJson: async () => ({}),
			chatJson: async (_llm: unknown, user: unknown) => {
				const text = (typeof user === "string" ? user : JSON.stringify(user)).replace(/\\/g, "");
				if (text.includes("narrationZh"))
					return {
						title: "测试片",
						logline: "测试用",
						shots: [
							{ id: "SH01", narrationZh: "旁白", narrationEn: "n", visual: "一个镜头", durationSec: 5 },
						],
					};
				return {};
			},
			tryParseJson: <T>(raw: string) => JSON.parse(raw) as T,
		},
	});
	mock.module(new URL("../../coding-agent/examples/extensions/studio/media/queue.ts", import.meta.url).href, {
		namedExports: { GenerationQueue: FakeQueue },
	});
	mock.module(new URL("../src/ffmpeg.ts", import.meta.url).href, {
		namedExports: {
			FfmpegError: class extends Error {},
			SFX_LABEL: { whoosh: "嗖", impact: "砰", riser: "升" } as Record<string, string>,
			TRANSITION_LABEL: {
				cut: "硬切",
				fade: "淡入淡出",
				dip: "叠化",
				white: "闪白",
				wipeleft: "左划",
				slideup: "上滑",
			} as Record<string, string>,
			decodeMonoPcm: async (): Promise<Int16Array> => Int16Array.from({ length: 16000 }, (_, i) => Math.round(10000 * Math.sin(i / 8))),
			probeDuration: async (): Promise<number | null> => probeSec,
			runFfmpeg: async (): Promise<string> => "",
			runFfmpegCapture: async (): Promise<string> => "",
			buildAssSubtitles: (_e: unknown[], width: number, height: number): string => `stub-ass-${width}x${height}`,
			normalizeShot: async (o: { cwd: string; outPath: string }) => {
				await mkdir(path.dirname(path.join(o.cwd, o.outPath)), { recursive: true });
				await writeFile(path.join(o.cwd, o.outPath), Buffer.from([1]));
			},
			concatWithSubtitles: async (o: { cwd: string; outPath: string }) => {
				await mkdir(path.dirname(path.join(o.cwd, o.outPath)), { recursive: true });
				await writeFile(path.join(o.cwd, o.outPath), Buffer.from([1]));
			},
			extractFrame: async (o: { cwd: string; outPath: string }) => {
				await mkdir(path.dirname(path.join(o.cwd, o.outPath)), { recursive: true });
				await writeFile(path.join(o.cwd, o.outPath), PNG_1PX);
			},
			assembleTimeline: async (): Promise<{ totalSec: number; usedTransitions: number; sfxUsed: number }> => ({
				totalSec: 4,
				usedTransitions: 0,
				sfxUsed: 0,
			}),
			buildPauseFilters: (_totalSec: number, pausesSec: number[]): string | null => (pausesSec.length ? "stub" : null),
			insertPauses: async (): Promise<void> => {},
			padTailToSec: async (): Promise<"padded" | "skipped"> => "skipped",
		},
	});
}

// ---------------------------------------------------------------------------
// 场景驱动
// ---------------------------------------------------------------------------

describe("B1 redo 路径配额接线（reshotRun 层）", () => {
	let reshot: typeof import("../src/redo/reshot.ts");
	let root: string;

	before(async () => {
		installMocks();
		reshot = await import("../src/redo/reshot.ts");
		root = await mkdtemp(path.join(tmpdir(), "pi-reshot-quota-"));
	});

	after(async () => {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	function makeCtx(quota?: QuotaLedger): ServerContext {
		return {
			studioRoot: root,
			mediaConfig: {
				media: [{ id: "v", kind: "video", model: "agnes-video-2.5-flash" }],
				defaults: { concurrency: 2, maxAttempts: 3, priority: 0 },
			},
			llm: { url: "http://stub", model: "stub", timeoutMs: 1000 },
			port: 0,
			priceCatalog: {
				media: {},
				llm: {},
				fallback: { currency: "CNY", perCall: 0.5, perInputToken: 0.0001, perOutputToken: 0.0003, perSecond: 0.8, perKChar: 0.05 },
				source: "<test>",
			},
			...(quota ? { quota } : {}),
		};
	}

	function makeLedger(dailyQuotaSec: number | null, rpmCap = 100): QuotaLedger {
		return new QuotaLedger([{ id: VIDEO_QUOTA_POOL, keyType: "tokenplan", rpmCap, dailyQuotaSec }]);
	}

	async function freshRun(): Promise<{ dir: string; run: RunRecord }> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-reshot-quota-"));
		await mkdir(path.join(dir, "assets"), { recursive: true });

		await writeFile(
			path.join(dir, "script.json"),
			JSON.stringify({
				title: "测试片",
				logline: "测试用",
				shots: [{ id: "SH01", narrationZh: "旁白", narrationEn: "n", visual: "一个镜头", durationSec: 5 }],
			}),
			"utf-8",
		);
		await writeFile(
			path.join(dir, "prompts.json"),
			JSON.stringify({ prompts: [{ shotId: "SH01", prompt: "一个镜头" }] }),
			"utf-8",
		);
		await writeFile(
			path.join(dir, "keyframes.json"),
			JSON.stringify({ frames: [{ shotId: "SH01", status: "done", file: "assets/key-SH01.png" }] }),
			"utf-8",
		);
		await writeFile(path.join(dir, "assets/key-SH01.png"), PNG_1PX, "utf-8");
		await writeFile(path.join(dir, OLD_CLIP), OLD_CLIP_BYTES, "utf-8");

		const run = {
			id: "run-reshot-quota-test",
			dir,
			status: "done",
			brief: { creative: { logline: "测试用", keyMessage: "" }, style: "", audience: "", tone: "", cta: "", brand: "", language: "zh" },
			stages: STAGE_IDS.map((id) => ({ id, status: id === "export" ? "pending" : "done", progress: 1 })),
			metrics: { mediaCalls: 0, llmCalls: 0, llmTokensIn: 0, llmTokensOut: 0, usd: 0 },
			events: [],
			images: [],
			shotAttempts: {},
			shotVersions: {},
			lastActions: [],
			redoActive: null,
			abort: new AbortController(),
			options: { resolution: "1080p", aspectRatio: "16:9", voice: "alloy", music: "none" },
			verdict: undefined,
			videoUrl: undefined,
		} as unknown as RunRecord;

		return { dir, run };
	}

	/** reshotRun 是 fire-and-forget：轮询 redoActive 被清空来判断异步 IIFE 结束 */
	async function waitForCompletion(run: RunRecord): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (run.redoActive === null && run.status !== "running") return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error(`reshot 未在 10s 内结束（status=${run.status} error=${run.error}）`);
	}

	it("足额链路：提交前预留，出片后按实测时长结算（账实相符）", async () => {
		probeSec = 3.6;
		queueFailVideo = false;
		queueI2vFailOnly = false;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run } = await freshRun();
		reshot.reshotRun(ctx, run, "SH01", "");
		await waitForCompletion(run);
		assert.equal(run.status, "done", "足额时应成功");
		assert.equal(run.metrics.mediaCalls, 1, "i2v 一次成功，不应触发降级重试");
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 496.4) < 1e-6, `剩余应为 496.4，实际 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0, "出片结算后不应有在途预留");
	});

	it("探测失败 → 按预估时长兜底结算（不得少结/漏结）", async () => {
		probeSec = null;
		queueFailVideo = false;
		queueI2vFailOnly = false;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run } = await freshRun();
		reshot.reshotRun(ctx, run, "SH01", "");
		await waitForCompletion(run);
		assert.equal(run.status, "done");
		// probeDuration 返回 null → settle 用预估 5s：500 - 5
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 495) < 1e-6, `剩余应为 495，实际 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
	});

	it("配额不足 → 零派发（零违规锁）：一个请求都不进队列，预算告警留痕", async () => {
		probeSec = 3.6;
		queueFailVideo = false;
		queueI2vFailOnly = false;
		const quota = makeLedger(2); // 预估 5s/镜，配额只剩 2s
		const ctx = makeCtx(quota);
		const { run } = await freshRun();
		const res = await reshot.reshotRun(ctx, run, "SH01", "");
		// 配额不足在异步 IIFE 内 bail，同步返回值恒为 { ok: true }（fire-and-forget）
		assert.equal(run.status, "failed", "配额不足应置 failed");
		assert.equal(run.metrics.mediaCalls, 0, "配额不足时不许任何请求进队列（宁停勿撞 429）");
		assert.ok(
			run.events.some((e) => e.text.includes("补拍配额不足")),
			"必须留配额不足事件",
		);
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 2) < 1e-6, "未派发则配额分毫不动");
	});

	it("生成失败 → 预留全额退还（无幻影消耗），i2v→t2v 降级各占一次预留", async () => {
		probeSec = 3.6;
		queueFailVideo = true;
		queueI2vFailOnly = false;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run } = await freshRun();
		reshot.reshotRun(ctx, run, "SH01", "");
		await waitForCompletion(run);
		assert.equal(run.status, "failed");
		// 每镜 i2v + t2v 两次提交（降级重试是新 attempt：新幂等键、新预留、旧预留已退还）
		assert.equal(run.metrics.mediaCalls, 2);
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 500) < 1e-6, `失败必须全额退还，实际剩 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0);
	});

	it("i2v 失败 → t2v 成功：旧预留退还、新预留结算", async () => {
		probeSec = 3.6;
		queueFailVideo = false;
		queueI2vFailOnly = true;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run } = await freshRun();
		reshot.reshotRun(ctx, run, "SH01", "");
		await waitForCompletion(run);
		assert.equal(run.status, "done", "t2v 成功应收敛为 done");
		assert.equal(run.metrics.mediaCalls, 2, "i2v 失败后应降级 t2v");
		// i2v 预留退还 + t2v 预留结算 3.6s：500 - 3.6
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 496.4) < 1e-6, `剩余应为 496.4，实际 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0);
	});
});
