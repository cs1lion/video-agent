import { describe, expect, test } from "vitest";
import { Clarifier } from "../src/clarify/clarifier.ts";
import { buildDirectives, intentFromLog } from "../src/clarify/directives.ts";
import {
	FALLBACK_TAILORED_QUESTIONS,
	FIXED_QUESTION_COUNT,
	QUESTION_COUNT,
	QUESTIONS,
	TAILORED_QUESTION_COUNT,
} from "../src/clarify/questions.ts";
import type { Brief, Intent, IntentKey } from "../src/clarify/types.ts";

const BRIEF: Brief = {
	creative: {
		logline: "推广我的新款跑鞋，售价 120 美元，面向都市 20 多岁的年轻人",
		keyMessage: "轻量缓震，通勤夜跑两相宜",
	},
	durationPreset: "15s",
	aspectPreset: "16:9",
};

/** 注入降级定制题后依次答完全部题目（每题选第一个选项） */
function answerAll(clarifier: Clarifier): Clarifier {
	clarifier.installTailored(null);
	for (;;) {
		const question = clarifier.currentQuestion();
		if (!question) break;
		clarifier.answer(question.options[0].id);
	}
	return clarifier;
}

describe("题库结构", () => {
	test("10 条固定风格界限题，总轮次 = 固定 + 定制目标数", () => {
		expect(QUESTIONS).toHaveLength(FIXED_QUESTION_COUNT);
		expect(FIXED_QUESTION_COUNT).toBe(10);
		expect(QUESTION_COUNT).toBe(FIXED_QUESTION_COUNT + TAILORED_QUESTION_COUNT);
		for (const question of QUESTIONS) {
			expect(question.options.length).toBeGreaterThanOrEqual(4);
			expect(question.options.length).toBeLessThanOrEqual(5);
			expect(question.source).toBe("fixed");
		}
	});

	test("固定题 id 与意图维度一一对应且唯一", () => {
		const ids = new Set(QUESTIONS.map((q) => q.id));
		const intentKeys = new Set(QUESTIONS.map((q) => q.intentKey));
		expect(ids.size).toBe(QUESTIONS.length);
		expect(intentKeys.size).toBe(QUESTIONS.length);
	});

	test("前 5 题为 core，其余为 refinement（固定题不出现 tailored）", () => {
		for (const [i, question] of QUESTIONS.entries()) {
			expect(question.weight).toBe(i < 5 ? "core" : "refinement");
		}
	});

	test("选项 id 在题内唯一，双语 label/hint 与 promptTags 非空", () => {
		for (const question of [...QUESTIONS, ...FALLBACK_TAILORED_QUESTIONS]) {
			const optionIds = new Set(question.options.map((o) => o.id));
			expect(optionIds.size).toBe(question.options.length);
			for (const option of question.options) {
				expect(option.label.zh.trim().length).toBeGreaterThan(0);
				expect(option.label.en.trim().length).toBeGreaterThan(0);
				expect(option.hint.zh.trim().length).toBeGreaterThan(0);
				expect(option.promptTags.length).toBeGreaterThan(0);
			}
			expect(question.text.zh.trim().length).toBeGreaterThan(0);
			expect(question.category.zh.trim().length).toBeGreaterThan(0);
		}
	});
});

