/**
 * reshotRun（补拍重做）端到端回归测试 —— 2026-08-28 那个 P0 的**唯一可靠护栏**。
 *
 * 背景：reshot.ts 曾把 `withVersionedAsset` 的 generate 闭包写在 `width`/`kfDataUrl`
 * 声明之前，导致运行时 `ReferenceError: Cannot access 'width' before initialization`，
 * 主干功能静默坏了三个提交。
 *
 * 为什么必须靠运行时测试（已实测确认）：
 *   - **TypeScript 拦不住**：TS2448 对"闭包内引用"不生效——TS 无法判断闭包何时被调用，只能放行；
 *   - **Biome 也拦不住**：显式开启 `correctness/noInvalidUseBeforeDeclaration: "error"`
 *     后用该模式探针验证，同样零告警（原因同上，对闭包保守放行）。
 *   两者都拦不住 ⇒ 只有真正执行这段代码才能发现。
 *
 * 测试策略（刻意走**失败路径**以最小化 mock 面）：
 * 让队列返回 error → generate 闭包**照常执行**（TDZ 就发生在闭包里，能被测到），
 * 但不会走到需要 ffmpeg 的 stageExport。观测契约很干净：成功/失败两边都会把
 * `run.redoActive` 清成 null，所以轮询它就能知道异步 IIFE 何时结束。
 *
 * 注意：reshotRun 内部是 fire-and-forget 的 `void (async () => {...})()`，
 * 它立刻返回 `{ok:true}`，真实工作在其后的异步 IIFE 中完成。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

/** 队列失败时的假实现：submit 只发号，awaitJob 一律返回 error */
class FailingQueue {
	constructor(_config?: unknown) {}
	submit(input: { outputName?: string }, _projectDir: string): { id: string; status: string } {
		return { id: `job-${input.outputName ?? "x"}`, status: "queued" };
	}
	async awaitJob(jobId: string): Promise<{ id: string; status: string; filePath?: string }> {
		return { id: jobId, status: "error" };
	}
}

// 必须在 import reshot.ts 之前替换队列模块 —— 静态 import 会被提升，故下方用动态 import
mock.module("../../coding-agent/examples/extensions/studio/media/queue.ts", {
	namedExports: { GenerationQueue: FailingQueue },
});

const { reshotRun } = await import("../src/redo/reshot.ts");
type RunRecord = Parameters<typeof reshotRun>[1];

const STAGE_IDS = ["script", "visual", "prompts", "keyframes", "clips", "audio", "export"] as const;
const OLD_CLIP = "assets/clip-SH01.mp4";
const OLD_CLIP_BYTES = "old-clip-bytes";

/**
 * 最小可用的 ServerContext：只需撑到 `videoSubmitParams` 能取到视频适配器。
 * 缺 mediaConfig 会让闭包在 videoAdapterOf 处就 TypeError —— 那仍能触发回滚，
 * 但走不到队列调用；给足配置才能真正跑完「备份 → 生成 → 失败回滚」闭环。
 */
const fakeCtx = {
	mediaConfig: { media: [{ id: "video-test", kind: "video", model: "test-video-model" }] },
	priceCatalog: {},
	llm: { model: "test-llm", apiKey: "test", baseUrl: "http://127.0.0.1", timeoutMs: 1000 },
} as never;

describe("reshotRun 补拍重做（端到端回归）", () => {
	const roots: string[] = [];

	async function freshRun(): Promise<{ dir: string; run: RunRecord }> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-reshot-"));
		await mkdir(path.join(dir, "assets"), { recursive: true });
		roots.push(dir);

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
			path.join(dir, "keyframes.json"),
			JSON.stringify({ frames: [{ shotId: "SH01", status: "done", file: "assets/key-SH01.png" }] }),
			"utf-8",
		);
		await writeFile(path.join(dir, "assets/key-SH01.png"), "PNG-BYTES", "utf-8");
		await writeFile(path.join(dir, OLD_CLIP), OLD_CLIP_BYTES, "utf-8");

		const run = {
			id: "run-reshot-test",
			dir,
			status: "done",
			brief: { logline: "测试用", style: "", audience: "", tone: "", cta: "", brand: "", language: "zh" },
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
		throw new Error(`reshot 未在 10s 内结束（status=${run.status}）`);
	}

	after(async () => {
		await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }).catch(() => {})));
	});

	it("队列失败 → 旧片段必须被回滚还原，不能丢用户素材", async () => {
		const { dir, run } = await freshRun();
		reshotRun(fakeCtx, run, "SH01", "");
		await waitForCompletion(run);

		assert.equal(run.status, "failed", "队列失败应置 failed");
		// 核心不变量：generate 返回 null 后主文件必须还原为旧片段
		assert.equal(await readFile(path.join(dir, OLD_CLIP), "utf-8"), OLD_CLIP_BYTES);
		assert.equal(run.shotVersions["SH01"]?.length ?? 0, 0, "失败的备份项应被弹出");
	});

	it("回归锁：不得出现 TDZ「before initialization」崩溃", async () => {
		const { run } = await freshRun();
		reshotRun(fakeCtx, run, "SH01", "");
		await waitForCompletion(run);

		// 这条就是 2026-08-28 的 P0：闭包引用了尚未声明的 const。
		// 失败原因应当是「重做失败」而不是 ReferenceError。
		assert.doesNotMatch(run.error ?? "", /before initialization/i, `疑似 TDZ 回归：${run.error}`);
		assert.doesNotMatch(run.error ?? "", /is not defined/i, `疑似未定义引用：${run.error}`);
		assert.match(run.error ?? "", /重做失败|SH01/, `失败原因应可读，实际：${run.error}`);
	});

	it("镜头不存在 → 提前 bail，不进入运行态、不改动磁盘", async () => {
		const { dir, run } = await freshRun();
		const res = await reshotRun(fakeCtx, run, "SH99", "");
		await waitForCompletion(run);

		assert.equal(res.ok, false);
		assert.notEqual(run.status, "running");
		assert.equal(await readFile(path.join(dir, OLD_CLIP), "utf-8"), OLD_CLIP_BYTES);
	});
});
