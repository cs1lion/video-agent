/**
 * A5 台词镜级联重做 —— rettsRun 台词分支（mock 队列/ffmpeg/托管，无真实网络）。
 *
 * 台词是口型驱动源：重录台词必须级联重生成口型视频。锁六条行为：
 * 1. 全链就绪：指令解析(voice-only)→台词音频链(TTS→实测→停顿→托管)→A4b 反推镜长
 *    →reference 重生成（audios + <Audio 1>）→片段版本化备份→配额结算→export；
 * 2. 托管失败 → 降旁白（台词回填旁白字段），视频按普通 i2v 路径重生成；
 * 3. TTS 失败 → 级联中止：旧片段/脚本/配额原封不动；
 * 4. audioDrive 未开 → 同步 bail（不进入运行态）；
 * 5. reference 失败 → 降级普通图生视频（新 attempt 新预留），台词转旁白；
 * 6. 配额不足 → 口型重生成预留失败：旧片段不动、脚本回写回滚、报错明确。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { RunRecord } from "../src/pipeline.ts";
import type { ServerContext } from "../src/config.ts";
import { VIDEO_QUOTA_POOL } from "../src/config.ts";
import { QuotaLedger } from "../src/quota.ts";
import type { ScriptDoc } from "../src/prompts.ts";

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

// ---- 场景拨杆（用例间重置）----
let probeSeq: (number | null)[] = [4.2, 5.0];
let hostShouldFail = false;
let failTts = false;
let failReferenceOnly = false;
let failVideoAll = false;
/** 队列提交记录（kind/prompt/params 按序追加） */
let submits: { kind: string; prompt: string; params: Record<string, unknown> }[] = [];

class FakeQueue {
	private seq = 0;
	private readonly jobs = new Map<string, unknown>();
	private videoSeq = 0;
	private ttsSeq = 0;
	submit(input: { kind: string; prompt: string; params: Record<string, unknown>; outputName: string }, projectDir: string) {
		const id = `J${this.seq++}`;
		submits.push({ kind: input.kind, prompt: input.prompt, params: input.params });
		const ext = input.kind === "video" ? ".mp4" : ".mp3";
		const relative = path.posix.join("assets", `${input.outputName}${ext}`);
		let status: "done" | "failed" = "done";
		if (input.kind === "tts") {
			this.ttsSeq += 1;
			if (failTts) status = "failed";
		}
		if (input.kind === "video") {
			this.videoSeq += 1;
			if (failVideoAll || (failReferenceOnly && this.videoSeq === 1)) status = "failed";
		}
		const absolute = path.join(projectDir, relative);
		const job = { id, status, filePath: status === "done" ? absolute : undefined, relativePath: relative, attemptLog: [] };
		this.jobs.set(id, job);
		if (status === "done") {
			// 同步写：下游 mock copyFile/probe 依赖文件存在（异步写有微任务竞态）
			mkdirSync(path.dirname(absolute), { recursive: true });
			writeFileSync(absolute, Buffer.from([0x00, 0x01]));
		}
		return job;
	}
	async awaitJob<T>(jobId: string): Promise<T> {
		return this.jobs.get(jobId) as T;
	}
	stats() {
		return { retries: 0, adapters: {} as Record<string, { done: number }> };
	}
}