describe("Clarifier 状态机", () => {
	test("初始状态指向第一题", () => {
		const clarifier = new Clarifier(BRIEF);
		const snapshot = clarifier.snapshot;
		expect(snapshot.phase).toBe("interviewing");
		expect(snapshot.questionId).toBe(QUESTIONS[0].id);
		expect(snapshot.askedCount).toBe(1);
		expect(snapshot.answeredCount).toBe(0);
		expect(snapshot.totalQuestions).toBe(QUESTION_COUNT);
		expect(clarifier.currentQuestion()?.id).toBe(QUESTIONS[0].id);
		expect(clarifier.isDone()).toBe(false);
	});

	test("答完固定 10 题后需要注入定制题；注入后可答完 15 题", () => {
		const clarifier = new Clarifier(BRIEF);
		for (let i = 0; i < FIXED_QUESTION_COUNT; i++) {
			clarifier.answer(QUESTIONS[i].options[0].id);
		}
		expect(clarifier.needsTailored()).toBe(true);
		expect(clarifier.currentQuestion()).toBeNull();
		// LLM 失败 → null 触发内置降级题
		clarifier.installTailored(null);
		expect(clarifier.needsTailored()).toBe(false);
		expect(clarifier.snapshot.tailored).toHaveLength(TAILORED_QUESTION_COUNT);
		expect(clarifier.snapshot.totalQuestions).toBe(QUESTION_COUNT);
		const snapshot = answerAll(clarifier).snapshot;
		expect(snapshot.phase).toBe("done");
		expect(snapshot.answeredCount).toBe(QUESTION_COUNT);
		expect(clarifier.currentQuestion()).toBeNull();
	});

	test("无效选项抛错", () => {
		const clarifier = new Clarifier(BRIEF);
		expect(() => clarifier.answer("no-such-option")).toThrow(/无效选项/);
	});

	test("结束后再作答抛错", () => {
		const clarifier = answerAll(new Clarifier(BRIEF));
		expect(() => clarifier.answer(QUESTIONS[0].options[0].id)).toThrow(/访谈已结束/);
	});

	test("skip 后立即结束，保留已答内容", () => {
		const clarifier = new Clarifier(BRIEF);
		clarifier.answer(QUESTIONS[0].options[0].id);
		clarifier.answer(QUESTIONS[1].options[1].id);
		const snapshot = clarifier.skip();
		expect(snapshot.phase).toBe("done");
		expect(snapshot.skipped).toBe(true);
		expect(snapshot.answeredCount).toBe(2);
		expect(clarifier.currentQuestion()).toBeNull();
	});

	test("单题跳过：推进但不记录答案，该维度不注入", () => {
		const clarifier = new Clarifier(BRIEF);
		clarifier.skipCurrent(); // 跳过第 1 题（primaryEmotion）
		expect(clarifier.snapshot.answeredCount).toBe(0);
		expect(clarifier.snapshot.skippedIds).toEqual([QUESTIONS[0].id]);
		expect(clarifier.currentQuestion()?.id).toBe(QUESTIONS[1].id);
		clarifier.installTailored(null);
		for (;;) {
			const question = clarifier.currentQuestion();
			if (!question) break;
			clarifier.answer(question.options[0].id);
		}
		const enriched = clarifier.compose();
		expect(enriched.intent.primaryEmotion).toBeUndefined();
		expect(Object.keys(enriched.intent)).toHaveLength(QUESTION_COUNT - 1);
	});

	test("全部单题跳过也能正常结束并产出空意图简报", () => {
		const clarifier = new Clarifier(BRIEF);
		clarifier.installTailored(null);
		for (;;) {
			const question = clarifier.currentQuestion();
			if (!question) break;
			clarifier.skipCurrent();
		}
		expect(clarifier.isDone()).toBe(true);
		const enriched = clarifier.compose();
		expect(enriched.intent).toEqual({});
		expect(enriched.interviewLog).toEqual([]);
	});

	test("单题跳过跨快照恢复后进度不回退", () => {
		const first = new Clarifier(BRIEF);
		first.skipCurrent();
		first.answer(QUESTIONS[1].options[0].id);
		const restored = new Clarifier(BRIEF, JSON.parse(JSON.stringify(first.snapshot)));
		expect(restored.snapshot.questionId).toBe(QUESTIONS[2].id);
		expect(restored.snapshot.skippedIds).toEqual([QUESTIONS[0].id]);
		expect(restored.snapshot.answeredCount).toBe(1);
	});
});

