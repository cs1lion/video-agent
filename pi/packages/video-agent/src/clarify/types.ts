/**
 * Clarifier 类型定义 —— 前期访谈（grill）与富化简报（doc）的核心数据结构。
 *
 * 数据流：Brief（一句话需求）
 *   → 访谈（10 条固定风格界限题 + 5 条按需求定制的 LLM 题）→ Intent（维度/题目 → 答案）
 *   → GenerationDirectives（各生成阶段的 prompt 注入指令）
 *   → EnrichedBrief（交给管线的最终文档，可附 GenerationOptions）。
 */

import type { GenerationOptions } from "../generation/options.ts";

/** 访谈答案 id：英文 slug，跨会话稳定，供下游 prompt 与日志引用 */
export type AnswerId = string;

/** UI / 访谈语言（中英可选） */
export type Locale = "zh" | "en";

/** 双语文案：zh 面向中文用户，en 面向英文用户 */
export interface L10nText {
	zh: string;
	en: string;
}

/** 15 个意图维度（与题库一一对应） */
export type IntentKey =
	| "primaryEmotion"
	| "visualStyle"
	| "subjectFocus"
	| "lighting"
	| "pacing"
	| "colorPalette"
	| "music"
	| "narratorVoice"
	| "cameraLanguage"
	| "storyArc"
	| "referenceEnergy"
	| "onScreenText"
	| "ctaStrength"
	| "handModel"
	| "soundDesign";

/** 访谈答案：维度 → 选项 id。未答的维度缺省（管线行为保持不变）。
 *  固定题以 IntentKey 为键；LLM 定制题（source=generated）以题目 id 为键。 */
export type Intent = Partial<Record<IntentKey, AnswerId>> & {
	[generatedKey: string]: AnswerId | undefined;
};

/** 问题权重：固定 10 题承载风格界限（core/refinement），定制题一律 tailored */
export type QuestionWeight = "core" | "refinement" | "tailored";

/** 一个可选项（双语展示 + 英文 prompt 关键词） */
export interface QuestionOption {
	/** 选项 id：英文 slug，稳定 */
	id: AnswerId;
	/** 选项文案（双语，用户可切换） */
	label: L10nText;
	/** 一行说明：选了它成片大概是什么效果（双语） */
	hint: L10nText;
	/** 注入下游生成 prompt 的英文关键词（生成模型对英文更稳） */
	promptTags: string[];
}

/** 一道访谈题 */
export interface Question {
	/** 题目 id（英文 slug） */
	id: string;
	/** 对应的意图维度；LLM 定制题可缺省（以题目 id 作为 intent 键） */
	intentKey?: IntentKey;
	/** 类别标签（双语，UI 分组用） */
	category: L10nText;
	/** 问题文案（双语） */
	text: L10nText;
	/** 3-5 个选项 */
	options: QuestionOption[];
	/** 权重：固定题 core/refinement，定制题 tailored */
	weight: QuestionWeight;
	/** 来源：fixed = 内置题库；generated = LLM 按需求定制（含失败降级的通用题） */
	source: "fixed" | "generated";
	/** 定制题答案注入的目标阶段（缺省按 intentKey 在 STAGE_SOURCES 中归桶） */
	stage?: DirectiveStage;
}

/** 原始创作简报（访谈之前用户给出的内容） */
export interface Brief {
	creative: {
		/** 一句话需求：目前唯一的叙事起点 */
		logline: string;
		/** 补充卖点 / 关键信息（可选） */
		keyMessage?: string;
	};
	/** 时长预设（可选，来自 UI 下拉） */
	durationPreset?: string;
	/** 画幅预设（可选，来自 UI 下拉） */
	aspectPreset?: string;
}

/** 访谈流水条目 */
export interface InterviewLogEntry {
	questionId: string;
	answerId: string;
	/** ISO 时间戳 */
	ts: string;
}

/** 一个生成阶段的注入指令 */
export interface Directive {
	/** 注入该阶段 prompt 的英文片段（逗号分隔关键词）；空串 = 不注入、行为不变 */
	promptFragment: string;
	/** 贡献本片段的意图维度 */
	sources: IntentKey[];
}

/** 五个消费指令的生成阶段 */
export type DirectiveStage = "script" | "visual" | "clips" | "audio" | "export";

/** 各阶段的指令集合 */
export interface GenerationDirectives {
	/** 剧本：节奏、旁白、故事弧线、屏幕文字 */
	script: Directive;
	/** 美术设计：色彩、光线、情绪、风格 */
	visual: Directive;
	/** 镜头 prompt：运镜、主体、参考气质、手部出镜 */
	clips: Directive;
	/** 音频：音乐底床、声音设计 */
	audio: Directive;
	/** 导出：字幕/叠加规则、CTA 力度 */
	export: Directive;
}

/** 共创空间沉淀的人物形象（共创模式产出，进入美术设计与全阶段 prompt） */
export interface CoCharacter {
	name: string;
	description: string;
}

/** 共创空间沉淀的场景设定 */
export interface CoScene {
	name: string;
	description: string;
}

/** 共创空间：对话中沉淀的设定资产（最小可用集） */
export interface CoCreationSpace {
	characters: CoCharacter[];
	scenes: CoScene[];
	/** 创意情节 / 卖点节拍（一句话一条） */
	ideas: string[];
	/** 背景音乐简报（风格/乐器/节奏意图；暂无音乐生成模型，先作为交付说明落盘） */
	musicBrief?: string;
}

/** 访谈完成后的富化简报：交给管线的最终文档 */
export interface EnrichedBrief extends Brief {
	/** 用户访谈答案 */
	intent: Intent;
	/** 各生成阶段的 prompt 注入指令 */
	generationDirectives: GenerationDirectives;
	/** 访谈流水 */
	interviewLog: InterviewLogEntry[];
	/** 生成质量选项（可选：分辨率/画幅/负向提示词等，UI 采集） */
	generationOptions?: GenerationOptions;
	/** 共创空间（可选：共创模式沉淀的人物/场景/情节与音乐简报） */
	coSpace?: CoCreationSpace;
}
