/**
 * B2 observe_kitchen 契约测试（纯函数，无网络/无 mock）。
 * 观察信息格式是 ReAct 推理质量的根基（设计报告点名的脆弱点）——
 * schema 一变这里的断言就该红。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activeQueueOf,
	buildKitchenSnapshot,
	registerActiveQueue,
	unregisterActiveQueue,
	type QueueJobSource,
} from "../src/kitchen.ts";
import type { PoolSnapshot } from "../src/quota.ts";
import type { QueueJob } from "../../coding-agent/examples/extensions/studio/media/queue.ts";

const NOW = Date.parse("2026-08-29T12:00:00Z");

function pool(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
	return {
		id: "video",
		keyType: "tokenplan",
		rpmTokens: 2,
		rpmWaitMs: 0,
		remainingQuotaSec: 312,
		reservedSec: 10,
		inFlight: 2,
		overrunSec: 0,
		...overrides,
	};
}

function job(overrides: Partial<QueueJob> = {}): QueueJob {
	return {
		id: "J1",
		adapterId: "agnes-video",
		kind: "video",
		prompt: "p",
		params: { seconds: "5" },
		relativePath: "assets/clip-SH03.mp4",
		priority: 100,
		status: "queued",
		attempts: 1,
		maxAttempts: 3,
		createdAt: NOW - 4000,
		attemptLog: [],
		...overrides,
	} as QueueJob;
}

describe("buildKitchenSnapshot（B2 厨房快照契约）", () => {
	it("ovens 投影：无配额池 remaining→null，字段对齐烤炉模型", () => {
		const snap = buildKitchenSnapshot(
			[pool(), pool({ id: "free-1", keyType: "free", remainingQuotaSec: Number.POSITIVE_INFINITY, reservedSec: 0, inFlight: 0 })],
			[],
			NOW,
		);
		assert.equal(snap.ovens.length, 2);
		assert.equal(snap.ovens[0]!.tokens, 2);
		assert.equal(snap.ovens[0]!.remainingQuotaSec, 312);
		assert.equal(snap.ovens[1]!.remainingQuotaSec, null, "无每日配额池必须投影为 null");
		assert.equal(snap.ovens[1]!.keyType, "free");
	});

	it("readyTasks：只收 queued、按 priority→createdAt 排序、retryCount=attempts-1、秒数取 params.seconds", () => {
		const snap = buildKitchenSnapshot(
			[pool()],
			[
				job({ id: "J2", priority: 50, status: "queued", attempts: 3, params: { seconds: "10" } }),
				job({ id: "J1", priority: 50, status: "queued", createdAt: NOW - 9000 }),
				job({ id: "J3", priority: 10, status: "running" }),
				job({ id: "J4", status: "failed" }),
			],
			NOW,
		);
		assert.deepEqual(
			snap.readyTasks.map((t) => t.id),
			["J1", "J2"],
			"priority 相同按创建时间；running/failed 不进 readyTasks",
		);
		assert.equal(snap.readyTasks[0]!.retryCount, 0);
		const j2 = snap.readyTasks[1]!;
		assert.equal(j2.retryCount, 2, "重试中的排队任务 retryCount = attempts-1");
		assert.equal(j2.seconds, 10);
		assert.equal(j2.outputName, "clip-SH03.mp4");
		assert.ok(j2.waitingMs >= 4000);
	});

	it("inFlightTasks 与 recentFailures（失败按完成时间倒序、封顶 5）", () => {
		const failures = Array.from({ length: 7 }, (_, i) =>
			job({ id: `F${i}`, status: "failed", error: "boom", finishedAt: NOW - i * 1000 }),
		);
		const snap = buildKitchenSnapshot(
			[pool()],
			[...failures, job({ id: "R1", status: "running" })],
			NOW,
		);
		assert.equal(snap.inFlightTasks.length, 1);
		assert.equal(snap.inFlightTasks[0]!.id, "R1");
		assert.equal(snap.recentFailures.length, 5, "近期失败封顶 5 条");
		assert.equal(snap.recentFailures[0]!.id, "F0", "最新的失败排最前");
		assert.equal(snap.recentFailures[0]!.reason, "boom");
	});

	it("budget：剩余/预留/超支汇总；无配额池 remaining=null", () => {
		const snap = buildKitchenSnapshot(
			[pool({ remainingQuotaSec: 312, reservedSec: 10, overrunSec: 4 })],
			[],
			NOW,
		);
		assert.equal(snap.budget.remainingSec, 312);
		assert.equal(snap.budget.reservedSec, 10);
		assert.equal(snap.budget.overrunSec, 4);
		assert.equal(snap.budget.day, "2026-08-29");
		const free = buildKitchenSnapshot(
			[pool({ remainingQuotaSec: Number.POSITIVE_INFINITY })],
			[],
			NOW,
		);
		assert.equal(free.budget.remainingSec, null);
	});

	it("活跃队列注册表：注册可见、注销后消失", () => {
		const src: QueueJobSource = {
			list: () => [],
			stats: () => ({ queued: 0, running: 0, failed: 0, rateLimited: 0 }),
		};
		assert.equal(activeQueueOf("run-x"), undefined);
		registerActiveQueue("run-x", src);
		assert.equal(activeQueueOf("run-x"), src);
		unregisterActiveQueue("run-x");
		assert.equal(activeQueueOf("run-x"), undefined);
	});
});
