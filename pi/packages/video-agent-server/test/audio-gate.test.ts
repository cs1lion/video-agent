/**
 * A1 闸门接线测试（node:test + mock.module，与闸门状态机测试同构的全桩环境）：
 * 验收口径是计划里的「非共创来源被强制回落」——纯函数只锁决策，这里锁
 * startRun 的接线：强制回落真的发生在 run 上，且触发留审计事件。
 *
 *   场景一：非共创来源请求 dialogue → options 强制回落 off + 审计事件；
 *   场景二：共创来源请求 dialogue   → 原样放行，无审计事件。
 *
 * 两条 run 都等推进到 gate=design 停机（与闸门状态机 P1 相同的稳定态），
 * 避免测试结束时还有后台管线在跑。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { ServerContext } from "../src/config.ts";

// ---------------------------------------------------------------------------
// 桩实现（形状与 gate-state-machine.test.ts 保持一致）
// ---------------------------------------------------------------------------

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** 立即成功并写占位媒体字节 —— 让磁盘产物与真实管线同构 */
class FakeQueue {
	private seq = 0;
	private readonly jobs = new Map<string, unknown>();
	submit(input: { kind: "image" | "video" | "tts" | "music"; outputName: string }, projectDir: string) {
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
		{
			id: "SH02",
			narrationZh: "窗外的城市仍在降温。",
			narrationEn: "Outside, the city keeps cooling.",
			visual: "小林在冷色落地窗前转身，年轻插画师穿同一件 olive-green knit sweater",
			durationSec: 2,
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

function llmStub(user: unknown): JsonFixture {
	const text = (typeof user === "string" ? user : JSON.stringify(user)).replace(/\\/g, "");
	if (text.includes("narrationZh")) return SCRIPT_FIXTURE;
	if (text.includes('"characters"') && text.includes('"scenes"')) return DESIGN_FIXTURE;
	if (text.includes('"styleKeywords"')) return BIBLE_FIXTURE;
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

describe("A1 音频驱动闸门接线（startRun 层）", () => {
	let ctx: ServerContext;
	let pipeline: typeof import("../src/pipeline.ts");
	let root: string;

	before(async () => {
		installMocks();
		pipeline = await import("../src/pipeline.ts");
		root = await mkdtemp(path.join(tmpdir(), "pi-audio-gate-"));
		ctx = {
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
		};
	});

	after(() => rm(root, { recursive: true, force: true }).catch(() => {}));

	/** 按记录显式等待稳定态（后台推进与全局 runId 无关） */
	async function waitStable(record: import("../src/pipeline.ts").RunRecord, what: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			if (record.gate === "design" || record.status === "failed" || record.status === "done") return;
			if (Date.now() > deadline)
				throw new Error(`等待超时：${what}（当前 ${record.status} / ${record.gate ?? ""} / ${record.error ?? ""}）`);
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	it("非共创来源请求台词模式 → 强制回落 off，且留审计事件", async () => {
		const store = new pipeline.RunStore();
		const record = pipeline.startRun(ctx, store, {
			logline: "30 秒深夜办公室气泡水广告",
			generationOptions: { audioDrive: "dialogue" },
		});
		// 闸门是同步的：startRun 返回时 options 已回落、审计事件已入列
		assert.equal(record.brief.generationOptions?.audioDrive, "off");
		assert.ok(
			record.events.some((e) => e.text.includes("音频驱动（台词模式）当前只对共创空间开放")),
			"强制回落必须留审计事件",
		);
		await waitStable(record, "回落后的 run 应照常推进到美术设计闸门");
		assert.notEqual(record.status, "failed", `闸门不应误伤正常流程：${record.error ?? ""}`);
	});

	it("共创来源请求台词模式 → 原样放行，无审计事件", async () => {
		const store = new pipeline.RunStore();
		const record = pipeline.startRun(ctx, store, {
			logline: "30 秒深夜办公室气泡水广告（共创版）",
			generationOptions: { audioDrive: "dialogue" },
			coSpace: {
				characters: [{ name: "小林", description: "young illustrator", voiceId: "step-voice-01" }],
				scenes: [],
				ideas: [],
			},
		});
		assert.equal(record.brief.generationOptions?.audioDrive, "dialogue");
		assert.ok(
			!record.events.some((e) => e.text.includes("已自动回落")),
			"共创来源不应触发回落审计事件",
		);
		await waitStable(record, "共创 run 应照常推进到美术设计闸门");
		assert.notEqual(record.status, "failed", `台词模式放行后流程不应失败：${record.error ?? ""}`);
	});
});
