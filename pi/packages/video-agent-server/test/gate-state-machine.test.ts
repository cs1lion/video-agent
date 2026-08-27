/**
 * 闸门状态机深度测试（node:test mock.module，experimental flag 下运行）：
 * LLM 与媒体队列全部替换为确定性桩 —— 不打真实网络、不烧任何生成额度。
 *
 * 场景链（单条 run 顺序推进）：
 *   P1 全新启动           → 美术设计就绪停机 gate=design，且未偷跑分镜提示词
 *   P2 用户确认 resume    → 提示词+关键帧齐备停机 gate=keyframes，且未提交视频任务；
 *                            关键帧任务带 params.image（设计定稿参考图传导）
 *   P3 再次确认 resume    → 片段/音频照常出活并收尾为 done（导出已由夹具标记完成）
 * 附加：refine(visual) 重挂 gate=design 且指令注入下游；resume 对已完成 run 是
 *       纯拒绝、不再误清闸门。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { EnrichedBrief } from "../../video-agent/src/index.ts";
import type { ServerContext } from "../src/config.ts";

// ---------------------------------------------------------------------------
// 桩实现
// ---------------------------------------------------------------------------

/** 最小合法 PNG（1×1），让 fileDataUrl 的参考图传导路径走真读盘 */
const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

interface CapturedJob {
	kind: "image" | "video" | "tts" | "music";
	prompt: string;
	params: Record<string, unknown>;
	outputName: string;
}

const submittedJobs: CapturedJob[] = [];

/** 立即成功并把占位媒体字节写进 project/assets —— 让磁盘产物与真实管线同构 */
class FakeQueue {
	private seq = 0;
	private readonly jobs = new Map<string, unknown>();
	submit(input: CapturedJob & { roleName?: string; priority?: number }, projectDir: string) {
		const extOf = { image: ".png", video: ".mp4", tts: ".mp3", music: ".mp3" } as const;
		const relative = path.posix.join("assets", `${input.outputName}${extOf[input.kind]}`);
		const absolute = path.join(projectDir, relative);
		const id = `J${this.seq++}`;
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
			await writeFile(absolute, input.kind === "image" ? PNG_1PX : Buffer.from([0x00, 0x01]), "utf-8");
		})();
		submittedJobs.push({
			kind: input.kind,
			prompt: input.prompt,
			params: input.params ?? {},
			outputName: input.outputName,
		});
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

const SCRIPT_FIXTURE: JsonFixture = {
	title: "深夜气泡水",
	logline: "疲惫插画师靠一口冰爽回神",
	shots: [
		{
			id: "SH01",
			narrationZh: "凌晨一点，小林灌下最后一口冰爽。",
			narrationEn: "1 a.m., Lin downs the last icy sip.",
			visual: "小林在深夜办公室敲键盘，仰头喝一口气泡水，罐身冰珠反光",
			durationSec: 4,
		},
	],
};

const BIBLE_FIXTURE: JsonFixture = {
	styleKeywords: ["cinematic", "cool"],
	palette: ["#0B1E3A", "#7FD1E8"],
	lighting: "moonlit cool key with monitor fill",
	grade: "teal shadows, amber highlights",
};

const DESIGN_FIXTURE: JsonFixture = {
	characters: [{ name: "小林", design: "young illustrator, olive-green knit sweater, messy black hair" }],
	props: [],
	scenes: [{ name: "办公室", design: "dim startup office at night, dual monitors glowing blue" }],
};

const PROMPTS_FIXTURE: JsonFixture = {
	promptVersion: 1,
	prompts: [
		{
			shotId: "SH01",
			prompt:
				"Cinematic medium shot of a tired young illustrator in an olive-green knit sweater typing at night, sipping a sparkling water can, cool monitor glow, slow push-in. Strictly avoid: on-screen text, watermark",
		},
	],
};

/** 五轴质检裁决（export 阶段 vision 调用的返回形状） */
const QA_FIXTURE: JsonFixture = {
	overall: "pass",
	score: 88,
	axes: [
		{ id: "briefFit", score: 90 },
		{ id: "visualConsistency", score: 86 },
		{ id: "pacing", score: 85 },
		{ id: "audioSync", score: 100 },
		{ id: "textQuality", score: 80 },
	],
	shots: [{ id: "SH01", verdict: "pass", reason: "与美术设计锚点一致" }],
};

