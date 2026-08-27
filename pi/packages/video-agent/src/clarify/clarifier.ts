/**
 * Clarifier —— 前期访谈状态机（UI 无关）。
 *
 * 结构：10 条固定风格界限题（顺序作答）→ 5 条按需求定制的题目
 * （由 server 调 LLM 生成后 installTailored 注入；失败时 server 注入降级题）。
 * 一次一题（ask）→ 记录答案（collect）→ 全部答完或用户跳过后
 * 可随时 compose 出 EnrichedBrief 交给管线。
 *
 * snapshot 可序列化，供 HTTP API 在客户端与服务端之间往返
 * （POST /api/clarify/next 的 interviewState）。
 */

import type { GenerationOptions } from "../generation/options.ts";
import { buildDirectives, intentFromLog } from "./directives.ts";
import { FALLBACK_TAILORED_QUESTIONS, FIXED_QUESTION_COUNT, QUESTIONS, TAILORED_QUESTION_COUNT } from "./questions.ts";
import type { AnswerId, Brief, EnrichedBrief, Intent, InterviewLogEntry, Question } from "./types.ts";

export type ClarifierPhase = "interviewing" | "done";

/** 可序列化的状态快照 */
export interface ClarifierSnapshot {
	phase: ClarifierPhase;
	/** 当前题目 id；done 时为 null */
	questionId: string | null;
	/** 已提出的问题数（含当前题） */
	askedCount: number;
	/** 已回答的问题数 */
	answeredCount: number;
	/** 题库总数（访谈轮次上限） */
	totalQuestions: number;
	/** 用户是否按了「跳过访谈直接生成」 */
	skipped: boolean;
	/** 访谈流水（按答题顺序） */
	answers: InterviewLogEntry[];
	/** 已单题跳过的题目 id（不记录答案，仅用于恢复时定位进度） */
	skippedIds?: string[];
	/** 已注入的定制题（LLM 生成或降级题；未生成时为空） */
	tailored: Question[];
}

export class Clarifier {
	private readonly brief: Brief;
	private readonly entries: InterviewLogEntry[];
	/** 单题跳过的题目 id（不记录答案；恢复时用于定位进度） */
	private readonly skippedIds: Set<string>;
	/** 定制题（LLM 现场生成 / 降级题），答完固定题后逐题出 */
	private tailored: Question[];
	private index: number;
	private skipped: boolean;

	constructor(brief: Brief, restored?: ClarifierSnapshot) {
		this.brief = brief;
		this.entries = [];
		this.skippedIds = new Set();
		this.tailored = [];
		this.skipped = restored?.skipped ?? false;

		if (restored) {
			this.tailored = restoreTailored(restored.tailored);
			// 只接受合法答案，并按「固定题 → 定制题」的顺序重排（MVP 顺序作答）
			const allQuestions = [...QUESTIONS, ...this.tailored];
			const questionById = new Map(allQuestions.map((q) => [q.id, q]));
			const valid = new Map<string, InterviewLogEntry>();
			for (const entry of restored.answers ?? []) {
				const question = questionById.get(entry.questionId);
				if (!question || valid.has(entry.questionId)) continue;
				if (!question.options.some((o) => o.id === entry.answerId)) continue;
				valid.set(entry.questionId, {
					questionId: entry.questionId,
					answerId: entry.answerId,
					ts: entry.ts,
				});
			}
			for (const id of restored.skippedIds ?? []) {
				if (questionById.has(id)) this.skippedIds.add(id);
			}
			for (const question of allQuestions) {
				const entry = valid.get(question.id);
				if (entry) this.entries.push(entry);
			}
		}

		// 指向第一个未答且未单题跳过的题（顺序作答时等价于 entries.length + 跳过数；
		// 乱序/跳题的恢复数据也能正确续答）
		if (this.skipped) {
			this.index = this.totalTarget();
		} else {
			const answered = new Set(this.entries.map((e) => e.questionId));
			const firstOpen = [...QUESTIONS, ...this.tailored].findIndex(
				(q) => !answered.has(q.id) && !this.skippedIds.has(q.id),
			);
			this.index = firstOpen === -1 ? this.totalTarget() : firstOpen;
		}
	}

	/** 原始简报（server 生成定制题时需要读取 logline/keyMessage） */
	get sourceBrief(): Brief {
		return this.brief;
	}

	/** 当前状态快照（可直接 JSON 序列化） */
	get snapshot(): ClarifierSnapshot {
		const done = this.isDone();
		return {
			phase: done ? "done" : "interviewing",
			questionId: done ? null : (this.questionAt(this.index)?.id ?? null),
			askedCount: done ? this.totalTarget() : this.index + 1,
			answeredCount: this.entries.length,
			totalQuestions: this.totalTarget(),
			skipped: this.skipped,
			answers: this.entries.map((e) => ({ ...e })),
			...(this.skippedIds.size > 0 ? { skippedIds: [...this.skippedIds] } : {}),
			tailored: this.tailored.map(cloneQuestion),
		};
	}

	/** 当前题目；需要先生成定制题或访谈结束时为 null */
	currentQuestion(): Question | null {
		if (this.isDone()) return null;
		return this.questionAt(this.index);
	}

