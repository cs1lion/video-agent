/**
 * P3-S6 · 状态锚点注记契约测试（reshot instruction + QA 核对）。
 * 变异语义：拿掉 plannedEndNote 的任一字段分支 → 对应用例红；
 * 拿掉 storyboardStateNotes 的 unobservable 跳过 → 遮挡镜用例红。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plannedEndNote, storyboardStateNotes } from "../src/storyboard-state.ts";
import type { StoryboardDoc } from "../src/prompts.ts";

describe("plannedEndNote（reshot 结束状态锚点）", () => {
	it("holding/position/facing 组合成中文锚点句", () => {
		const note = plannedEndNote({
			shotId: "SH02",
			start: {},
			end: { holding: [{ entityId: "PR01", hand: "right" }], position: "走廊", facing: "北" },
		});
		assert.ok(note.includes("该镜结束状态必须保持"));
		assert.ok(note.includes("PR01 在右手"));
		assert.ok(note.includes("位置在 走廊"));
		assert.ok(note.includes("朝向 北"));
	});

	it("both 手与缺省 folded 都正确兜底", () => {
		assert.ok(plannedEndNote({ shotId: "S", start: {}, end: { holding: [{ entityId: "PR01", hand: "both" }] } }).includes("双手"));
		assert.equal(plannedEndNote(undefined), "");
		assert.equal(plannedEndNote({ shotId: "S", start: {}, end: {} }), "");
	});
});

describe("storyboardStateNotes（QA 状态核对注记）", () => {
	const doc: StoryboardDoc = {
		version: 1,
		shots: [
			{ shotId: "SH01", action: "", plan: { start: {}, end: { holding: [{ entityId: "PR01", hand: "left" }] } } },
			{ shotId: "SH02", action: "", plan: { start: {}, end: {} } },
			{ shotId: "SH03", action: "", plan: { start: {}, end: { position: "咖啡店", unobservable: true } } },
		],
	};

	it("只对计划了可核对状态的镜生成注记；空结束态与 unobservable 跳过", () => {
		const notes = storyboardStateNotes(doc);
		assert.deepEqual(Object.keys(notes), ["SH01"]);
		assert.ok(notes["SH01"]!.includes("PR01 应在左手"));
	});

	it("继承折叠生效：SH02 缺省继承 SH01 的持有关系", () => {
		const doc2: StoryboardDoc = {
			version: 1,
			shots: [
				{ shotId: "SH01", action: "", plan: { start: {}, end: { holding: [{ entityId: "PR01", hand: "left" }] } } },
				{ shotId: "SH02", action: "", plan: { start: {}, end: { facing: "东" } } },
			],
		};
		const notes = storyboardStateNotes(doc2);
		assert.ok(notes["SH02"]!.includes("PR01 应在左手"), "缺省字段经 R1 折叠继承");
		assert.ok(notes["SH02"]!.includes("朝向应为 东"));
	});
});