function llmStub(user: unknown): JsonFixture {
	// 注意：JSON.stringify 会转义引号，必须先去掉反斜杠再匹配提示词原文标记
	const text = (typeof user === "string" ? user : JSON.stringify(user)).replace(/\\/g, "");
	if (text.includes("narrationZh")) return SCRIPT_FIXTURE;
	if (text.includes('"prompts": [{"shotId"')) return PROMPTS_FIXTURE;
	// 实体推导提示词内嵌整份美术设计 JSON，必须先于 styleKeywords 判定
	if (text.includes('"characters"') && text.includes('"scenes"')) return DESIGN_FIXTURE;
	if (text.includes('"styleKeywords"')) return BIBLE_FIXTURE;
	if (text.includes("旁白")) return { SH01: "平静压抑，末句微微上扬透出释然" };
	return {};
}

/** 每次 chatJson 的完整用户提示词（供“指令注入下游”类断言按需检索） */
const llmSeenUsers: string[] = [];

function installMocks(): void {
	mock.module(new URL("../src/llm.ts", import.meta.url).href, {
		namedExports: {
			LlmError: class extends Error {},
			chat: async () => "ok",
			chatVisionJson: async () => QA_FIXTURE,
			chatJson: async (_llm: unknown, user: unknown) => {
				const raw = typeof user === "string" ? user : JSON.stringify(user);
				llmSeenUsers.push(raw);
				return llmStub(user);
			},
		},
	});
	mock.module(new URL("../../coding-agent/examples/extensions/studio/media/queue.ts", import.meta.url).href, {
		namedExports: { GenerationQueue: FakeQueue },
	});
	// ffmpeg 全替身：形状与真实实现一致（归一化/合成落占位文件，抽帧给真 PNG）
	mock.module(new URL("../src/ffmpeg.ts", import.meta.url).href, {
		namedExports: {
			SFX_LABEL: { whoosh: "嗖", impact: "砰", riser: "升" } as Record<string, string>,
			TRANSITION_LABEL: {
				cut: "硬切",
				fade: "淡入淡出",
				dip: "叠化",
				white: "闪白",
				wipeleft: "左划",
				slideup: "上滑",
			} as Record<string, string>,
			probeDuration: async (): Promise<number | null> => 3.6,
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
		},
	});
}

// ---------------------------------------------------------------------------
// 场景驱动
// ---------------------------------------------------------------------------

