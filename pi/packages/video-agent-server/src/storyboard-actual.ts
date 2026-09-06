/**
 * 故事板双轨校验（P4，2026-09-05）——计划态（plan）vs 实际态（actual）比对 + 实际态视觉审计。
 *
 * 审计复用 QA 已落盘的抽帧（assets/qa-SHxx.jpg / -late.jpg，每镜中段+后段），
 * 一次 chatVisionJson 回收每镜实际结束状态——不新增抽帧 IO，不改变 QA 打分链路。
 * 审计失败不阻断出片（export 内联降级），与「跨镜一致性预检」同级容错。
 *
 * 冲突分级（研究报告 §3.4）：
 * - 持有关系错（该右手实际左手）→ fail（进入既有 selectAutoRepairTargets → reshotRun 自动重拍）；
 * - 位置/朝向漂移 → warn + 「状态:」reason（**不带**「人物:/物理:」前缀 → 不进自动重拍，人工确认）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StoryboardDoc, StoryboardShotCard, StoryboardState } from "./prompts.ts";
import type { StageCtx } from "./pipeline.ts";
import { chatVisionJson } from "./llm.ts";
import { trackLlmCost } from "./pricing.ts";

export type ActualAxis = "holding" | "position" | "facing";

export interface PlanActualConflict {
	shotId: string;
	axis: ActualAxis;
	/** 人类可读的「计划 X vs 实际 Y」描述（中文，直接进 QA reason） */
	message: string;
	/** true = 持有关系硬冲突（fail 级，可自动重拍）；false = 观感级（warn，人工确认） */
	severe: boolean;
}

/** 视觉模型返回的单镜实际态（宽容解析前的原始形态） */
export interface RawActualState {
	shotId?: unknown;
	holding?: unknown;
	position?: unknown;
	facing?: unknown;
	unobservable?: unknown;
}

function asHand(v: unknown): "left" | "right" | "both" | null {
	return v === "left" || v === "right" || v === "both" ? v : null;
}

function asText(v: unknown): string | null {
	const s = typeof v === "string" ? v.trim() : "";
	return s.length > 0 ? s : null;
}

// ==== 实现体 ====

/**
 * 纯函数：计划 endState vs 实际 endState 三轴比对（holding / position / facing）。
 * unobservable 豁免（变异验证：拿掉 → 遮挡镜误报红）：任一侧 unobservable = true 即跳过——
 * 状态不可观察（遮挡/出画），审计"看不到"不是"错"。
 * 比对只看本镜 plan.end 与实际 end，不做序列折叠——折叠是计划层校验器（R1）的活，
 * 双轨比对以镜为界，避免审计误差跨镜传播。
 */
export function planActualConflicts(
	cards: StoryboardShotCard[],
	actuals: Record<string, StoryboardState>,
): PlanActualConflict[] {
	const conflicts: PlanActualConflict[] = [];
	for (const card of cards) {
		const actual = actuals[card.shotId];
		if (!actual) continue;
		const planEnd = card.plan?.end ?? {};
		if (planEnd.unobservable === true || actual.unobservable === true) continue;

		// 持有关系：只比对两边都显式声明的实体；计划无声明（=默认保持）而实际有，不算错
		//（画面多拿了未计划道具属 QA 物理轴职责，这里只抓"计划内的状态错"）
		const actualHands = new Map((actual.holding ?? []).map((h) => [h.entityId, h.hand]));
		for (const h of planEnd.holding ?? []) {
			const actualHand = actualHands.get(h.entityId);
			if (actualHand === undefined || actualHand === h.hand) continue;
			conflicts.push({
				shotId: card.shotId,
				axis: "holding",
				severe: true,
				message: `状态: ${h.entityId} 计划结束在 ${h.hand} 手、实际在 ${actualHand} 手`,
			});
		}

		for (const axis of ["position", "facing"] as const) {
			const planned = planEnd[axis];
			const actualVal = actual[axis];
			if (!planned || !actualVal || planned === actualVal) continue;
			conflicts.push({
				shotId: card.shotId,
				axis,
				severe: false,
				message: `状态: ${axis === "position" ? "位置" : "朝向"}计划「${planned}」、实际「${actualVal}」`,
			});
		}
	}
	return conflicts;
}

