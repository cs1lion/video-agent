/**
 * B4 导演契约测试 —— 双向闭环的 schema 锁定（纯函数，无 I/O / 无 mock）。
 *
 * 设计报告 §3.7：创意决策与资源决策解耦成两个 agent、用结构化契约通信。
 * 契约字段是前端硬契约——改类型会破坏 UI，这里的断言就是"漂移探测器"。
 *
 * 双向：
 *   方向 1（导演 → 制片主任）：PriorityInstruction { shotId, priority, qualityBar, maxRetries }
 *   方向 2（制片主任 → 导演）：BudgetAlert { type, message, suggestion, shortfall, affectedShots }
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PRIORITY_LEVELS,
	QUALITY_BARS,
	PRIORITY_QUEUE_VALUES,
	PRIORITY_LABELS,
	QUALITY_BAR_LABELS,
	validatePriorityInstruction,
	buildBudgetAlert,
	validateBudgetAlert,
	CONTRACT_SCHEMA,
	type PriorityInstruction,
} from "../src/director-contract.ts";

// ── 枚举稳定性（契约的根基——枚举值漂移 = 前端崩） ──────────────────

describe("B4 契约常量（枚举不漂移）", () => {
	it("PRIORITY_LEVELS = [P0, P1, P2]", () => {
		assert.deepEqual([...PRIORITY_LEVELS], ["P0", "P1", "P2"]);
	});

	it("QUALITY_BARS = [must_keep, nice_to_have, sacrificable]", () => {
		assert.deepEqual([...QUALITY_BARS], ["must_keep", "nice_to_have", "sacrificable"]);
	});

	it("PRIORITY_QUEUE_VALUES：越低越优先（与队列排序一致）", () => {
		assert.ok(PRIORITY_QUEUE_VALUES.P0 < PRIORITY_QUEUE_VALUES.P1);
		assert.ok(PRIORITY_QUEUE_VALUES.P1 < PRIORITY_QUEUE_VALUES.P2);
		assert.equal(PRIORITY_QUEUE_VALUES.P0, 1);
		assert.equal(PRIORITY_QUEUE_VALUES.P2, 100);
	});

	it("CONTRACT_SCHEMA 快照锁定", () => {
		assert.deepEqual(CONTRACT_SCHEMA.priorityLevels, PRIORITY_LEVELS);
		assert.deepEqual(CONTRACT_SCHEMA.qualityBars, QUALITY_BARS);
	});

	it("标签存在（UI 徽标用）", () => {
		for (const level of PRIORITY_LEVELS) assert.ok(PRIORITY_LABELS[level]);
		for (const bar of QUALITY_BARS) assert.ok(QUALITY_BAR_LABELS[bar]);
	});
});

// ── 方向 1：优先级指令验证 ────────────────────────────────────────

describe("validatePriorityInstruction（导演 → 制片主任）", () => {
	it("合法指令 → ok", () => {
		const r = validatePriorityInstruction({ shotId: "SH01", priority: "P0", qualityBar: "must_keep", maxRetries: 1 });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.instruction.shotId, "SH01");
			assert.equal(r.instruction.priority, "P0");
			assert.equal(r.instruction.qualityBar, "must_keep");
			assert.equal(r.instruction.maxRetries, 1);
		}
	});

	it("maxRetries 缺省 → 按 priority 给合理默认值（P0=2, P1=1, P2=0）", () => {
		const r0 = validatePriorityInstruction({ shotId: "S", priority: "P0", qualityBar: "must_keep" });
		assert.equal(r0.ok && r0.instruction.maxRetries, 2);
		const r1 = validatePriorityInstruction({ shotId: "S", priority: "P1", qualityBar: "nice_to_have" });
		assert.equal(r1.ok && r1.instruction.maxRetries, 1);
		const r2 = validatePriorityInstruction({ shotId: "S", priority: "P2", qualityBar: "sacrificable" });
		assert.equal(r2.ok && r2.instruction.maxRetries, 0);
	});

	it("非法 priority → 拒绝", () => {
		assert.equal(validatePriorityInstruction({ shotId: "S", priority: "P9", qualityBar: "must_keep" }).ok, false);
		assert.equal(validatePriorityInstruction({ shotId: "S", priority: 0, qualityBar: "must_keep" }).ok, false);
	});

	it("缺 shotId → 拒绝", () => {
		assert.equal(validatePriorityInstruction({ priority: "P0", qualityBar: "must_keep" }).ok, false);
		assert.equal(validatePriorityInstruction({ shotId: "  ", priority: "P0", qualityBar: "must_keep" }).ok, false);
	});

	it("非法 qualityBar → 拒绝", () => {
		assert.equal(validatePriorityInstruction({ shotId: "S", priority: "P0", qualityBar: "whatever" }).ok, false);
	});

	it("maxRetries 负数/小数/越界 → 走默认值", () => {
		const r = validatePriorityInstruction({ shotId: "S", priority: "P0", qualityBar: "must_keep", maxRetries: -1 });
		assert.equal(r.ok && r.instruction.maxRetries, 2);
		const r2 = validatePriorityInstruction({ shotId: "S", priority: "P0", qualityBar: "must_keep", maxRetries: 1.5 });
		assert.equal(r2.ok && r2.instruction.maxRetries, 2);
		const r3 = validatePriorityInstruction({ shotId: "S", priority: "P0", qualityBar: "must_keep", maxRetries: 99 });
		assert.equal(r3.ok && r3.instruction.maxRetries, 2);
	});

	it("非对象输入 → 拒绝", () => {
		assert.equal(validatePriorityInstruction(null).ok, false);
		assert.equal(validatePriorityInstruction("P0").ok, false);
		assert.equal(validatePriorityInstruction(undefined).ok, false);
	});
});

// ── 方向 2：预算告警构建 + 验证 ──────────────────────────────────

describe("buildBudgetAlert（制片主任 → 导演）", () => {
	it("正确计算缺口 + 受影响镜头", () => {
		const alert = buildBudgetAlert({
			remainingSec: 312,
			estimateSec: 5,
			productionShotIds: ["SH01", "SH02", "SH03", "SH04"],
			fromIndex: 2,
			at: 1000,
		});
		assert.equal(alert.type, "budget_alert");
		assert.equal(alert.remainingSec, 312);
		assert.equal(alert.requiredSec, 20);
		assert.equal(alert.shortfallSec, 0, "required < remaining 时缺口 = 0（不会负数）");
		assert.deepEqual(alert.affectedShots, ["SH03", "SH04"]);
		assert.ok(alert.message.includes("312"));
		assert.ok(alert.suggestion.includes("2"));
		assert.equal(alert.at, 1000);
	});

	it("缺口为正数时 suggestion 含缺口秒数", () => {
		const alert = buildBudgetAlert({
			remainingSec: 10,
			estimateSec: 5,
			productionShotIds: ["SH01", "SH02", "SH03", "SH04"],
			fromIndex: 0,
		});
		assert.ok(alert.shortfallSec > 0);
		assert.ok(alert.suggestion.includes("缺口"));
		assert.deepEqual(alert.affectedShots, ["SH01", "SH02", "SH03", "SH04"]);
	});

	it("at 缺省 → 取当前时间", () => {
		const alert = buildBudgetAlert({ remainingSec: 10, estimateSec: 5, productionShotIds: ["S"], fromIndex: 0 });
		assert.ok(alert.at > 0);
	});
});

describe("validateBudgetAlert（持久化数据读取校验）", () => {
	it("合法 alert → ok", () => {
		const alert = buildBudgetAlert({ remainingSec: 10, estimateSec: 5, productionShotIds: ["S"], fromIndex: 0 });
		const r = validateBudgetAlert(alert);
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.alert.type, "budget_alert");
	});

	it("type 不是 budget_alert → 拒绝", () => {
		assert.equal(validateBudgetAlert({ type: "warning", message: "x" }).ok, false);
	});

	it("缺 message → 拒绝", () => {
		assert.equal(validateBudgetAlert({ type: "budget_alert", remainingSec: 1, requiredSec: 2, shortfallSec: 1, at: 1 }).ok, false);
	});

	it("非数字字段 → 拒绝", () => {
		const base = { type: "budget_alert", message: "x", suggestion: "", affectedShots: [], at: 1 };
		assert.equal(validateBudgetAlert({ ...base, remainingSec: "abc" }).ok, false);
		assert.equal(validateBudgetAlert({ ...base, requiredSec: null }).ok, false);
		assert.equal(validateBudgetAlert({ ...base, at: -1 }).ok, false);
	});

	it("非对象 → 拒绝", () => {
		assert.equal(validateBudgetAlert(null).ok, false);
		assert.equal(validateBudgetAlert("string").ok, false);
	});
});

// ── 双向闭环模拟（契约级，无 I/O） ─────────────────────────────────

describe("B4 闭环：预算告警 → 导演响应 → 优先级指令 → 队列映射", () => {
	it("导演看到告警后下 P0 指令，映射到最高优先级", () => {
		// 1. 制片主任构建预算告警
		const alert = buildBudgetAlert({
			remainingSec: 50,
			estimateSec: 10,
			productionShotIds: ["SH01", "SH02", "SH03", "SH04"],
			fromIndex: 2,
		});
		assert.ok(alert.affectedShots.includes("SH03"));

		// 2. 导演看到受影响镜头，决定 SH03 是 P0（必保）
		const instruction = validatePriorityInstruction({
			shotId: "SH03",
			priority: "P0",
			qualityBar: "must_keep",
			maxRetries: 1,
		});
		assert.equal(instruction.ok, true);

		// 3. P0 映射到队列最高优先级（数值最低）
		if (instruction.ok) {
			const queuePriority = PRIORITY_QUEUE_VALUES[instruction.instruction.priority];
			assert.ok(queuePriority <= PRIORITY_QUEUE_VALUES.P1, "P0 必须比 P1 更优先");
		}
	});

	it("导演看到告警后下 P2 指令（可放弃），映射到最低优先级", () => {
		const instruction = validatePriorityInstruction({
			shotId: "SH04",
			priority: "P2",
			qualityBar: "sacrificable",
		});
		assert.equal(instruction.ok, true);
		if (instruction.ok) {
			assert.equal(PRIORITY_QUEUE_VALUES[instruction.instruction.priority], 100);
			assert.equal(instruction.instruction.maxRetries, 0, "P2 默认不重试");
		}
	});
});