describe("确认闸门状态机（全桩）", () => {
	let ctx: ServerContext;
	let pipeline: typeof import("../src/pipeline.ts");
	let root: string;
	let store: import("../src/pipeline.ts").RunStore;
	let runId: string;

	before(async () => {
		installMocks();
		pipeline = await import("../src/pipeline.ts");
		root = await mkdtemp(path.join(tmpdir(), "pi-gate-e2e-"));
		ctx = {
			studioRoot: root,
			mediaConfig: { media: [] } as unknown as ServerContext["mediaConfig"],
			llm: { url: "http://stub", model: "stub", timeoutMs: 1000 },
			port: 0,
		};
	});

	async function waitFor(predicate: (status: string) => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const record = store.get(runId)!;
			if (predicate(record.status)) return;
			if (Date.now() > deadline)
				throw new Error(`等待超时：${what}（当前 ${record.status} / ${record.error ?? ""}）`);
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	it("P1 启动 → 停在美术设计闸门，未偷跑下游", async () => {
		store = new pipeline.RunStore();
		const record = pipeline.startRun(ctx, store, {
			logline: "30 秒深夜办公室气泡水广告，主打回神一击",
			keyMessage: "FIZZ",
		});
		assert.equal(record.gate, "design");
		runId = record.id;
		await waitFor((s) => s === "awaiting", "P1 design gate");

		const run = store.get(runId)!;
		assert.equal(run.stages.find((s) => s.id === "script")!.status, "done");
		assert.equal(run.stages.find((s) => s.id === "visual")!.status, "done");
		for (const sid of ["prompts", "clips"] as const) {
			assert.equal(run.stages.find((s) => s.id === sid)!.status, "pending");
		}
		// 分镜提示词绝不能在美术设计确认前生成
		await assert.rejects(readFile(path.join(run.dir, "prompts.json")));
		// 设计实体与概念图确实产出（决定性素材落盘）
		const design = JSON.parse(await readFile(path.join(run.dir, "design-bible.json"), "utf-8")) as {
			characters: { file?: string; status: string }[];
		};
		assert.equal(design.characters[0]?.status, "done");
		assert.ok(design.characters[0]?.file);
		const sheetPath = path.join(run.dir, design.characters[0].file!);
		assert.ok((await readFile(sheetPath)).length > 0);
		assert.ok(run.events.some((e) => e.text.includes("美术设计已就绪")));
	});

	it("P2 确认 → 关键帧闸门；关键帧挂设计参考图；视频零消耗", async () => {
		const imageJobsBefore = submittedJobs.filter((j) => j.kind === "image").length;
		assert.equal(pipeline.resumeRun(ctx, store.get(runId)!).ok, true);
		await waitFor((s) => s === "awaiting", "P2 keyframes gate");

		const record = store.get(runId)!;
		assert.equal(record.gate, "keyframes");
		assert.equal(record.stages.find((s) => s.id === "prompts")!.status, "done");
		const frames = JSON.parse(await readFile(path.join(record.dir, "keyframes.json"), "utf-8")) as {
			frames: { shotId: string; status: string }[];
		};
		assert.equal(frames.frames.length, 1);
		assert.equal(frames.frames[0]!.status, "done");
		const imageJobs = submittedJobs.filter((j) => j.kind === "image");
		assert.ok(imageJobs.length > imageJobsBefore); // 关键帧确实新出了图
		const keyJob = imageJobs.at(-1)!;
		assert.match(keyJob.outputName, /^key-/);
		assert.equal(typeof keyJob.params.image, "string"); // ★ 设计定稿 → 参考图传导
		assert.deepEqual(
			keyJob.params.image ? Buffer.from((keyJob.params.image as string).split(",")[1]!, "base64") : null,
			PNG_1PX,
		);
		assert.equal(
			submittedJobs.some((j) => j.kind === "video"),
			false,
		); // 未烧一分钱视频额度
		assert.ok(record.events.some((e) => e.text.includes("关键帧全部就绪")));
	});

	it("P3 再次确认 → 片段/音频产出并收敛为 done", async () => {
		const record = store.get(runId)!;
		// 导出不在本测试范围（需要真 ffmpeg）：预标记 audio/export 完成，
		// 使本轮 resume 只推进 clips，链条自然收尾为交付态。
		for (const sid of ["audio", "export"] as const) {
			record.stages.find((s) => s.id === sid)!.status = "done";
		}
		record.finalFile = "final.mp4";
		assert.equal(pipeline.resumeRun(ctx, record).ok, true);
		await waitFor((s) => s === "done" || s === "failed", "P3 finish");

		const recordNow = store.get(runId)!;
		assert.equal(recordNow.status, "done", recordNow.error ?? "");
		assert.equal(
			submittedJobs.some((j) => j.kind === "video"),
			true,
		);
		const clipJob = submittedJobs.filter((j) => j.kind === "video").at(-1)!;
		assert.equal(clipJob.params.mode ?? undefined, undefined); // 通用适配器路径：image 即首帧
		// ★ 端到端一致性链路：LLM 提示词 → 关键帧（参考图） → 图生视频首帧
		assert.ok(typeof clipJob.params.image === "string" && clipJob.params.image.startsWith("data:image/png;base64,"));
		assert.match(clipJob.prompt, /olive-green knit sweater/); // LLM 锚点未被丢
		assert.ok(recordNow.videoUrl);
	});

	it("refine(visual)：指令注入下游提示词并重挂美术设计闸门", async () => {
		const record = store.get(runId)!;
		record.status = "awaiting";
		record.stages.find((s) => s.id === "visual")!.status = "done";
		record.stages.find((s) => s.id === "script")!.status = "done";
		const seenBefore = llmSeenUsers.length;
		const videosBefore = submittedJobs.filter((j) => j.kind === "video").length;
		const result = pipeline.refineRun(ctx, record, "visual", "整体更冷调，弱化橙色高光", false);
		assert.equal(result.ok, true);
		await waitFor((s) => s === "awaiting", "refine settle");
		assert.equal(store.get(runId)!.gate, "design");
		// 视觉微调的指令必须写进下游 promptFragment（此处由美术设计再生成承载）
		assert.ok(
			record.brief.generationDirectives.visual.promptFragment.includes("整体更冷调"),
			`fragment=${record.brief.generationDirectives.visual.promptFragment}`,
		);
		assert.ok(
			llmSeenUsers.slice(seenBefore).some((u) => u.includes("整体更冷调")),
			`refine 后新发起的 LLM 调用应携带客户指令，实际 ${llmSeenUsers.slice(seenBefore).length} 次`,
		);
		assert.equal(submittedJobs.filter((j) => j.kind === "video").length, videosBefore); // 纯文本微调不碰视频额度
	});

	it("已完成 run 的 resume 是纯拒绝，不误清残留闸门", () => {
		const guardStore = new pipeline.RunStore();
		const record = guardStore.create({ creative: { logline: "nothing left" } } as EnrichedBrief, root);
		for (const s of record.stages) s.status = "done";
		record.status = "failed"; // 非 running 即可进入守卫逻辑
		record.gate = "keyframes";
		const result = pipeline.resumeRun(ctx, record);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /所有阶段已完成/);
		assert.equal(record.gate, "keyframes"); // ★ 回归：先查可推进性再动状态
	});

	after(async () => {
		mock.restoreAll();
		if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
	});
});
