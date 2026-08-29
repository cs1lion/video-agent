/**
 * B2 只读制片主任 —— producerObserve 行为链（mock LLM，无真实网络）。
 * 锁四条：
 * 1. LLM 合法输出 → 建议清洗落盘 + 团队频道事件（D4）+ 快照来自账本与活跃队列；
 * 2. LLM 不可用 → 降级不抛错（产线不受影响，观察留痕）；
 * 3. 建议清洗：白名单外类型/缺 message 的条目丢弃，id 按序分配；
 * 4. 反馈留痕 → 采纳率可度量（B2 验收标准）。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { RunRecord } from "../src/pipeline.ts";
import type { ServerContext } from "../src/config.ts";
import { QuotaLedger } from "../src/quota.ts";
import type { QueueJob } from "../../coding-agent/examples/extensions/studio/media/queue.ts";

/** LLM 拨杆：chat 的返回值（JSON 字符串）或抛错 */
let chatReply: string | Error = "{}";

function installMocks(): void {
	mock.module(new URL("../src/llm.ts", import.meta.url).href, {
		namedExports: {
			LlmError: class extends Error {},
			chat: async (): Promise<string> => {
				if (chatReply instanceof Error) throw chatReply;
				return chatReply;
			},
			chatJson: async () => ({}),
			chatVisionJson: async () => ({}),
			tryParseJson: <T>(raw: string) => JSON.parse(raw) as T,
		},
	});
}

function job(overrides: Partial<QueueJob> = {}): QueueJob {
	return {
		id: "J1",
		adapterId: "agnes-video",
		kind: "video",
		prompt: "p",
		params: { seconds: "5" },
		relativePath: "assets/clip-SH01.mp4",
		priority: 100,
		status: "queued",
		attempts: 1,
		maxAttempts: 3,
		createdAt: Date.now() - 2000,
		attemptLog: [],
		...overrides,
	} as QueueJob;
}

describe("B2 制片主任（只读观察者）", () => {
	let producer: typeof import("../src/producer.ts");
	let kitchen: typeof import("../src/kitchen.ts");
	let root: string;
	let run: RunRecord;

	before(async () => {
		installMocks();
		producer = await import("../src/producer.ts");
		kitchen = await import("../src/kitchen.ts");
		root = await mkdtemp(path.join(tmpdir(), "pi-producer-"));
		const dir = path.join(root, "run-obs");
		await mkdir(path.join(dir, "assets"), { recursive: true });
		run = {
			id: "run-obs",
			dir,
			status: "running",
			brief: { creative: { logline: "测试片", keyMessage: "" }, language: "zh", generationOptions: {} },
			stages: [
				{ id: "clips", status: "running", progress: 40 },
				{ id: "export", status: "pending", progress: 0 },
			],
			events: [],
			abort: new AbortController(),
		} as unknown as RunRecord;
	});

	after(async () => {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	function makeCtx(): ServerContext {
		return {
			studioRoot: root,
			mediaConfig: {},
			llm: { url: "http://mock", model: "mock", timeoutMs: 1000 },
			port: 0,
			priceCatalog: {} as ServerContext["priceCatalog"],
			quota: new QuotaLedger([{ id: "video", keyType: "tokenplan", rpmCap: 2, dailyQuotaSec: 500 }], Date.now()),
		} as ServerContext;
	}

	it("sanitizeSuggestions：白名单外/缺 message 丢弃，id 按序分配", () => {
		const { suggestions, reasoning } = producer.sanitizeSuggestions(
			{
				suggestions: [
					{ type: "submit", taskId: "J1", message: "投 video 池", reason: "P0" },
					{ type: "explode", message: "非法类型" },
					{ type: "wait" },
					{ type: "downgrade", message: "降到 5s" },
				],
				reasoning: "权衡说明",
			},
			"obs-t",
		);
		assert.deepEqual(
			suggestions.map((s) => `${s.type}:${s.id}`),
			["submit:obs-t-s1", "downgrade:obs-t-s2"],
		);
		assert.equal(reasoning, "权衡说明");
	});

	it("观察一轮：快照来自账本+活跃队列，建议落盘 + 团队频道事件", async () => {
		chatReply = JSON.stringify({
			suggestions: [{ type: "submit", taskId: "J1", ovenId: "video", message: "J1 就绪，投入 video 池", reason: "依赖满足" }],
			reasoning: "预算充足",
		});
		kitchen.registerActiveQueue("run-obs", {
			list: () => [job(), job({ id: "J2", status: "running" }), job({ id: "J3", status: "failed", error: "429", finishedAt: Date.now() })],
			stats: () => ({ queued: 1, running: 1, failed: 1, rateLimited: 1 }),
		});
		const ctx = makeCtx();
		const obs = await producer.producerObserve(run, ctx);

		assert.equal(obs.suggestions.length, 1);
		assert.equal(obs.suggestions[0]!.type, "submit");
		assert.equal(obs.snapshot.readyTasks.length, 1, "快照来自注册的活跃队列");
		assert.equal(obs.snapshot.inFlightTasks.length, 1);
		assert.equal(obs.snapshot.recentFailures[0]!.reason, "429");
		assert.equal(obs.snapshot.budget.remainingSec, 500, "账本快照进入预算");
		assert.equal(obs.reasoning, "预算充足");

		const summary = await producer.kitchenSummary(run);
		assert.equal(summary.observations.length, 1);
		// D4：制片主任的观察必须推到团队频道（ev 通道）
		const evt = run.events.find((e) => e.from === "producer" && e.text.includes("制片主任观察"));
		assert.ok(evt, "必须有 producer → client 的团队事件");
	});

	it("LLM 失败 → 降级不抛错：空建议 + 降级说明", async () => {
		chatReply = new Error("connection refused");
		const obs = await producer.producerObserve(run, makeCtx());
		assert.deepEqual(obs.suggestions, []);
		assert.ok(obs.reasoning.includes("观察降级"));
		assert.ok(obs.reasoning.includes("connection refused"));
	});

	it("反馈留痕 → 采纳率可度量（B2 验收）", async () => {
		chatReply = JSON.stringify({
			suggestions: [
				{ type: "submit", taskId: "J1", message: "a" },
				{ type: "wait", message: "b" },
			],
			reasoning: "r",
		});
		const ctx = makeCtx();
		const obs = await producer.producerObserve(run, ctx);
		await producer.kitchenFeedback(run, obs.id, obs.suggestions[0]!.id, "adopted");
		await producer.kitchenFeedback(run, obs.id, obs.suggestions[1]!.id, "dismissed");

		const summary = await producer.kitchenSummary(run);
		assert.equal(summary.stats.adopted, 1);
		assert.equal(summary.stats.dismissed, 1);
		assert.equal(summary.stats.adoptionRate, 0.5);
		// 不存在的观察 → null
		assert.equal(await producer.kitchenFeedback(run, "obs-nope", "x", "adopted"), null);
	});
});