/** ==== 审计与回写 ==== */

/**
 * 实际态视觉审计：读 run.dir/assets 里 QA 已抽好的帧（每镜中段+后段），一次视觉调用回收全部实际态。
 * 帧缺失的镜跳过（audit 本来就是尽力而为）；整体失败由调用方降级。
 * prompt 只问三个可判定维度（哪只手拿什么/在哪/朝向），不问观感——观感是 QA 打分链路的职责。
 */
export async function auditActualStates(
	sc: StageCtx,
	cards: StoryboardShotCard[],
	frameBase64: Record<string, string[]>,
): Promise<Record<string, StoryboardState>> {
	const { run, ctx, signal } = sc;
	const withFrames = cards.filter((c) => (frameBase64[c.shotId] ?? []).length > 0);
	const actuals: Record<string, StoryboardState> = {};
	if (withFrames.length === 0) return actuals;

	const list = withFrames.map((c) => `- ${c.shotId}`).join("\n");
	const prompt = [
		"下面是同一部影视短片逐镜抽帧（每镜一到两帧，按镜头编号分组）。只做状态记录，不要评价画面质量：",
		`镜头编号依次为：\n${list}`,
		"对每个镜头，只根据画面回答该镜**结束时**的状态：",
		'hand: 画面主体每只手各拿着什么（用实体编号，如 PR01；没拿东西不写）→ {"entityId":...,"hand":"left|right|both"}[]',
		"position: 人物/主体所处位置（短语，如 办公桌旁/走廊/电梯厅；无法判断不写）",
		"facing: 主体朝向（短语；无法判断不写）",
		"unobservable: 状态被遮挡或主体出画导致无法判断时写 true",
		'只输出 JSON（不要围栏）: {"shots":[{"shotId":"SH01","holding":[{"entityId":"PR01","hand":"right"}],"position":"办公桌旁","facing":"东","unobservable":false}]}',
	].join("\n");

	const frames = withFrames.flatMap((c) => frameBase64[c.shotId] ?? []);
	run.metrics.llmCalls += 1;
	const vision = await chatVisionJson<{ shots?: RawActualState[] }>(ctx.llm, prompt, frames, signal);
	trackLlmCost(run, ctx, prompt, JSON.stringify(vision), frames.length);

	for (const raw of Array.isArray(vision.shots) ? vision.shots : []) {
		const shotId = asText(raw.shotId);
		if (!shotId) continue;
		const holding = Array.isArray(raw.holding)
			? (raw.holding as { entityId?: unknown; hand?: unknown }[])
					.map((h) => ({ entityId: asText(h.entityId) ?? "", hand: asHand(h.hand) }))
					.filter((h): h is { entityId: string; hand: "left" | "right" | "both" } => h.entityId.length > 0 && h.hand !== null)
			: undefined;
		const position = asText(raw.position);
		const facing = asText(raw.facing);
		actuals[shotId] = {
			...(holding && holding.length > 0 ? { holding } : {}),
			...(position ? { position } : {}),
			...(facing ? { facing } : {}),
			...(raw.unobservable === true ? { unobservable: true } : {}),
		};
	}
	return actuals;
}

/** 从磁盘读 QA 帧（存在才读）。供 export 调用 audit 前收集，路径相对 runDir。 */
export function loadQaFrames(runDir: string, shotIds: string[]): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const id of shotIds) {
		const files = [`assets/qa-${id}.jpg`, `assets/qa-${id}-late.jpg`].filter((rel) => fs.existsSync(path.join(runDir, rel)));
		if (files.length === 0) continue;
		result[id] = files.map((rel) => fs.readFileSync(path.join(runDir, rel)).toString("base64"));
	}
	return result;
}

/** 把实际态回写进 storyboard doc 的 shots（不落盘，落盘归调用方）；返回同一引用便于链式。 */
export function writeActualStates(doc: StoryboardDoc, actuals: Record<string, StoryboardState>): StoryboardDoc {
	for (const card of doc.shots ?? []) {
		const actual = actuals[card.shotId];
		if (actual) card.actualState = { start: actual, end: actual };
	}
	return doc;
}