describe("compose 富化简报", () => {
	test("全量作答：intent 覆盖全部题目（含定制题），各阶段指令非空", () => {
		const clarifier = answerAll(new Clarifier(BRIEF));
		const enriched = clarifier.compose();
		expect(Object.keys(enriched.intent)).toHaveLength(QUESTION_COUNT);
		for (const stage of ["script", "visual", "clips", "audio", "export"] as const) {
			const directive = enriched.generationDirectives[stage];
			expect(directive.promptFragment.length).toBeGreaterThan(0);
			expect(directive.sources.length).toBeGreaterThan(0);
		}
	});

	test("保留原 Brief 字段", () => {
		const enriched = answerAll(new Clarifier(BRIEF)).compose();
		expect(enriched.creative.logline).toBe(BRIEF.creative.logline);
		expect(enriched.creative.keyMessage).toBe(BRIEF.creative.keyMessage);
		expect(enriched.durationPreset).toBe("15s");
		expect(enriched.aspectPreset).toBe("16:9");
	});

	test("未答维度不注入（行为不变原则）", () => {
		const clarifier = new Clarifier(BRIEF);
		// 只答第 1 题（primaryEmotion），然后跳过
		clarifier.answer(QUESTIONS[0].options[0].id);
		clarifier.skip();
		const enriched = clarifier.compose();

		expect(Object.keys(enriched.intent)).toEqual(["primaryEmotion"]);
		const emotionTags = QUESTIONS[0].options[0].promptTags.join(", ");
		expect(enriched.generationDirectives.visual.promptFragment).toBe(emotionTags);
		// script 只消费 pacing/narratorVoice/storyArc，均未答 → 空
		expect(enriched.generationDirectives.script.promptFragment).toBe("");
		expect(enriched.generationDirectives.script.sources).toEqual([]);
	});

	test("直接跳过：所有指令为空，interviewLog 为空", () => {
		const clarifier = new Clarifier(BRIEF);
		clarifier.skip();
		const enriched = clarifier.compose();
		expect(enriched.intent).toEqual({});
		expect(enriched.interviewLog).toEqual([]);
		for (const stage of ["script", "visual", "clips", "audio", "export"] as const) {
			expect(enriched.generationDirectives[stage].promptFragment).toBe("");
		}
	});

	test("interviewLog 记录题目/答案对与 ISO 时间戳", () => {
		const clarifier = new Clarifier(BRIEF);
		clarifier.answer(QUESTIONS[0].options[2].id);
		const log = clarifier.compose().interviewLog;
		expect(log).toHaveLength(1);
		expect(log[0].questionId).toBe(QUESTIONS[0].id);
		expect(log[0].answerId).toBe(QUESTIONS[0].options[2].id);
		expect(Number.isNaN(Date.parse(log[0].ts))).toBe(false);
	});

	test("compose 可携带生成质量选项", () => {
		const clarifier = answerAll(new Clarifier(BRIEF));
		const enriched = clarifier.compose({
			resolution: "1080p",
			aspectRatio: "9:16",
			shotCount: 5,
			clipDurationSec: 5,
			fps: 30,
			motionIntensity: "low",
			detailBoost: false,
			promptLanguage: "en",
			negativePrompt: "watermark, blur",
			seed: 42,
		});
		expect(enriched.generationOptions?.resolution).toBe("1080p");
		expect(enriched.generationOptions?.seed).toBe(42);
		// 不传时不产生该字段（additive 原则）
		expect(answerAll(new Clarifier(BRIEF)).compose().generationOptions).toBeUndefined();
	});

	test("定制题答案按声明阶段归桶注入", () => {
		const clarifier = new Clarifier(BRIEF);
		clarifier.installTailored([
			{
				id: "",
				category: { zh: "主角", en: "Subject" },
				text: { zh: "镜头主角是什么？", en: "Who is the hero?" },
				options: [
					{
						id: "cat-hero",
						label: { zh: "一只猫", en: "A cat" },
						hint: { zh: "猫当主角", en: "Cat as hero" },
						promptTags: ["feline protagonist"],
					},
					{
						id: "robot",
						label: { zh: "机器人", en: "Robot" },
						hint: { zh: "", en: "" },
						promptTags: ["robot hero"],
					},
				],
				weight: "tailored",
				source: "generated",
				stage: "visual",
			},
		]);
		// 答到第 11 题（第一道定制题）
		for (let i = 0; i < FIXED_QUESTION_COUNT; i++) clarifier.answer(QUESTIONS[i].options[0].id);
		const dyn = clarifier.currentQuestion();
		expect(dyn?.id).toBe("dyn-1");
		expect(dyn?.weight).toBe("tailored");
		clarifier.answer("cat-hero");
		const visual = clarifier.compose().generationDirectives.visual;
		expect(visual.promptFragment).toContain("feline protagonist");
		expect(visual.sources).toContain("dyn-1");
	});
});

