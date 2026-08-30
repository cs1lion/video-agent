/**
 * QA 折叠纯函数契约测试 —— 六轴集合与顺序是 UI 评分条 / 度量对比 / 重做归因的展示契约，
 * 顺序一变前端轴位就错；夹取语义锁「非法值保守按 0」。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldQaAxes } from "../src/qa/review.ts";

describe("foldQaAxes（QA 七轴折叠）", () => {
	it("合法输入 → 七轴按序输出，audioSync 独立透传", () => {
		const axes = foldQaAxes(
			{ briefFit: 90, visualConsistency: 80, pacing: 70, physicalAccuracy: 85, characterConsistency: 88, textQuality: 95 },
			100,
		);
		assert.deepEqual(
			axes.map((a) => a.id),
			["briefFit", "visualConsistency", "pacing", "physicalAccuracy", "characterConsistency", "audioSync", "textQuality"],
			"轴顺序是 UI 展示契约：人物一致性在物理之后、声画同步之前",
		);
		assert.deepEqual(
			axes.map((a) => a.score),
			[90, 80, 70, 85, 88, 100, 95],
		);
	});

	it("非法值（NaN/负数/超界/字符串）→ 保守夹取 0 或 100，不得虚高", () => {
		const axes = foldQaAxes(
			{ briefFit: Number.NaN, visualConsistency: -5, pacing: 180, physicalAccuracy: "72", characterConsistency: undefined, textQuality: undefined },
			66.6,
		);
		const byId = new Map(axes.map((a) => [a.id, a.score]));
		assert.equal(byId.get("briefFit"), 0, "NaN 按 0（模型漏字段 = 保守暴露）");
		assert.equal(byId.get("visualConsistency"), 0, "负数夹到 0");
		assert.equal(byId.get("pacing"), 100, "超界夹到 100");
		assert.equal(byId.get("physicalAccuracy"), 72, "数字字符串可解析");
		assert.equal(byId.get("characterConsistency"), 0, "undefined 按 0");
		assert.equal(byId.get("textQuality"), 0, "undefined 按 0");
		assert.equal(byId.get("audioSync"), 67, "audioSync 四舍五入");
	});

	it("全空返回（旧模型/异常响应）→ 七轴仍在、全 0，不得缺轴", () => {
		const axes = foldQaAxes({}, 0);
		assert.equal(axes.length, 7);
		assert.ok(axes.every((a) => a.score === 0));
	});
});
