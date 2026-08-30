/**
 * B5 A/B 度量 —— computeRunMetrics 契约测试（纯函数，无 I/O / 无 mock）。
 *
 * 设计 §3.8：度量否则就是自我感动——做 A/B（相同配额预算下比交付量）。
 * 核心指标是配额利用率（有效成片秒数 ÷ 消耗配额秒数）。
 * 这里锁的是数学正确性——指标算错了 A/B 比较就是假比较。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeRunMetrics, percentile, p95, shotSeconds, type MetricsInput } from "../src/metrics.ts";

function input(overrides: Partial<MetricsInput> = {}): MetricsInput {
	return {
		consumedSec: 100,
		effectiveSec: 80,
		wastedSec: 20,
		completedCount: 8,
		failedCount: 2,
		rejectionRate: 0.1,
		p0Latencies: [30_000, 60_000, 90_000],
		runDurationMs: 600_000,
		...overrides,
	};
}

describe("computeRunMetrics（B5 度量数学）", () => {
	it("全数据在位 → 五项指标全出", () => {
		const m = computeRunMetrics(input());
		// 配额利用率 = 80/100 = 0.8
		assert.equal(m.quotaUtilization, 0.8);
		// 有效吞吐 = 8 clips / 10 min = 0.8 clips/min
		assert.equal(m.effectiveThroughput, 0.8);
		// 浪费率 = 20/100 = 0.2
		assert.equal(m.wasteRate, 0.2);
		assert.equal(m.rejectionRate, 0.1);
		assert.equal(m.consumedSec, 100);
		assert.equal(m.effectiveSec, 80);
		assert.equal(m.wastedSec, 20);
		assert.equal(m.completedClips, 8);
		assert.equal(m.failedClips, 2);
	});

	it("配额利用率 = 0 当 consumedSec=0（没花配额就不存在利用率）", () => {
		assert.equal(computeRunMetrics(input({ consumedSec: 0, effectiveSec: 0 })).quotaUtilization, null);
		assert.equal(computeRunMetrics(input({ consumedSec: 0 })).quotaUtilization, null, "consumed=0 时 effective>0 也不算（没花配额何来利用）");
	});

	it("有效吞吐 = null 当 runDurationMs=0（时长未知）", () => {
		assert.equal(computeRunMetrics(input({ runDurationMs: 0 })).effectiveThroughput, null);
	});

	it("浪费率 = 0 当 wastedSec=0（无失败 clip）", () => {
		assert.equal(computeRunMetrics(input({ wastedSec: 0 })).wasteRate, 0);
	});

	it("P0 延迟 P95：空数组 → null", () => {
		assert.equal(computeRunMetrics(input({ p0Latencies: [] })).p0LatencyP95, null);
	});

	it("P0 延迟 P95：单元素 → 该元素本身", () => {
		assert.equal(computeRunMetrics(input({ p0Latencies: [42_000] })).p0LatencyP95, 42_000);
	});

	it("P0 延迟 P95：多元素 → 95 百分位", () => {
		const vals = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000];
		const m = computeRunMetrics(input({ p0Latencies: vals }));
		assert.ok(m.p0LatencyP95 !== null);
		// P95 of 10 values ≈ 接近最大值
		assert.ok(m.p0LatencyP95! >= 90_000, `P95 应接近最大值，实际 ${m.p0LatencyP95}`);
	});

	it("被拒率 null 透传（kitchen 无观察记录时）", () => {
		assert.equal(computeRunMetrics(input({ rejectionRate: null })).rejectionRate, null);
	});
});

describe("percentile / p95（辅助函数）", () => {
	it("空数组 → null", () => {
		assert.equal(p95([]), null);
		assert.equal(percentile([], 0.5), null);
	});

	it("单元素 → 该元素", () => {
		assert.equal(p95([42]), 42);
	});

	it("线性插值：P50 of [10,20,30,40,50] = 30", () => {
		assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
	});

	it("P0 → 最小值，P100 → 最大值", () => {
		assert.equal(percentile([10, 20, 30, 40, 50], 0), 10);
		assert.equal(percentile([10, 20, 30, 40, 50], 1), 50);
	});

	it("p95 不修改原数组（排序在副本上做）", () => {
		const arr = [50, 40, 30, 20, 10];
		p95(arr);
		assert.deepEqual(arr, [50, 40, 30, 20, 10], "原数组不变");
	});
});

describe("A/B 对比语义（设计 §3.8 验收）", () => {
	it("有代理 vs 无代理基线：利用率应更高（代理裁剪了浪费）", () => {
		// 基线（无代理，FIFO 硬撞）
		const baseline = computeRunMetrics(input({
			consumedSec: 100,
			effectiveSec: 50, // 半数配额浪费在失败重试
			wastedSec: 50,
			completedCount: 5,
			failedCount: 5,
			rejectionRate: null, // 无代理无被拒率
		}));
		// 有代理（L2 守卫 + 降级建议）
		const agent = computeRunMetrics(input({
			consumedSec: 100,
			effectiveSec: 85, // 代理提前降级，减少浪费
			wastedSec: 15,
			completedCount: 8,
			failedCount: 2,
			rejectionRate: 0.05, // 被拒率低 = 指挥合理
		}));
		assert.ok(agent.quotaUtilization! > baseline.quotaUtilization!, "代理利用率应高于基线");
		assert.ok(agent.wasteRate! < baseline.wasteRate!, "代理浪费率应低于基线");
		assert.ok(agent.effectiveThroughput! > baseline.effectiveThroughput!, "代理吞吐应更高");
	});
});

describe("shotSeconds（度量真实秒数，2026-08-30 失真修复）", () => {
	const script = { shots: [{ id: "SH01", durationSec: 3 }, { id: "SH02", durationSec: 8 }, { id: "SH03" }] };

	it("按 script 真实镜长求和（3–12s 档位不得被 5s 常量抹平）", () => {
		const s = shotSeconds(script, ["SH01", "SH02"], ["SH03"]);
		assert.equal(s.effectiveSec, 11, "3+8=11，而非 2×5=10");
		assert.equal(s.wastedSec, 5, "SH03 无镜长 → 回落 5");
	});

	it("script 缺失 → 全部回落 5s/镜（老 run 兼容）", () => {
		const s = shotSeconds(null, ["SH01", "SH02"], ["SH03"]);
		assert.equal(s.effectiveSec, 10);
		assert.equal(s.wastedSec, 5);
	});

	it("未知镜头 id → 回落 5s/镜", () => {
		const s = shotSeconds(script, ["SH99"], []);
		assert.equal(s.effectiveSec, 5);
	});
});