describe("snapshot 序列化往返", () => {
	test("快照可 JSON 往返并恢复继续作答", () => {
		const first = new Clarifier(BRIEF);
		for (let i = 0; i < 7; i++) {
			first.answer(QUESTIONS[i].options[i % QUESTIONS[i].options.length].id);
		}
		const serialized = JSON.parse(JSON.stringify(first.snapshot));

		const restored = new Clarifier(BRIEF, serialized);
		expect(restored.snapshot.answeredCount).toBe(7);
		expect(restored.snapshot.questionId).toBe(QUESTIONS[7].id);
		expect(restored.isDone()).toBe(false);

		// 恢复后继续答完，与一路答到底的最终 intent 一致
		const expected: Intent = {};
		for (let i = 0; i < 7; i++) {
			const question = QUESTIONS[i];
			expected[question.intentKey ?? question.id] = question.options[i % question.options.length].id;
		}
		restored.installTailored(null);
		for (;;) {
			const question = restored.currentQuestion();
			if (!question) break;
			restored.answer(question.options[0].id);
			expected[question.intentKey ?? question.id] = question.options[0].id;
		}
		expect(restored.isDone()).toBe(true);
		expect(restored.compose().intent).toEqual(expected);
	});

	test("恢复时过滤非法答案（未知题目/未知选项/重复作答）", () => {
		const snapshot = {
			phase: "interviewing" as const,
			questionId: QUESTIONS[0].id,
			askedCount: 1,
			answeredCount: 3,
			totalQuestions: QUESTION_COUNT,
			skipped: false,
			tailored: [],
			answers: [
				{ questionId: "not-a-question", answerId: "x", ts: "2026-01-01T00:00:00.000Z" },
				{ questionId: QUESTIONS[0].id, answerId: "not-an-option", ts: "2026-01-01T00:00:00.000Z" },
				{ questionId: QUESTIONS[1].id, answerId: QUESTIONS[1].options[0].id, ts: "2026-01-01T00:00:01.000Z" },
				{ questionId: QUESTIONS[1].id, answerId: QUESTIONS[1].options[1].id, ts: "2026-01-01T00:00:02.000Z" },
			],
		};
		const restored = new Clarifier(BRIEF, snapshot);
		expect(restored.snapshot.answeredCount).toBe(1);
		// 乱序/缺失中间题时按题库顺序重排：已答第 2 题 → 当前回到第 1 题
		expect(restored.snapshot.questionId).toBe(QUESTIONS[0].id);
	});

	test("快照携带的定制题可恢复续答", () => {
		const first = new Clarifier(BRIEF);
		first.installTailored(null);
		for (let i = 0; i < FIXED_QUESTION_COUNT + 2; i++) {
			const question = first.currentQuestion();
			if (!question) break;
			first.answer(question.options[0].id);
		}
		const restored = new Clarifier(BRIEF, JSON.parse(JSON.stringify(first.snapshot)));
		expect(restored.snapshot.tailored).toHaveLength(TAILORED_QUESTION_COUNT);
		expect(restored.snapshot.answeredCount).toBe(FIXED_QUESTION_COUNT + 2);
		expect(restored.currentQuestion()?.id).toBe("dyn-3");
	});

	test("跳过状态可恢复", () => {
		const first = new Clarifier(BRIEF);
		first.answer(QUESTIONS[0].options[0].id);
		first.skip();
		const restored = new Clarifier(BRIEF, JSON.parse(JSON.stringify(first.snapshot)));
		expect(restored.isDone()).toBe(true);
		expect(restored.snapshot.skipped).toBe(true);
		expect(restored.compose().intent).toEqual({ primaryEmotion: QUESTIONS[0].options[0].id });
	});
});

describe("directives 编译器", () => {
	test("固定题各阶段消费的维度与归桶一致（export 由定制题供给）", () => {
		const intent: Intent = {};
		for (const question of QUESTIONS) {
			intent[question.intentKey ?? question.id] = question.options[0].id;
		}
		const directives = buildDirectives(intent);
		const sorted = (keys: readonly IntentKey[]) => [...keys].sort().join(",");
		expect(sorted(directives.script.sources)).toBe(sorted(["pacing", "narratorVoice", "storyArc"]));
		expect(sorted(directives.visual.sources)).toBe(
			sorted(["colorPalette", "lighting", "primaryEmotion", "visualStyle"]),
		);
		expect(sorted(directives.clips.sources)).toBe(sorted(["cameraLanguage"]));
		expect(sorted(directives.audio.sources)).toBe(sorted(["music", "soundDesign"]));
		expect(directives.export.promptFragment).toBe("");
		expect(directives.export.sources).toEqual([]);
	});

	test("promptFragment 只包含所选选项的 tags", () => {
		const clarifier = new Clarifier(BRIEF);
		// 第 8 题（index 7）music 选「无音乐」，第 10 题（index 9）sound 选「混合」
		for (let i = 0; i < 7; i++) clarifier.answer(QUESTIONS[i].options[0].id);
		clarifier.answer("none");
		clarifier.answer(QUESTIONS[8].options[0].id);
		clarifier.answer("mixed");
		const audio = clarifier.compose().generationDirectives.audio;
		expect(audio.promptFragment).toBe("no music bed, mixed sound design, layered audio");
		expect(audio.sources).toEqual(["music", "soundDesign"]);
	});

	test("intentFromLog 忽略无效流水条目", () => {
		const intent = intentFromLog([
			{ questionId: QUESTIONS[0].id, answerId: QUESTIONS[0].options[1].id },
			{ questionId: "bogus", answerId: "bogus" },
		]);
		expect(intent).toEqual({ primaryEmotion: QUESTIONS[0].options[1].id });
	});
});
