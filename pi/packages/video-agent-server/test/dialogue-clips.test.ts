/**
 * A2 台词链路行为测试 —— stageClips 台词分支（mock 队列/ffmpeg/托管，无真实网络）。
 *
 * 锁六条行为：
 * 1. 全链就绪：TTS(角色音色)→实测→停顿→托管→reference 提交（audios + <Audio 1> 占位符）；
 * 2. TTS 失败 → 该镜降 silent，视频照常（不阻断）；
 * 3. 托管失败 → 该镜降 narration（台词回填旁白字段），视频照常；
 * 4. reference 提交失败 → 降级普通图生视频（新 attempt 新预留，配额账实相符）；
 * 5. audioUrl 复用：已有托管 URL 存活 → 零 TTS、零重传；
 * 6. audioDrive 未开但镜头声明 dialogue → 防御性降旁白（不留给 export 响亮失败）。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { ServerContext } from "../src/config.ts";
import { VIDEO_QUOTA_POOL } from "../src/config.ts";
import { QuotaLedger } from "../src/quota.ts";
import type { RunRecord, StageCtx } from "../src/pipeline.ts";
import type { ScriptDoc } from "../src/prompts.ts";

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

// ---- 场景拨杆（用例间重置）----
let probeSeq: (number | null)[] = [4.2];
let hostCalls = 0;
let hostShouldFail = false;
let urlAlive = false;
let insertPauseCalls: { inPath: string; outPath: string; pausesSec: number[] }[] = [];
let padCalls: { inPath: string; outPath: string; targetSec: number; inputSec: number }[] = [];
let padResult: "padded" | "skipped" = "skipped";
let condenseReply: unknown = { zh: "短句", en: "Short." };
let failTts = false;
let failTtsSecondOnly = false;
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
			if (failTts || (failTtsSecondOnly && this.ttsSeq === 2)) status = "failed";
		}
		if (input.kind === "video") {
			this.videoSeq += 1;
			if (failVideoAll || (failReferenceOnly && this.videoSeq === 1)) status = "failed";
		}
		const absolute = path.join(projectDir, relative);
		const job = { id, status, filePath: status === "done" ? absolute : undefined, relativePath: relative, attemptLog: [] };
		this.jobs.set(id, job);
		if (status === "done") {
			// 同步写：下游 mock 的 copyFile/probe 依赖文件存在（异步写有微任务竞态）
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
				if (condenseReply === null) throw new Error("llm unavailable");
				return condenseReply;
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
			probeDuration: async (): Promise<number | null> => (probeSeq.length > 1 ? (probeSeq.shift() as number | null) : probeSeq[0]!),
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
			insertPauses: async (o: { cwd: string; inPath: string; outPath: string; pausesSec: number[] }) => {
				insertPauseCalls.push({ inPath: o.inPath, outPath: o.outPath, pausesSec: [...o.pausesSec] });
				await mkdir(path.dirname(path.join(o.cwd, o.outPath)), { recursive: true });
				await fsCopy(o.cwd, o.inPath, o.outPath);
			},
			padTailToSec: async (o: { cwd: string; inPath: string; outPath: string; targetSec: number; inputSec: number }) => {
				padCalls.push({ inPath: o.inPath, outPath: o.outPath, targetSec: o.targetSec, inputSec: o.inputSec });
				if (padResult === "skipped") return "skipped" as const;
				await mkdir(path.dirname(path.join(o.cwd, o.outPath)), { recursive: true });
				await fsCopy(o.cwd, o.inPath, o.outPath);
				return "padded" as const;
			},
		},
	});
	mock.module(new URL("../src/hosting/tcb.ts", import.meta.url).href, {
		namedExports: {
			HostingError: class extends Error {},
			hostAudioFile: async (_studioRoot: string, runId: string, shotId: string): Promise<string> => {
				hostCalls += 1;
				if (hostShouldFail) throw new Error("未配置 CloudBase 托管（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY）");
				return `https://test-env.tcb.qcloud.la/video-agent/${runId}/tts-${shotId}.mp3`;
			},
			isAudioUrlAlive: async (): Promise<boolean> => urlAlive,
		},
	});
}

async function fsCopy(cwd: string, from: string, to: string): Promise<void> {
	const { copyFile } = await import("node:fs/promises");
	await copyFile(path.join(cwd, from), path.join(cwd, to));
}

describe("A2 台词链路（stageClips 台词分支）", () => {
	let clips: typeof import("../src/stages/clips.ts");

	before(async () => {
		installMocks();
		clips = await import("../src/stages/clips.ts");
	});

	after(async () => {
		// 临时目录由各用例自清理（mkdtemp 于 try/finally），此处兜底空实现保持钩子稳定
	});

	function reset(): void {
		probeSeq = [4.2];
		hostCalls = 0;
		hostShouldFail = false;
		urlAlive = false;
		insertPauseCalls = [];
		padCalls = [];
		padResult = "skipped";
		condenseReply = { zh: "短句", en: "Short." };
		failTts = false;
		failTtsSecondOnly = false;
		failReferenceOnly = false;
		failVideoAll = false;
		submits = [];
	}

	function makeCtx(quota?: QuotaLedger): ServerContext {
		return {
			studioRoot: "C:\\nonexistent-studio",
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

	async function freshRun(shotOverrides: Record<string, unknown> = {}): Promise<{ run: RunRecord; script: ScriptDoc; dir: string }> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-dialogue-clips-"));
		await mkdir(path.join(dir, "assets"), { recursive: true });
		const shot = { ...DIALOGUE_SHOT, ...shotOverrides };
		const script: ScriptDoc = { title: "测试片", logline: "测试用", shots: [shot] as ScriptDoc["shots"] };
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
		const run = {
			id: "run-dialogue-test",
			dir,
			status: "running",
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
					audioDrive: "dialogue",
				},
			},
			stages: ["script", "visual", "prompts", "keyframes", "clips", "audio", "export"].map((id) => ({
				id,
				status: id === "clips" ? "running" : "pending",
				progress: 0,
			})),
			metrics: { mediaCalls: 0, llmCalls: 0, llmTokensIn: 0, llmTokensOut: 0, usd: 0 },
			events: [],
			images: [],
			shotAttempts: {},
			shotVersions: {},
			lastActions: [],
			redoActive: null,
			abort: new AbortController(),
		} as unknown as RunRecord;
		return { run, script, dir };
	}

	async function runClips(ctx: ServerContext, run: RunRecord, script: ScriptDoc): Promise<{ clipFiles: (string | null)[]; script: ScriptDoc }> {
		const sc: StageCtx = { run, ctx, queue: new FakeQueue() as unknown as StageCtx["queue"], signal: run.abort.signal };
		return clips.stageClips(sc, script);
	}

	it("全链就绪：TTS(角色音色)→实测→停顿→托管→reference 提交（audios + <Audio 1>），dialogue 回写落盘", async () => {
		reset();
		const ctx = makeCtx();
		const { run, script, dir } = await freshRun();
		const result = await runClips(ctx, run, script);
		// 队列：1 次 TTS + 1 次视频（reference）
		assert.equal(submits.length, 2, `应恰好 1 TTS + 1 video，实际 ${JSON.stringify(submits.map((s) => s.kind))}`);
		assert.equal(submits[0]!.kind, "tts");
		assert.equal(submits[0]!.prompt, "你好，世界。");
		assert.deepEqual(submits[0]!.params, { instruction: "兴奋", voice: "v_test" });
		assert.equal(submits[1]!.kind, "video");
		assert.deepEqual(submits[1]!.params, { seconds: "5", mode: "reference", audios: ["https://test-env.tcb.qcloud.la/video-agent/run-dialogue-test/tts-SH01.mp3"] });
		assert.ok(submits[1]!.prompt.includes("<Audio 1>"), "reference 模式 prompt 必须含 <Audio 1> 占位符");
		// 停顿插入：1 次，pausesSec [0.5]
		assert.equal(insertPauseCalls.length, 1);
		assert.deepEqual(insertPauseCalls[0]!.pausesSec, [0.5]);
		// 托管：1 次
		assert.equal(hostCalls, 1);
		// 回写：audioUrl + audioDurationSec（probe 4.2）
		assert.equal(result.script.shots[0]!.dialogue!.audioUrl, "https://test-env.tcb.qcloud.la/video-agent/run-dialogue-test/tts-SH01.mp3");
		assert.ok(Math.abs(result.script.shots[0]!.dialogue!.audioDurationSec! - 4.2) < 1e-6);
		// 落盘：script.json 读回一致
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.dialogue!.audioUrl, result.script.shots[0]!.dialogue!.audioUrl);
		// 出片成功
		assert.ok(result.clipFiles[0], "台词镜应正常出片");
		// 就绪事件留痕
		assert.ok(run.events.some((e) => e.text.includes("台词音频就绪")));
	});

	it("TTS 失败 → 该镜降 silent，视频照常（不阻断、不托管）", async () => {
		reset();
		failTts = true;
		const ctx = makeCtx();
		const { run, script, dir } = await freshRun();
		const result = await runClips(ctx, run, script);
		assert.equal(submits.filter((s) => s.kind === "tts").length, 1);
		assert.equal(hostCalls, 0, "TTS 失败不得触发托管");
		const video = submits.find((s) => s.kind === "video")!;
		assert.equal((video.params as { mode: string }).mode, "keyframe", "降级后走普通图生视频");
		assert.ok(!video.prompt.includes("<Audio 1>"), "非 reference 提交不得携带占位符");
		assert.equal(result.script.shots[0]!.audioMode, "silent");
		assert.ok(result.clipFiles[0], "降级镜仍应出片");
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.audioMode, "silent", "降级须落盘（export 依赖 audioMode）");
		assert.ok(run.events.some((e) => e.text.includes("降级为无声画面")));
	});

	it("托管失败 → 该镜降 narration（台词回填旁白字段），视频照常", async () => {
		reset();
		hostShouldFail = true;
		const ctx = makeCtx();
		const { run, script, dir } = await freshRun();
		const result = await runClips(ctx, run, script);
		assert.equal(hostCalls, 1);
		assert.equal(result.script.shots[0]!.audioMode, "narration");
		assert.equal(result.script.shots[0]!.narrationZh, "你好，世界。", "台词必须回填旁白字段，audio 阶段才能当旁白念出");
		const video = submits.find((s) => s.kind === "video")!;
		assert.equal((video.params as { mode: string }).mode, "keyframe");
		assert.ok(result.clipFiles[0]);
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.audioMode, "narration");
		assert.equal(onDisk.shots[0]!.narrationZh, "你好，世界。");
	});

	it("reference 提交失败 → 降级普通图生视频（新 attempt 新预留），配额账实相符", async () => {
		reset();
		failReferenceOnly = true;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run, script } = await freshRun();
		const result = await runClips(ctx, run, script);
		const videoSubmits = submits.filter((s) => s.kind === "video");
		assert.equal(videoSubmits.length, 2, "reference 失败后应有一次普通重试");
		assert.equal((videoSubmits[0]!.params as { mode: string }).mode, "reference");
		assert.equal((videoSubmits[1]!.params as { mode: string }).mode, "keyframe");
		assert.ok(!videoSubmits[1]!.prompt.includes("<Audio 1>"));
		assert.equal(result.script.shots[0]!.audioMode, "narration", "reference 失败 → 台词转旁白");
		assert.ok(result.clipFiles[0], "降级重试应出片");
		// 配额：reference(a0) 释放 + i2v(a1) 按实测 4.2s 结算 → 500 - 4.2
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 495.8) < 1e-6, `剩余应为 495.8，实际 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0);
		// metrics：1 TTS + 2 video
		assert.equal(run.metrics.mediaCalls, 3);
	});

	it("audioUrl 复用：已有托管 URL 存活 → 零 TTS、零重传，直接 reference 提交", async () => {
		reset();
		urlAlive = true;
		const presetUrl = "https://test-env.tcb.qcloud.la/video-agent/run-old/tts-SH01.mp3";
		const ctx = makeCtx();
		const { run, script } = await freshRun({
			dialogue: { characterId: "小明", voiceId: "v_test", lines: { zh: "你好，世界。", en: "Hello." }, audioUrl: presetUrl },
		});
		const result = await runClips(ctx, run, script);
		assert.equal(submits.filter((s) => s.kind === "tts").length, 0, "URL 存活时不得重做 TTS");
		assert.equal(hostCalls, 0, "URL 存活时不得重传");
		const video = submits.find((s) => s.kind === "video")!;
		assert.deepEqual(video.params, { seconds: "5", mode: "reference", audios: [presetUrl] });
		assert.equal(result.script.shots[0]!.audioMode, "dialogue");
		assert.ok(result.clipFiles[0]);
	});

	it("audioDrive 未开但镜头声明 dialogue → 防御性降旁白（不留给 export 响亮失败）", async () => {
		reset();
		const ctx = makeCtx();
		const { run, script, dir } = await freshRun();
		(run.brief as { generationOptions: Record<string, unknown> }).generationOptions.audioDrive = "off";
		const result = await runClips(ctx, run, script);
		assert.equal(submits.filter((s) => s.kind === "tts").length, 0, "未开音频驱动不得触发 TTS");
		assert.equal(hostCalls, 0);
		assert.equal(result.script.shots[0]!.audioMode, "narration");
		assert.equal(result.script.shots[0]!.narrationZh, "你好，世界。");
		const video = submits.find((s) => s.kind === "video")!;
		assert.equal((video.params as { mode: string }).mode, "keyframe");
		const onDisk = JSON.parse(await readFile(path.join(dir, "script.json"), "utf-8")) as ScriptDoc;
		assert.equal(onDisk.shots[0]!.audioMode, "narration");
		assert.ok(run.events.some((e) => e.text.includes("未开启音频驱动")));
	});

	it("全失败退还：视频全失败 → 台词镜走完整降级链，stageClips 抛错且配额全额退还", async () => {
		reset();
		failVideoAll = true;
		const quota = makeLedger(500);
		const ctx = makeCtx(quota);
		const { run, script } = await freshRun();
		// 全失败时 stageClips 按既有契约抛错（零出片不静默）；退还发生在抛错前的循环内
		await assert.rejects(runClips(ctx, run, script), /全部镜头生成失败/);
		// reference → i2v → t2v 三级尝试全失败
		const videoSubmits = submits.filter((s) => s.kind === "video");
		assert.equal(videoSubmits.length, 3, "三级降级链：reference→i2v→t2v");
		assert.ok(Math.abs(quota.remainingSec(VIDEO_QUOTA_POOL)! - 500) < 1e-6, `全失败必须全额退还，实际 ${quota.remainingSec(VIDEO_QUOTA_POOL)}`);
		assert.equal(quota.snapshot()[0]!.inFlight, 0);
		// metrics：1 TTS + 3 video
		assert.equal(run.metrics.mediaCalls, 4);
	});

	it("A4 超长对齐：台词实测超镜长 → LLM 精简重录（第二次 TTS 用精简文本，配额计 2 次 TTS）", async () => {
		reset();
		probeSeq = [6.5, 7.0, 4.4, 4.97]; // 首版 TTS 6.5 → 插停顿 7.0（> 5.2 触发精简）→ 重录 4.4 → 插停顿 4.97
		const ctx = makeCtx();
		const { run, script } = await freshRun();
		const result = await runClips(ctx, run, script);
		const ttsSubmits = submits.filter((s) => s.kind === "tts");
		assert.equal(ttsSubmits.length, 2, "首版 + 精简重录各一次 TTS");
		assert.equal(ttsSubmits[0]!.prompt, "你好，世界。");
		assert.equal(ttsSubmits[1]!.prompt, "短句", "第二次 TTS 必须用精简后的文本");
		assert.deepEqual(ttsSubmits[1]!.params, { instruction: "兴奋", voice: "v_test" }, "重录保持同一音色与指导（跨镜一致性）");
		const video = submits.find((s) => s.kind === "video")!;
		assert.deepEqual((video.params as { audios: string[] }).audios.length, 1, "精简重录后仍走 reference");
		assert.equal(result.script.shots[0]!.audioMode, "dialogue");
		assert.ok(Math.abs(result.script.shots[0]!.dialogue!.audioDurationSec! - 4.97) < 1e-6);
		assert.equal(run.metrics.mediaCalls, 3, "2 TTS + 1 video");
		assert.ok(run.events.some((e) => e.text.includes("已 LLM 精简重录")));
		assert.equal(insertPauseCalls.length, 2, "两次合成各自走停顿插入");
	});

	it("A4 过短对齐：台词短于镜长 → 尾部补静音到镜长，最终时长落盘", async () => {
		reset();
		probeSeq = [4.0, 4.5, 5.0]; // TTS 4.0 → 插停顿 4.5 → 补静音后 5.0
		padResult = "padded";
		const ctx = makeCtx();
		const { run, script } = await freshRun();
		const result = await runClips(ctx, run, script);
		assert.equal(padCalls.length, 1, "恰好一次尾部补静音");
		assert.ok(Math.abs(padCalls[0]!.targetSec - 5) < 1e-6);
		assert.ok(Math.abs(padCalls[0]!.inputSec - 4.5) < 1e-6, "补静音输入是插停顿后的实测时长");
		assert.ok(padCalls[0]!.outPath.endsWith("tts-dialogue-SH01-pad.mp3"));
		assert.equal(result.script.shots[0]!.audioMode, "dialogue");
		assert.ok(Math.abs(result.script.shots[0]!.dialogue!.audioDurationSec! - 5) < 1e-6, "回写补齐后的时长（export 节奏锚点用）");
		assert.ok(run.events.some((e) => e.text.includes("尾部补静音")));
		assert.equal(submits.filter((s) => s.kind === "tts").length, 1, "过短不需要重录");
	});

	it("A4 超长且精简不可用（LLM 失败）→ 接受原时长并留痕，链路不阻断", async () => {
		reset();
		condenseReply = null; // chatJson 抛错 → condenseLine 返回 null
		probeSeq = [6.5, 7.0];
		const ctx = makeCtx();
		const { run, script } = await freshRun();
		const result = await runClips(ctx, run, script);
		assert.equal(submits.filter((s) => s.kind === "tts").length, 1, "精简不可用不重录");
		const video = submits.find((s) => s.kind === "video")!;
		assert.equal((video.params as { mode: string }).mode, "reference", "照常 reference 提交");
		assert.ok(Math.abs(result.script.shots[0]!.dialogue!.audioDurationSec! - 7) < 1e-6, "接受实测时长");
		assert.ok(run.events.some((e) => e.text.includes("精简不可用")));
	});

	it("A4 精简重录的 TTS 失败 → 回退首版台词音频，链路不阻断", async () => {
		reset();
		failTtsSecondOnly = true;
		probeSeq = [6.5, 7.0];
		const ctx = makeCtx();
		const { run, script } = await freshRun();
		const result = await runClips(ctx, run, script);
		assert.equal(submits.filter((s) => s.kind === "tts").length, 2);
		const video = submits.find((s) => s.kind === "video")!;
		assert.equal((video.params as { mode: string }).mode, "reference");
		assert.ok(Math.abs(result.script.shots[0]!.dialogue!.audioDurationSec! - 7) < 1e-6, "回退后用首版实测时长");
		assert.ok(run.events.some((e) => e.text.includes("精简重录失败，使用首版")));
	});
});
