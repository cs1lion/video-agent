/**
 * 意图 → 各生成阶段指令的编译器。
 *
 * 固定题：按 STAGE_SOURCES 把维度分桶到五个阶段；
 * 定制题（source=generated）：优先用题目自带的 stage 归桶，缺省回退
 * intentKey 的桶。每个阶段产出一段英文 prompt 片段（由所选选项的
 * promptTags 拼接）。未答的维度不产生任何注入 —— 管线行为保持不变。
 */

import { QUESTIONS } from "./questions.ts";
import type {
	AnswerId,
	Directive,
	DirectiveStage,
	GenerationDirectives,
	Intent,
	IntentKey,
	Question,
	QuestionOption,
} from "./types.ts";

/** 各阶段消费的意图维度（固定题归桶表） */
const STAGE_SOURCES: Record<DirectiveStage, readonly IntentKey[]> = {
	script: ["pacing", "narratorVoice", "storyArc", "onScreenText"],
	visual: ["colorPalette", "lighting", "primaryEmotion", "visualStyle"],
	clips: ["cameraLanguage", "subjectFocus", "referenceEnergy", "handModel"],
	audio: ["music", "soundDesign"],
	export: ["onScreenText", "ctaStrength"],
};

const VALID_STAGES: readonly DirectiveStage[] = ["script", "visual", "clips", "audio", "export"];

/** 定制题的答案注入哪个阶段 */
function stageOfGenerated(question: Question): DirectiveStage | null {
	if (question.stage && VALID_STAGES.includes(question.stage)) return question.stage;
	if (question.intentKey) {
		for (const stage of VALID_STAGES) {
			if (STAGE_SOURCES[stage].includes(question.intentKey)) return stage;
		}
	}
	return null;
}

/** 把 Intent 解析成 题目 → 选中选项 的映射（忽略无效答案） */
function resolveOptions(intent: Intent, questions: readonly Question[]): Map<Question, QuestionOption> {
	const selected = new Map<Question, QuestionOption>();
	for (const question of questions) {
		const key = question.intentKey ?? question.id;
		const answerId = intent[key];
		if (!answerId) continue;
		const option = question.options.find((o) => o.id === answerId);
		if (option) selected.set(question, option);
	}
	return selected;
}

/** 把 Intent 编译为各阶段的注入指令 */
export function buildDirectives(intent: Intent, questions: readonly Question[] = QUESTIONS): GenerationDirectives {
	const selected = resolveOptions(intent, questions);

	const empty = (): Directive => ({ promptFragment: "", sources: [] });
	const directives: Record<DirectiveStage, Directive> = {
		script: empty(),
		visual: empty(),
		clips: empty(),
		audio: empty(),
		export: empty(),
	};

	for (const [question, option] of selected) {
		if (option.promptTags.length === 0) continue;
		let stage: DirectiveStage | null = null;
		if (question.source === "generated") {
			stage = stageOfGenerated(question);
		} else if (question.intentKey) {
			for (const candidate of VALID_STAGES) {
				if (STAGE_SOURCES[candidate].includes(question.intentKey)) {
					stage = candidate;
					break;
				}
			}
		}
		if (!stage) continue;
		const directive = directives[stage];
		directive.sources.push(question.intentKey ?? (question.id as IntentKey));
		directive.promptFragment =
			directive.promptFragment.length > 0
				? `${directive.promptFragment}, ${option.promptTags.join(", ")}`
				: option.promptTags.join(", ");
	}

	return directives;
}

/** 工具：从访谈流水推导 Intent */
export function intentFromLog(
	log: readonly { questionId: string; answerId: AnswerId }[],
	questions: readonly Question[] = QUESTIONS,
): Intent {
	const questionById = new Map(questions.map((q) => [q.id, q]));
	const intent: Intent = {};
	for (const entry of log) {
		const question = questionById.get(entry.questionId);
		if (!question) continue;
		if (!question.options.some((o) => o.id === entry.answerId)) continue;
		intent[question.intentKey ?? question.id] = entry.answerId;
	}
	return intent;
}
