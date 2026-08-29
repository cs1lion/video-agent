/**
 * L2 守卫契约测试（B3 自动执行的确定性否决层，纯函数无 mock）。
 * 设计红线：绝不让 LLM 直接碰硬约束——这里锁的是"违规必被拒、合规必放行"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardSuggestion, rejectionRate, type GuardSuggestion, type GuardWorld } from "../src/guard.ts";
import type { KitchenSnapshot } from "../src/kitchen.ts";

const NOW = Date.parse("2026-08-29T12:00:00Z");

function world(overrides: Partial<GuardWorld> = {}): GuardWorld {
	return {
		snapshot: {
			generatedAt: NOW,
			ovens: [{ id: "video", keyType: "tokenplan", tokens: 2, rpmWaitMs: 0, remainingQuotaSec: 50, reservedSec: 0, inFlight: 0, overrunSec: 0 }],
			readyTasks: [{ id: "J1", outputName: "clip-SH01.mp4", seconds: 5, priority: 100, retryCount: 0, waitingMs: 1000 }],
			inFlightTasks: [],
			recentFailures: [],
			budget: { totalSec: null, remainingSec: 50, reservedSec: 0, overrunSec: 0, day: "2026-08-29" },
		},
		recentDecisions: [],
		cooldownMs: 60_000,
		now: NOW,
		...overrides,
	};
}

function spec(overrides: Partial<GuardSuggestion> = {}): GuardSuggestion {
	return { type: "submit", taskId: "J1", ovenId: "video", ...overrides };
}

describe("L2 守卫（guardSuggestion）", () => {
	it("合规 submit → 放行", () => {
		assert.deepEqual(guardSuggestion(spec(), world()), { ok: true });
	});

	it("任务不存在 → unknown_task", () => {
		const v = guardSuggestion(spec({ taskId: "J99" }), world());
		assert.equal(v.ok, false);
		assert.equal(v.ok ? "" : v.reason, "unknown_task");
	});

	it("烤炉不存在 → unknown_oven", () => {
		const v = guardSuggestion(spec({ ovenId: "oven-x" }), world());
		assert.equal(v.ok, false);
		assert.equal(v.ok ? "" : v.reason, "unknown_oven");
	});

	it("RPM 令牌耗尽 → rpm_exhausted（安全默认 = 等令牌，不硬撞）", () => {
		const w = world();
		w.snapshot.ovens[0]!.tokens = 0;
		const v = guardSuggestion(spec(), w);
		assert.equal(v.ok, false);
		assert.equal(v.ok ? "" : v.reason, "rpm_exhausted");
	});

	it("剩余配额不足 → insufficient_quota", () => {
		const w = world();
		w.snapshot.ovens[0]!.remainingQuotaSec = 3;
		const v = guardSuggestion(spec(), w);
		assert.equal(v.ok, false);
		assert.equal(v.ok ? "" : v.reason, "insufficient_quota");
	});

	it("defer：排队任务 + 合法时长 → 放行；在途任务 → task_not_queued", () => {
		assert.deepEqual(guardSuggestion(spec({ type: "defer", deferMs: 30_000 }), world()), { ok: true });
		const w = world();
		w.snapshot.readyTasks = [];
		w.snapshot.inFlightTasks.push({ id: "J1", outputName: "clip-SH01.mp4", seconds: 5, priority: 100, retryCount: 0, waitingMs: 0 });
		const v = guardSuggestion(spec({ type: "defer", deferMs: 30_000 }), w);
		assert.equal(v.ok, false);
		assert.equal(v.ok ? "" : v.reason, "task_not_queued");
		assert.equal(guardSuggestion(spec({ type: "defer", deferMs: -1 }), world()).ok, false);
	});

	it("downgrade：目标必须为正且小于当前秒数", () => {
		assert.deepEqual(guardSuggestion(spec({ type: "downgrade", targetSeconds: 3 }), world()), { ok: true });
		assert.equal(guardSuggestion(spec({ type: "downgrade", targetSeconds: 10 }), world()).ok, false);
		assert.equal(guardSuggestion(spec({ type: "downgrade", targetSeconds: 5 }), world()).ok, false, "等于当前秒数 = 无意义降级，拒绝");
		assert.equal(guardSuggestion(spec({ type: "downgrade", targetSeconds: 0 }), world()).ok, false);
	});

	it("冷却期：同任务同类型 60s 内重复 → cooldown；不同任务放行", () => {
		const w = world({ recentDecisions: [{ type: "submit", taskId: "J1", at: NOW - 10_000 }] });
		assert.equal(guardSuggestion(spec(), w).ok, false);
		const w2 = world({ recentDecisions: [{ type: "submit", taskId: "J2", at: NOW - 10_000 }] });
		assert.deepEqual(guardSuggestion(spec(), w2), { ok: true });
	});

	it("escalate/signal/wait 无硬约束：taskId 缺省也放行（仍受冷却）", () => {
		assert.deepEqual(guardSuggestion({ type: "escalate" }, world()), { ok: true });
		assert.deepEqual(guardSuggestion({ type: "wait" }, world()), { ok: true });
	});

	it("rejectionRate：监控指标数学", () => {
		assert.equal(rejectionRate(8, 2), 0.2);
		assert.equal(rejectionRate(0, 0), null);
	});
});
