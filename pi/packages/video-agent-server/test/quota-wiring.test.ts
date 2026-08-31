/**
 * B1 接线行为测试 —— 配额账本接入 stageClips 提交循环。
 *
 * 验收口径（总文档 4.4 B1）：「不违规（零超额 429）、不丢任务」。
 * 翻译成本测试锁住的四条：
 *   1. 足额链路：提交前预留、出片后按实测时长结算（账实相符）；
 *   2. 配额不足：**零派发**——一个请求都不进队列（不硬撞 429），预算告警留痕；
 *   3. 生成失败：预留全额退还——没有幻影消耗（失败不烧时长配额）；
 *   4. RPM 暂缺：等待令牌补充后重试，而不是立即失败。
 *
 * 脚手架与 audio-gate.test.ts 同构（mock llm/queue/ffmpeg，startRun 推到
 * design 闸门停机后直接驱动 stageClips）。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { ServerContext } from "../src/config.ts";
import { VIDEO_QUOTA_POOL } from "../src/config.ts";
import { QuotaLedger } from "../src/quota.ts";

// ---------------------------------------------------------------------------
// 桩实现（形状与 audio-gate.test.ts 保持一致，队列/探测行为可按用例拨动）
// ---------------------------------------------------------------------------

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** probeDuration 桩的返回值（按用例拨动：实测时长 / null = 探测失败） */
let probeSec: number | null = 3.6;