function installMocks(): void {
	mock.module(new URL("../src/llm.ts", import.meta.url).href, {
		namedExports: {
			LlmError: class extends Error {},
			chat: async () => "ok",
			chatVisionJson: async () => ({}),
			chatJson: async (_llm: unknown, _prompt: string) => {
				// 台词重录指令解析：voice-only（台词逐字保留 + 表演指导）
				return { mode: "voice-only", linesZh: "你好，世界。", linesEn: "Hello, world.", instruction: "更有活力一点" };
			},
			tryParseJson: <T>(raw: string) => JSON.parse(raw) as T,
		},
	});
	mock.module(new URL("../../coding-agent/examples/extensions/studio/media/queue.ts", import.meta.url).href, {
		namedExports: { GenerationQueue: FakeQueue },
	});
	mock.module(new URL("../src/qa/asr-check.ts", import.meta.url).href, {
		namedExports: {
			ASR_OVERLAP_THRESHOLD: 0.5,
			referenceIntelligible: async (): Promise<{ intelligible: boolean; overlap: number; transcribed: string }> => ({
				intelligible: true,
				overlap: 0.9,
				transcribed: "mock 台词",
			}),
		},
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
			probeDuration: async (): Promise<number | null> =>
				probeSeq.length > 1 ? (probeSeq.shift() as number | null) : probeSeq[0]!,
			runFfmpeg: async (): Promise<string> => "",
			runFfmpegCapture: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: "", stderr: "" }),
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
			insertPauses: async (o: { cwd: string; inPath: string; outPath: string }) => {
				const { copyFile } = await import("node:fs/promises");
				await copyFile(path.join(o.cwd, o.inPath), path.join(o.cwd, o.outPath));
			},
			padTailToSec: async (): Promise<"padded" | "skipped"> => "skipped",
		},
	});
	mock.module(new URL("../src/hosting/tcb.ts", import.meta.url).href, {
		namedExports: {
			HostingError: class extends Error {},
			hostAudioFile: async (_studioRoot: string, runId: string, shotId: string): Promise<string> => {
				if (hostShouldFail) throw new Error("未配置 CloudBase 托管（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY）");
				return `https://test-env.tcb.qcloud.la/video-agent/${runId}/tts-${shotId}.mp3`;
			},
			isAudioUrlAlive: async (): Promise<boolean> => false,
		},
	});
}

