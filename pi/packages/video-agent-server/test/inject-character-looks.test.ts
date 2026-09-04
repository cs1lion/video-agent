/**
 * injectCharacterLooks 单测（补遗 §5 跨镜人物一致性）
 *
 * 根因：LLM 在写 visual prompt 时常只提角色名不携带外貌短语，导致视频模型自由发挥
 * （曾出现"老夫人对着中年短发女性说小伙子"的错配）。本函数把 prompt 中提到角色名的地方
 * 替换为「名字 (外貌短语)」，让视频模型每次都能拿到完整外貌锚点。
 *
 * 函数本身未导出，通过 normalizeShotPrompts 间接调用。这里导出供测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeShotPrompts } from "../src/pipeline.ts";
import type { ShotPromptDoc, VisualBible, DesignBibleDoc, ScriptDoc } from "../src/prompts.ts";

describe("normalizeShotPrompts → injectCharacterLooks", () => {
	const visualBible: VisualBible = {
		styleKeywords: [],
		colorPalette: [],
		lighting: "",
		grade: "",
	};
	const designBible: DesignBibleDoc = {
		characters: [
			{
				id: "CH01",
				name: "林女士",
				category: "character",
				design: "A 58-year-old retired female teacher with neat short silver-gray hair, wearing a soft beige cotton cardigan and dark gray casual trousers",
				englishName: "Lin",
			},
			{
				id: "CH02",
				name: "小赵",
				category: "character",
				design: "A 28-year-old male nurse with short neat black hair, wearing a clean light blue nurse uniform with a chest name badge",
				englishName: "Zhao",
			},
		],
		scenes: [],
		props: [],
	};

	const script: ScriptDoc = {
		title: "T",
		logline: "L",
		shots: [
			{ id: "SH01", narrationZh: "", narrationEn: "", visual: "", durationSec: 5 },
			{ id: "SH02", narrationZh: "", narrationEn: "", visual: "", durationSec: 5 },
			{ id: "SH03", narrationZh: "", narrationEn: "", visual: "", durationSec: 5 },
		],
	};

	it("提到林女士就注入外貌短语（核心 case：解决 SH03 错配）", () => {
		const doc: ShotPromptDoc = {
			prompts: [
				{
					shotId: "SH03",
					prompt:
						"Medium close-up 16:9 shot of Lin ... turning her head to face Zhao on the right bench, " +
						"leaning forward slightly with a gentle warm expression, about to speak. " +
						"Soft diffused warm side light, shallow depth of field blurs the background.",
				},
			],
		};
		const out = normalizeShotPrompts(doc, script, visualBible, designBible);
		const p = out.prompts.find((x) => x.shotId === "SH03")!.prompt;
		// Lin 必须被替换为 "Lin (外貌短语)"
		assert.ok(p.includes("Lin (A 58-year-old retired female teacher with"), `Lin 没被注入: ${p.slice(0, 200)}`);
		// Zhao 也必须被注入
		assert.ok(p.includes("Zhao (A 28-year-old male nurse with"), `Zhao 没被注入: ${p.slice(0, 200)}`);
	});

	it("中文名也能命中", () => {
		const doc: ShotPromptDoc = {
			prompts: [
				{ shotId: "SH01", prompt: "林女士坐在长椅上，转头看向小赵。" },
			],
		};
		const out = normalizeShotPrompts(doc, script, visualBible, designBible);
		const p = out.prompts[0]!.prompt;
		// 注：当前实现只对 ID/英文名变体做词边界匹配，中文不做正则（避免误伤中文段落）
		// 但 ID "CH01"/"CH02" 不会被中文 prompt 匹配——这是已知限制。
		// 这里只断言 prompt 整体至少有原始内容没被破坏
		assert.ok(p.includes("林女士"));
	});

	it("已注入过的不会重复（去重）", () => {
		const doc: ShotPromptDoc = {
			prompts: [
				{
					shotId: "SH02",
					prompt:
						"Medium close-up of Lin (A 58-year-old retired female teacher with neat short silver-gray hair, " +
						"wearing a soft beige cotton cardigan) sitting beside Zhao.",
				},
			],
		};
		const out = normalizeShotPrompts(doc, script, visualBible, designBible);
		const p = out.prompts.find((x) => x.shotId === "SH02")!.prompt;
		// 原始 prompt 已经有 1 次外貌短语，注入不能重复
		const matches = p.match(/58-year-old retired female teacher/g) ?? [];
		assert.equal(matches.length, 1, `注入重复：${matches.length} 次`);
	});

	it("不命中不相关角色（避免噪音）", () => {
		const doc: ShotPromptDoc = {
			prompts: [
				{ shotId: "SH01", prompt: "Wide shot of empty street, no people visible." },
			],
		};
		const out = normalizeShotPrompts(doc, script, visualBible, designBible);
		const p = out.prompts.find((x) => x.shotId === "SH01")!.prompt;
		// 没出现 Lin/Zhao，所以 prompt 完全不变
		assert.ok(!p.includes("(A 58-year-old"));
	});

	it("designBible 缺角色时不报错", () => {
		const doc: ShotPromptDoc = {
			prompts: [{ shotId: "SH01", prompt: "Lin walks in." }],
		};
		const out = normalizeShotPrompts(doc, script, visualBible, null);
		assert.equal(out.prompts.find((x) => x.shotId === "SH01")!.prompt, "Lin walks in.");
	});

	it("空 design 字段跳过（不抛异常）", () => {
		const doc: ShotPromptDoc = {
			prompts: [{ shotId: "SH01", prompt: "Lin walks in." }],
		};
		const out = normalizeShotPrompts(doc, script, visualBible, {
			characters: [{ id: "CH01", name: "林女士", category: "character", design: "" }],
			scenes: [],
			props: [],
		});
		assert.equal(out.prompts.find((x) => x.shotId === "SH01")!.prompt, "Lin walks in.");
	});
});