class FakeQueue {
	submitCalls = 0;
	failVideo = false;
	/** 只让第 1 次视频提交失败（降级重试链路拨杆：重试应重新选池+换 key） */
	failFirstVideo = false;
	/** 每次提交收到的 adapterId（多 key 并发：账本选池 → 执行走对应 key 的账实相符锁） */
	adapterIds: (string | undefined)[] = [];
	private seq = 0;
	private videoSeq = 0;
	private readonly jobs = new Map<string, unknown>();
	submit(input: { kind: "image" | "video" | "tts" | "music"; outputName: string; adapterId?: string }, projectDir: string) {
		this.submitCalls += 1;
		this.adapterIds.push(input.adapterId);
		const id = `J${this.seq++}`;
		let videoSeq = 0;
		if (input.kind === "video") {
			this.videoSeq += 1;
			videoSeq = this.videoSeq;
		}
		const relative = path.posix.join("assets", `${input.outputName}.mp4`);
		if (input.kind === "video" && (this.failVideo || (this.failFirstVideo && videoSeq === 1))) {
			const job = { id, status: "failed" as const, filePath: undefined, relativePath: relative, attemptLog: [] as unknown[] };
			this.jobs.set(id, job);
			return job;
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

type JsonFixture = Record<string, unknown>;

const SHOT_FIXTURES: Record<string, JsonFixture> = {
	SH01: {
		id: "SH01",
		narrationZh: "凌晨一点，小林灌下最后一口冰爽。",
		narrationEn: "1 a.m., Lin downs the last icy sip.",
		visual: "小林在深夜办公室敲键盘，仰头喝一口气泡水",
		durationSec: 4,
	},
	SH02: {
		id: "SH02",
		narrationZh: "窗外的城市仍在降温。",
		narrationEn: "Outside, the city keeps cooling.",
		visual: "小林在冷色落地窗前转身",
		durationSec: 2,
	},
};

/** 本轮脚本的镜头清单（按用例拨动；默认两镜） */
let scriptShotIds = ["SH01", "SH02"];

function scriptFixture(): JsonFixture {
	return {
		title: "深夜气泡水",
		logline: "疲惫插画师靠一口冰爽回神",
		shots: scriptShotIds.map((id) => SHOT_FIXTURES[id]!),
	};
}

function llmStub(user: unknown): JsonFixture {
	const text = (typeof user === "string" ? user : JSON.stringify(user)).replace(/\\/g, "");
	if (text.includes("narrationZh")) return scriptFixture();
	return {};
}

function installMocks(): void {
	mock.module(new URL("../src/llm.ts", import.meta.url).href, {
		namedExports: {
			LlmError: class extends Error {},
			chat: async () => "ok",
			chatVisionJson: async () => ({}),
			chatJson: async (_llm: unknown, user: unknown) => llmStub(user),
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
			detectSpeechSegments: async (): Promise<{ start: number; end: number }[]> => [],
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

describe("B1 配额接线（stageClips 层）", () => {
	let pipeline: typeof import("../src/pipeline.ts");
	let clips: typeof import("../src/stages/clips.ts");
	let adapters: typeof import("../src/redo-adapters.ts");
	let root: string;

	before(async () => {
		installMocks();
		pipeline = await import("../src/pipeline.ts");
		clips = await import("../src/stages/clips.ts");
		adapters = await import("../src/redo-adapters.ts");
		root = await mkdtemp(path.join(tmpdir(), "pi-quota-wiring-"));
	});

	after(() => rm(root, { recursive: true, force: true }).catch(() => {}));

	function makeCtx(quota?: QuotaLedger): ServerContext {
		return {
			studioRoot: root,
			mediaConfig: { media: [] } as unknown as ServerContext["mediaConfig"],
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

	async function waitStable(record: import("../src/pipeline.ts").RunRecord, what: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			if (record.gate === "design" || record.status === "failed" || record.status === "done") return;
			if (Date.now() > deadline)
				throw new Error(`等待超时：${what}（当前 ${record.status} / ${record.gate ?? ""} / ${record.error ?? ""}）`);
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	/** startRun 推到 design 闸门停机，写入 clips 阶段所需的上游产物 */
	async function bootRun(ctx: ServerContext): Promise<import("../src/pipeline.ts").RunRecord> {
		const store = new pipeline.RunStore();
		const record = pipeline.startRun(ctx, store, { logline: "30 秒深夜办公室气泡水广告" });
		await waitStable(record, "boot run 应推进到美术设计闸门");
		assert.equal(record.status !== "failed", true, `boot 失败：${record.error ?? ""}`);
		await mkdir(record.dir, { recursive: true }); // run 目录由管线异步创建，写产物前先兜底
		const prompts = {
			prompts: [
				{ shotId: "SH01", prompt: "小林深夜办公室仰头喝气泡水，罐身冰珠反光" },
				{ shotId: "SH02", prompt: "小林在冷色落地窗前转身" },
			],
		};
		await writeFile(path.join(record.dir, "prompts.json"), JSON.stringify(prompts), "utf-8");
		// 关键帧置 done + 真实文件：跳过图片生成支路，直达视频提交
		const frames = ["SH01", "SH02"].map((shotId) => ({
			shotId,
			status: "done",
			attempts: 1,
			versions: [],
			file: `assets/key-${shotId}.png`,
		}));
		await writeFile(path.join(record.dir, "keyframes.json"), JSON.stringify({ frames }), "utf-8");
		await mkdir(path.join(record.dir, "assets"), { recursive: true });
		for (const shotId of ["SH01", "SH02"]) {
			await writeFile(path.join(record.dir, "assets", `key-${shotId}.png`), PNG_1PX);
		}
		return record;
	}

	function makeSc(record: import("../src/pipeline.ts").RunRecord, ctx: ServerContext, queue: FakeQueue) {
		return { run: record, ctx, queue, signal: record.abort.signal } as unknown as import("../src/pipeline.ts").StageCtx;
	}

	it("足额链路：提交前预留，出片后按实测时长结算（账实相符）", async () => {
		probeSec = 3.6;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const record = await bootRun(ctx);
		const queue = new FakeQueue();
		const result = await clips.stageClips(makeSc(record, ctx, queue));
		assert.equal(result.clipFiles.length, 2);
		assert.ok(result.clipFiles.every((f) => f !== null), "两镜都应出片");
		assert.equal(queue.submitCalls, 2, "i2v 一次成功，不应触发降级重试");
		// 结算按实测 3.6s 而非预估 5s：500 - 2×3.6
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 492.8) < 1e-6, `剩余应为 492.8，实际 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		const pool = quota.snapshot()[0]!;
		assert.equal(pool.inFlight, 0, "出片结算后不应有在途预留");
	});

	it("探测失败 → 按预估时长兜底结算（不得少结/漏结）", async () => {
		probeSec = null;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const record = await bootRun(ctx);
		const queue = new FakeQueue();
		await clips.stageClips(makeSc(record, ctx, queue));
		// probeDuration 返回 null → settle 用预估 5s：500 - 2×5
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 490) < 1e-6, `剩余应为 490，实际 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
	});

	it("配额不足 → 零派发（零违规锁）：一个请求都不进队列，预算告警留痕", async () => {
		probeSec = 3.6;
		const quota = makeLedger(2); // 预估 5s/镜，配额只剩 2s
		const ctx = makeCtx(quota);
		const record = await bootRun(ctx);
		const queue = new FakeQueue();
		await assert.rejects(() => clips.stageClips(makeSc(record, ctx, queue)), /配额不足/);
		assert.equal(queue.submitCalls, 0, "配额不足时不许任何请求进队列（宁停勿撞 429）");
		assert.ok(
			record.events.some((e) => e.text.includes("预算告警")),
			"必须留预算告警事件（上报人类 + 裁剪建议）",
		);
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 2) < 1e-6, "未派发则配额分毫不动");
	});

	it("生成失败 → 预留全额退还（无幻影消耗），i2v→t2v 降级各占一次预留", async () => {
		probeSec = 3.6;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const record = await bootRun(ctx);
		const queue = new FakeQueue();
		queue.failVideo = true;
		await assert.rejects(() => clips.stageClips(makeSc(record, ctx, queue)), /全部镜头生成失败/);
		// 每镜 i2v + t2v 两次提交（降级重试是新 attempt：新幂等键、新预留、旧预留已退还）
		assert.equal(queue.submitCalls, 4);
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 500) < 1e-6, `失败必须全额退还，实际剩 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0);
	});

	it("多 key 账实相符：两镜分投两池，各池按实测独立结算", async () => {
		probeSec = 3.6;
		const quota = new QuotaLedger([
			{ id: "agnes-video-1", keyType: "enterprise", rpmCap: 2, dailyQuotaSec: 500, adapterId: "agnes-video-1" },
			{ id: "agnes-video-2", keyType: "enterprise", rpmCap: 2, dailyQuotaSec: 500, adapterId: "agnes-video-2" },
		]);
		const ctx = makeCtx(quota);
		const record = await bootRun(ctx);
		const queue = new FakeQueue();
		const result = await clips.stageClips(makeSc(record, ctx, queue));
		assert.equal(result.clipFiles.length, 2);
		assert.ok(result.clipFiles.every((f) => f !== null), "两镜都应出片");
		assert.deepEqual(
			queue.adapterIds,
			["agnes-video-1", "agnes-video-2"],
			"两镜应分别投给两池绑定的 key（pickPool 分池 → 不同 key 并行）",
		);
		assert.ok(Math.abs(quota.remainingSec("agnes-video-1")! - 496.4) < 1e-6, `池1 应按实测结算剩 496.4，实际 ${quota.remainingSec("agnes-video-1")}`);
		assert.ok(Math.abs(quota.remainingSec("agnes-video-2")! - 496.4) < 1e-6, `池2 应按实测结算剩 496.4，实际 ${quota.remainingSec("agnes-video-2")}`);
		assert.deepEqual(
			quota.snapshot().map((p) => p.inFlight),
			[0, 0],
		);
	});

	it("降级重试换池：新预留落另一池 → 重试提交跟着换 key（不得沿用旧池 adapter）", async () => {
		probeSec = 3.6;
		const quota = new QuotaLedger([
			{ id: "agnes-video-1", keyType: "enterprise", rpmCap: 2, dailyQuotaSec: 500, adapterId: "agnes-video-1" },
			{ id: "agnes-video-2", keyType: "enterprise", rpmCap: 2, dailyQuotaSec: 500, adapterId: "agnes-video-2" },
		]);
		const ctx = makeCtx(quota);
		// 单镜（须在 bootRun 前拨动：script.json 由 bootRun 的脚本阶段生成）：
		// attempt0 只消耗池1 的令牌，重试 pickPool 必然换到池2（多镜时令牌占用对齐会让换池不确定）
		scriptShotIds = ["SH01"];
		const record = await bootRun(ctx);
		const queue = new FakeQueue();
		queue.failFirstVideo = true;
		try {
			await clips.stageClips(makeSc(record, ctx, queue));
		} finally {
			scriptShotIds = ["SH01", "SH02"];
		}
		assert.deepEqual(
			queue.adapterIds,
			["agnes-video-1", "agnes-video-2"],
			"重试的新预留落在另一池，提交必须跟着换 key（闭包捕获旧预留 = 账实不符）",
		);
		// 旧池预留已全额退还；新池按实测结算
		assert.ok(Math.abs(quota.remainingSec("agnes-video-1")! - 500) < 1e-6, `池1 应退还后剩 500，实际 ${quota.remainingSec("agnes-video-1")}`);
		assert.ok(Math.abs(quota.remainingSec("agnes-video-2")! - 496.4) < 1e-6, `池2 应按实测结算剩 496.4，实际 ${quota.remainingSec("agnes-video-2")}`);
	});

	it("多池预检：所有池都不够一镜 → 零派发，预算告警口径 = 各池剩余之和", async () => {
		probeSec = 3.6;
		const quota = new QuotaLedger([
			{ id: "agnes-video-1", keyType: "enterprise", rpmCap: 5, dailyQuotaSec: 2, adapterId: "agnes-video-1" },
			{ id: "agnes-video-2", keyType: "enterprise", rpmCap: 5, dailyQuotaSec: 2, adapterId: "agnes-video-2" },
		]);
		const ctx = makeCtx(quota);
		const record = await bootRun(ctx);
		const queue = new FakeQueue();
		await assert.rejects(() => clips.stageClips(makeSc(record, ctx, queue)), /配额不足/);
		assert.equal(queue.submitCalls, 0, "任一池都不够一镜时不许任何请求进队列（宁停勿撞 429）");
		const alert = record.events.find((e) => e.text.includes("预算告警"));
		assert.ok(alert, "必须留预算告警事件");
		assert.ok(alert!.text.includes("剩 4s"), `告警剩余应为两池之和 4s（此前硬编码单池会显示 0s），实际：${alert!.text}`);
	});

	it("RPM 暂缺 → 等令牌补充后重试成功（而不是立即失败）", async () => {
		// rpmCap 1200（20 令牌/秒）：抽干后 ~50ms 补一枚，等待回路可在秒级内验证
		const quota = new QuotaLedger([{ id: VIDEO_QUOTA_POOL, keyType: "free", rpmCap: 1200, dailyQuotaSec: null }]);
		for (let k = 0; k < 1200; k += 1) {
			assert.equal(quota.reserve(VIDEO_QUOTA_POOL, 0.001, { idempotencyKey: `drain-${k}` }).ok, true);
		}
		const sc = { run: { id: "r-test" }, ctx: { quota }, signal: new AbortController().signal } as unknown as import(
			"../src/pipeline.ts"
		).StageCtx;
		const t0 = Date.now();
		const r = await clips.reserveShotQuota(sc, "SH01", 5, 0);
		const elapsed = Date.now() - t0;
		assert.ok(r?.ok, `等令牌补充后应预留成功，实际 ${JSON.stringify(r)}`);
		assert.ok(elapsed < 5_000, `等待应远小于 1 分钟（实际 ${elapsed}ms）——令牌按速率补充而非整分钟阻塞`);
	});

	it("estimateClipSeconds 与 videoSubmitParams 的实际请求秒数一致", () => {
		const opts = { clipDurationSec: 3 } as import("../../video-agent/src/index.ts").GenerationOptions;
		const ctx25 = { mediaConfig: { media: [{ id: "v", kind: "video", model: "agnes-video-2.5-flash" }] } } as unknown as ServerContext;
		const ctx20 = { mediaConfig: { media: [{ id: "v", kind: "video", model: "agnes-video-v2.0" }] } } as unknown as ServerContext;
		assert.equal(adapters.estimateClipSeconds(ctx25, opts), 4, "2.5 系列不足 4s 也按 4s 生成");
		assert.equal(adapters.estimateClipSeconds(ctx25, { clipDurationSec: 10 } as never), 10);
		assert.equal(adapters.estimateClipSeconds(ctx20, opts), 3, "2.0 系列按原值透传");
	});
});