describe("A5 台词镜级联重做（rettsRun 台词分支）", () => {
	let retts: typeof import("../src/redo/retts.ts");
	let root: string;

	before(async () => {
		installMocks();
		retts = await import("../src/redo/retts.ts");
		root = await mkdtemp(path.join(tmpdir(), "pi-retts-dialogue-"));
	});

	after(async () => {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	function reset(): void {
		probeSeq = [4.2, 5.0];
		hostShouldFail = false;
		failTts = false;
		failReferenceOnly = false;
		failVideoAll = false;
		submits = [];
	}

	function makeCtx(quota?: QuotaLedger): ServerContext {
		return {
			studioRoot: root,
			mediaConfig: {
				media: [
					{ id: "agnes-video", kind: "video", model: "agnes-video-2.5-flash" },
					{ id: "step-tts", kind: "tts", model: "stepaudio-2.5-tts", voice: "default-voice" },
				],
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
		} as unknown as ServerContext;
	}

	function makeLedger(dailyQuotaSec: number): QuotaLedger {
		return new QuotaLedger([{ id: VIDEO_QUOTA_POOL, keyType: "tokenplan", rpmCap: 100, dailyQuotaSec }]);
	}

	const DIALOGUE_SHOT = {
		id: "SH01",
		narrationZh: "",
		narrationEn: "",
		visual: "一个镜头",
		durationSec: 5,
		audioMode: "dialogue" as const,
		dialogue: {
			characterId: "小明",
			voiceId: "v_test",
			lines: { zh: "你好，世界。", en: "Hello, world." },
			emotion: "兴奋",
			pausesSec: [0.5],
		},
	};

	async function freshRun(audioDrive: "off" | "dialogue" = "dialogue"): Promise<{ run: RunRecord; dir: string }> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-retts-dialogue-"));
		await mkdir(path.join(dir, "assets"), { recursive: true });
		const script: ScriptDoc = {
			title: "测试片",
			logline: "测试用",
			shots: [{ ...DIALOGUE_SHOT }] as ScriptDoc["shots"],
		};
		await writeFile(path.join(dir, "script.json"), JSON.stringify(script), "utf-8");
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
		// 旧片段（台词重生成必须版本化备份它）
		await writeFile(path.join(dir, "assets", "clip-SH01.mp4"), "old-clip-bytes", "utf-8");

		const run = {
			id: "run-retts-dialogue-test",
			dir,
			status: "done",
			brief: {
				creative: { logline: "测试用", keyMessage: "" },
				language: "zh",
				generationOptions: {
					resolution: "720p",
					aspectRatio: "16:9",
					shotCount: 5,
					clipDurationSec: 5,
					fps: 24,
					motionIntensity: "medium",
					detailBoost: true,
					promptLanguage: "zh",
					negativePrompt: "",
					audioDrive,
				},
			},
			stages: [
				{ id: "script", status: "done", progress: 1 },
				{ id: "visual", status: "done", progress: 1 },
				{ id: "prompts", status: "done", progress: 1 },
				{ id: "keyframes", status: "done", progress: 1 },
				{ id: "clips", status: "done", progress: 1 },
				{ id: "audio", status: "done", progress: 1 },
				{ id: "export", status: "done", progress: 1 },
			],
			metrics: { mediaCalls: 0, llmCalls: 0, llmTokensIn: 0, llmTokensOut: 0, usd: 0 },
			events: [],
			images: [],
			shotAttempts: {},
			shotVersions: {},
			ttsAttempts: {},
			ttsVersions: {},
			lastActions: [],
			redoActive: null,
			abort: new AbortController(),
			verdict: undefined,
			videoUrl: undefined,
		} as unknown as RunRecord;
		return { run, dir };
	}

	/** rettsRun 是 fire-and-forget：轮询 redoActive 被清空且状态离开 running 判断异步 IIFE 结束 */
	async function waitForCompletion(run: RunRecord): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (run.redoActive === null && run.status !== "running") return;
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.fail("rettsRun 10s 内未结束");
	}

	it("全链就绪：台词音频链 → A4b 反推 → reference 重生成 → 版本化备份 → 配额结算 → lastActions", async () => {
		reset();
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run, dir } = await freshRun();
		const r = await retts.rettsRun(ctx, run, "SH01", "更有活力一点");
		assert.equal(r.ok, true, r.error);
		await waitForCompletion(run);

		// 提交序列：1 次 TTS + 1 次 reference 视频（含 <Audio 1> 占位符）
		assert.equal(submits.filter((s) => s.kind === "tts").length, 1);
		const video = submits.filter((s) => s.kind === "video");
		assert.equal(video.length, 1);
		assert.ok(video[0]!.prompt.includes("<Audio 1>"), "reference 模式 prompt 必须含占位符");
		assert.deepEqual(video[0]!.params, {
			seconds: "5",
			mode: "reference",
			audios: ["https://test-env.tcb.qcloud.la/video-agent/run-retts-dialogue-test/tts-SH01.mp3"],
		});
		// 台词回写落盘
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.dialogue!.audioUrl, "https://test-env.tcb.qcloud.la/video-agent/run-retts-dialogue-test/tts-SH01.mp3");
		// 旧片段版本化备份 + 新片段就位
		assert.deepEqual(run.shotVersions.SH01, ["assets/clip-SH01_v1.mp4"]);
		await readFile(path.join(dir, "assets", "clip-SH01_v1.mp4"), "utf-8"); // 备份存在
		// 动作账本（D3）
		assert.equal(run.lastActions[0]!.kind, "retts");
		assert.ok(run.lastActions[0]!.label.includes("台词"));
		// 配额：预留 round(5)=5，实测结算 5.0 → 500 - 5.0
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 495) < 1e-6, `剩余 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0);
		assert.equal(run.status, "done");
	});

	it("托管失败 → 降旁白，视频按普通 i2v 重生成（不赌 reference）", async () => {
		reset();
		hostShouldFail = true;
		const ctx = makeCtx();
		const { run, dir } = await freshRun();
		const r = await retts.rettsRun(ctx, run, "SH01", "更有活力一点");
		assert.equal(r.ok, true, r.error);
		await waitForCompletion(run);

		const video = submits.filter((s) => s.kind === "video");
		assert.equal(video.length, 1);
		assert.equal((video[0]!.params as { mode?: string }).mode, "keyframe", "普通 i2v（关键帧锚定）");
		assert.ok(!("audios" in video[0]!.params), "降级路径不得带 audios");
		assert.ok(!video[0]!.prompt.includes("<Audio 1>"), "占位符必须随 reference 一起移除");
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.audioMode, "narration", "降旁白落盘");
		assert.equal(onDisk.shots[0]!.narrationZh, "你好，世界。", "台词回填旁白字段");
		assert.equal(run.status, "done");
	});

	it("TTS 失败 → 级联中止：旧片段/脚本/配额原封不动", async () => {
		reset();
		failTts = true;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run, dir } = await freshRun();
		const r = await retts.rettsRun(ctx, run, "SH01", "更有活力一点");
		assert.equal(r.ok, true, r.error);
		await waitForCompletion(run);

		assert.equal(run.status, "failed");
		assert.ok((run.error ?? "").includes("TTS"), `error 应说明 TTS 失败，实际：${run.error}`);
		const clip = await readFile(path.join(dir, "assets", "clip-SH01.mp4"), "utf-8");
		assert.equal(clip, "old-clip-bytes", "旧片段未被改动");
		assert.deepEqual(run.shotVersions.SH01 ?? [], [], "未创建版本备份（音频链先于备份失败）");
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.audioMode, "dialogue", "脚本未被降级改写");
		assert.equal(onDisk.shots[0]!.dialogue!.audioUrl, undefined, "audioUrl 未被回写");
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 500) < 1e-6, "配额未消耗");
	});

	it("audioDrive 未开 → 同步 bail（不进入运行态）", async () => {
		reset();
		const ctx = makeCtx();
		const { run } = await freshRun("off");
		const r = await retts.rettsRun(ctx, run, "SH01", "更有活力一点");
		assert.equal(r.ok, false);
		assert.ok((r.error ?? "").includes("台词镜"));
		assert.equal(run.status, "done", "运行态恢复");
		assert.equal(submits.length, 0, "未发起任何生成");
	});

	it("reference 失败 → 降级普通图生视频（新 attempt 新预留），台词转旁白", async () => {
		reset();
		failReferenceOnly = true;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run, dir } = await freshRun();
		const r = await retts.rettsRun(ctx, run, "SH01", "更有活力一点");
		assert.equal(r.ok, true, r.error);
		await waitForCompletion(run);

		const video = submits.filter((s) => s.kind === "video");
		assert.equal(video.length, 2, "reference 失败后降级重试");
		assert.equal((video[0]!.params as { mode?: string }).mode, "reference");
		assert.equal((video[1]!.params as { mode?: string }).mode, "keyframe");
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.audioMode, "narration");
		assert.equal(run.status, "done");
		// 账实相符：a0 预留 5 退还，a1 预留 5 按实测 5.0 结算 → 500 - 5.0
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 495) < 1e-6, `剩余 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0);
	});

	it("旁白镜冒烟：TTS 版本化备份 + lastActions 旁白标签（抽取后的既有路径回归锁）", async () => {
		reset();
		const ctx = makeCtx();
		const { run, dir } = await freshRun();
		// 改为旁白镜（重录走既有 narration 路径）
		const script: ScriptDoc = {
			title: "测试片",
			logline: "测试用",
			shots: [
				{
					id: "SH01",
					narrationZh: "旁白文案",
					narrationEn: "narration",
					visual: "一个镜头",
					durationSec: 5,
					audioMode: "narration" as const,
				} as ScriptDoc["shots"][number],
			],
		};
		await writeFile(path.join(dir, "script.json"), JSON.stringify(script), "utf-8");
		await writeFile(path.join(dir, "assets", "tts-SH01.mp3"), "old-tts-bytes", "utf-8");
		const r = await retts.rettsRun(ctx, run, "SH01", "更有活力一点");
		assert.equal(r.ok, true, r.error);
		await waitForCompletion(run);

		assert.equal(submits.filter((s) => s.kind === "tts").length, 1, "恰好一次 TTS");
		assert.equal(submits.filter((s) => s.kind === "video").length, 0, "旁白重录不重生成视频（级联只属于台词镜）");
		assert.deepEqual(run.ttsVersions.SH01, ["assets/tts-SH01_v1.mp3"], "旧 TTS 版本化备份");
		assert.equal(run.lastActions[0]!.kind, "retts");
		assert.ok(run.lastActions[0]!.label.includes("旁白"));
		assert.equal(run.status, "done");
	});

	it("配额不足 → 口型重生成预留失败：旧片段不动、脚本回写回滚、报错明确", async () => {		reset();
		const quota = makeLedger(3); // < 预估 5s
		const ctx = makeCtx(quota);
		const { run, dir } = await freshRun();
		const r = await retts.rettsRun(ctx, run, "SH01", "更有活力一点");
		assert.equal(r.ok, true, r.error);
		await waitForCompletion(run);

		assert.equal(run.status, "failed");
		assert.ok((run.error ?? "").includes("配额不足"), `error 应说明配额不足，实际：${run.error}`);
		const clip = await readFile(path.join(dir, "assets", "clip-SH01.mp4"), "utf-8");
		assert.equal(clip, "old-clip-bytes", "旧片段未被改动");
		// 台词回写已回滚（新音频已花成本，但脚本与旧片段保持一致）
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.audioMode, "dialogue");
		assert.equal(onDisk.shots[0]!.dialogue!.audioUrl, undefined);
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 3) < 1e-6, "配额未消耗");
	});
});
