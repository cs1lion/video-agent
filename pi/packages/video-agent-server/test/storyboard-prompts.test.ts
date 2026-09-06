/**
 * P3-S4 · shotPromptMessages 故事板状态块注入契约测试。
 *
 * 锁什么：
 * - 无 storyboard（旧 run）→ 输出不含任何状态块（兼容红线：零行为变化）；
 * - 有 storyboard → 衔接锚点 / 结束状态锚点 / ellipsis 时间注记逐句出现（P3 §9 四段式的服务端形态）；
 * - 默认保持：plan 里没写变化量的镜，不产生状态句（不逐镜复述未变状态）。
 *
 * 变异语义：拿掉 stateBlockOf 任一分支 → 对应用例红；拿掉 storyboard 缺省短路 → 兼容用例红。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shotPromptMessages, type EnrichedBrief, type ScriptDoc, type VisualBible } from "../src/prompts.ts";
import type { GenerationOptions } from "../../../video-agent/src/index.ts";
import type { StoryboardDoc } from "../src/prompts.ts";

const brief = {
	creative: { logline: "一杯咖啡的旅程", keyMessage: "手作温度" },
} as unknown as EnrichedBrief;

const bible: VisualBible = { styleKeywords: ["cinematic"], palette: ["#333"], lighting: "soft", grade: "warm" };

const opts = {
	negativePrompt: "",
	motionIntensity: "medium",
	aspectRatio: "16:9",
	detailBoost: false,
} as unknown as GenerationOptions;

const script: ScriptDoc = {
	title: "咖啡",
	logline: "一杯咖啡的旅程",
	shots: [
		{ id: "SH01", narrationZh: "", narrationEn: "", visual: "a man picks up a red enamel cup", durationSec: 3 },
		{ id: "SH02", narrationZh: "", narrationEn: "", visual: "close-up of hands at the door", durationSec: 2 },
	],
};

const storyboard: StoryboardDoc = {
	version: 1,
	shots: [
		{
			shotId: "SH01",
			action: "右手拿起杯子",
			plan: { start: {}, end: { holding: [{ entityId: "PR01", hand: "right" }] } },
		},
		{
			shotId: "SH02",
			action: "左手伸向门把手",
			relation: { time: "ellipsis", space: "same-location", sound: "none" },
			plan: { start: { holding: [{ entityId: "PR01", hand: "right" }] }, end: {} },
		},
	],
};

const textOf = (...args: Parameters<typeof shotPromptMessages>): string =>
	shotPromptMessages(...args)
		.map((m) => (typeof m.content === "string" ? m.content : ""))
		.join("\n");

describe("shotPromptMessages · 故事板状态块注入（P3-S4）", () => {
	it("无 storyboard：输出不含状态块（旧 run 兼容红线）", () => {
		const text = textOf(brief, script, bible, opts, null);
		assert.ok(!text.includes("状态衔接"), "无 storyboard 不应出现状态块");
		assert.ok(!text.includes("Continuation from previous shot"));
	});

	it("有 storyboard：衔接锚点 + 结束状态锚点 + ellipsis 注记逐句出现", () => {
		const text = textOf(brief, script, bible, opts, null, storyboard);
		assert.ok(text.includes("Continuation from previous shot: PR01 in right hand"), "SH02 衔接锚点");
		assert.ok(text.includes("By the end of this shot: PR01 in right hand"), "SH01 结束状态锚点");
		assert.ok(text.includes("time ellipsis"), "SH02 时间省略注记");
		assert.ok(text.includes("状态衔接"), "状态块标题存在");
	});

	it("默认保持：首镜 SH01 start 为空，不产生 Continuation 衔接锚点（只有 SH02 一处）", () => {
		const text = textOf(brief, script, bible, opts, null, storyboard);
		const cont = text.match(/Continuation from previous shot/g)?.length ?? 0;
		assert.equal(cont, 1, "只有 SH02 有上一镜衔接锚点，SH01 首镜 start 为空不写");
		assert.ok(text.includes("Location at start") === false, "position 未声明就不写（未变化状态一个字不写）");
	});
});