	/** 是否到了需要注入定制题的节点（固定题答完且尚未注入） */
	needsTailored(): boolean {
		return !this.skipped && this.index >= FIXED_QUESTION_COUNT && this.tailored.length === 0;
	}

	/**
	 * 注入定制题（server 在 needsTailored() 为真时调用一次）。
	 * 传入 null 表示 LLM 生成失败，使用内置降级题，保证访谈永远可走通。
	 */
	installTailored(questions: Question[] | null): void {
		if (this.tailored.length > 0) return;
		const source = questions && questions.length > 0 ? questions : fallbackTailored();
		const seen = new Set(this.entries.map((e) => e.questionId));
		this.tailored = source.slice(0, TAILORED_QUESTION_COUNT).map((q, i) => {
			const id = `dyn-${i + 1}`;
			return {
				...q,
				id,
				source: "generated",
				weight: "tailored",
				// 极端情况：恢复数据里已含同名答案时换 id 避免冲突
				...(seen.has(id) ? { id: `${id}-x` } : {}),
			} satisfies Question;
		});
	}

	isDone(): boolean {
		return this.skipped || this.index >= this.totalTarget();
	}

	/** 回答当前题并推进；返回最新快照 */
	answer(answerId: AnswerId): ClarifierSnapshot {
		if (this.isDone()) {
			throw new Error("访谈已结束，不能再作答");
		}
		const question = this.questionAt(this.index);
		if (!question) throw new Error("当前题目尚未就绪");
		const option = question.options.find((o) => o.id === answerId);
		if (!option) {
			throw new Error(`无效选项 ${answerId}（题目 ${question.id}）`);
		}
		this.entries.push({
			questionId: question.id,
			answerId,
			ts: new Date().toISOString(),
		});
		this.index += 1;
		return this.snapshot;
	}

	/** 跳过剩余问题（保留已答内容） */
	skip(): ClarifierSnapshot {
		this.skipped = true;
		this.index = this.totalTarget();
		return this.snapshot;
	}

	/**
	 * 跳过当前这一题（不记录答案、不影响其他题）并推进。
	 * 跳过的题在 compose 中不产生任何意图注入；进度按位置推进。
	 */
	skipCurrent(): ClarifierSnapshot {
		if (this.isDone()) throw new Error("访谈已结束");
		if (!this.questionAt(this.index)) throw new Error("当前题目尚未就绪");
		const question = this.questionAt(this.index);
		if (question) this.skippedIds.add(question.id);
		this.index += 1;
		return this.snapshot;
	}

	/**
	 * 生成富化简报；可在任意时刻调用（部分答案 → 部分注入）。
	 * generationOptions 可选：UI 采集的生成质量选项（分辨率/画幅/负向提示词等）。
	 */
	compose(generationOptions?: GenerationOptions): EnrichedBrief {
		const intent: Intent = intentFromLog(this.entries, [...QUESTIONS, ...this.tailored]);
		return {
			...this.brief,
			creative: { ...this.brief.creative },
			intent,
			generationDirectives: buildDirectives(intent, [...QUESTIONS, ...this.tailored]),
			interviewLog: this.entries.map((e) => ({ ...e })),
			...(generationOptions ? { generationOptions } : {}),
		};
	}

	// ---------------------------------------------------------------- private

	private totalTarget(): number {
		return FIXED_QUESTION_COUNT + (this.tailored.length || TAILORED_QUESTION_COUNT);
	}

	private questionAt(index: number): Question | null {
		if (index < FIXED_QUESTION_COUNT) return QUESTIONS[index] ?? null;
		return this.tailored[index - FIXED_QUESTION_COUNT] ?? null;
	}
}

/** 降级题：补上稳定 id 与来源标记 */
function fallbackTailored(): Question[] {
	return FALLBACK_TAILORED_QUESTIONS.map(
		(q, i) =>
			({
				...q,
				id: `fallback-${i + 1}`,
				source: "generated",
			}) satisfies Question,
	);
}

/** 恢复快照中的定制题（宽容解析：缺字段/非法选项数的题目丢弃） */
function restoreTailored(raw: unknown): Question[] {
	if (!Array.isArray(raw)) return [];
	const out: Question[] = [];
	for (const item of raw) {
		const q = item as Partial<Question>;
		if (
			typeof q?.id !== "string" ||
			typeof q?.text?.zh !== "string" ||
			!Array.isArray(q.options) ||
			q.options.length < 2
		) {
			continue;
		}
		out.push({
			id: q.id,
			category: q.category ?? { zh: "定制", en: "Tailored" },
			text: { zh: q.text.zh, en: q.text.en ?? q.text.zh },
			options: q.options
				.filter((o): o is NonNullable<typeof o> => Boolean(o?.id && o?.label))
				.map((o) => ({
					id: o.id,
					label: { zh: o.label.zh, en: o.label.en ?? o.label.zh },
					hint: { zh: o.hint?.zh ?? "", en: o.hint?.en ?? "" },
					promptTags: Array.isArray(o.promptTags)
						? o.promptTags.filter((t): t is string => typeof t === "string")
						: [],
				})),
			weight: "tailored",
			source: "generated",
			...(q.stage ? { stage: q.stage } : {}),
		});
	}
	return out;
}

function cloneQuestion(q: Question): Question {
	return JSON.parse(JSON.stringify(q)) as Question;
}
