/**
 * 故事板状态机校验器（P1，2026-09-05）。
 *
 * 职责：对 StoryboardDoc 的**计划态**（plan）做确定性自检——纯函数，无 IO / 无 LLM / 无全局状态。
 * 实际态（actualState）比对是 P4 双轨校验的活，本阶段只留类型位。
 *
 * 两条语义规则（与 prompts.ts 故事板 schema 注释一一对应）：
 * - 默认保持：StoryboardState 字段缺省 = 继承上一镜 endState 对应字段（R1 继承折叠）；
 * - 未观察保持：unobservable: true 的镜，start 不与上一镜 endState 比对（R2）。
 *
 * 六条规则（变异验证对应 test/storyboard-state.test.ts，拿掉任一规则 → 对应用例红）：
 * - R1 默认保持（继承折叠）：折叠后才能暴露"隔镜换手"类冲突；
 * - R2 未观察保持：unobservable 豁免 start 与上一镜的比对；
 * - R3 持有关系：holding 实体必须存在于 props；同一状态内实体重复；无豁免的跨镜换手；
 * - R4 位置/朝向连续性：start 显式偏离上一镜 endState 且无 ellipsis/flashback 豁免 → 冲突；
 * - R5 镜头关系合法性：shotId 重复；首镜带 relation；flashback 后一镜未声明 relation；
 * - R6 soundCues 边界：t ∈ [0, durationSec]（镜长由调用方传入）；kind=dialogue 须有 dialogueTurn。
 *
 * 豁免口径：relation.time ∈ { ellipsis, flashback } 时，R3/R4 的跨镜比对跳过（显式时间跳变，
 * 设计思路 §一"明确标注为时间省略"）；R2 豁免与豁免口径相互独立，任一命中即不比对。
 */

import type { StoryboardDoc, StoryboardShotCard, StoryboardState } from "./prompts.ts";

export type StateConflictRule =
	| "holding"
	| "position"
	| "facing"
	| "precondition-link"
	| "relation-validity"
	| "soundcue-bounds";

export interface StateConflict {
	rule: StateConflictRule;
	shotId: string;
	message: string;
}

/** 实体注册表（来自 design-bible；holding 的 entityId 必须落在 props 内） */
export interface EntityIds {
	characters: string[];
	props: string[];
	scenes: string[];
}

export interface ValidateStoryboardOptions {
	/** shotId → 镜长（秒）；缺省该镜跳过 R6 的边界检查（本阶段与 script 解耦，P2 接线时由调用方组装） */
	durations?: Record<string, number>;
}

type Hand = NonNullable<StoryboardState["holding"]>[number]["hand"];

// ==== 实现体 ====

/** R1 · 继承折叠：cur 缺省字段继承 prev；显式声明覆盖 prev。unobservable 只作用于比对豁免，不参与折叠。 */
function foldState(prev: StoryboardState, cur: StoryboardState): StoryboardState {
	return {
		position: cur.position ?? prev.position,
		facing: cur.facing ?? prev.facing,
		holding: cur.holding ?? prev.holding,
		posture: cur.posture ?? prev.posture,
		mood: cur.mood ?? prev.mood,
		appearanceOverrides: cur.appearanceOverrides ?? prev.appearanceOverrides,
		unobservable: cur.unobservable ?? false,
	};
}

function timeJumpExempted(card: StoryboardShotCard): boolean {
	return card.relation?.time === "ellipsis" || card.relation?.time === "flashback";
}

/** R3 · 单个状态内的 holding 合法性（实体存在性 + 重复声明） */
function holdingSelfConflicts(shotId: string, state: StoryboardState, knownProps: Set<string>): StateConflict[] {
	const conflicts: StateConflict[] = [];
	if (!state.holding) return conflicts;
	const seen = new Set<string>();
	for (const h of state.holding) {
		if (!knownProps.has(h.entityId)) {
			conflicts.push({ rule: "holding", shotId, message: `持有可能实体 ${h.entityId} 不在道具实体注册表中（必须引用 design-bible 实体 id）` });
		}
		if (seen.has(h.entityId)) {
			conflicts.push({ rule: "holding", shotId, message: `实体 ${h.entityId} 在同一状态的 holding 中被声明了多次` });
		}
		seen.add(h.entityId);
	}
	return conflicts;
}

/** R3 · 跨镜 holding 比对：同一实体在上一镜 end 与本镜 start 显式声明了不同 hand 且无豁免 → 冲突 */
function holdingCrossConflicts(shotId: string, prevEnd: StoryboardState, declaredStart: StoryboardState): StateConflict[] {
	const conflicts: StateConflict[] = [];
	const startHolding = declaredStart.holding;
	if (!startHolding) return conflicts; // 缺省 = 继承，R1 折叠后自然延续，无冲突
	const prevHands = new Map<string, Hand>((prevEnd.holding ?? []).map((h) => [h.entityId, h.hand]));
	for (const h of startHolding) {
		const prevHand = prevHands.get(h.entityId);
		if (prevHand !== undefined && prevHand !== h.hand) {
			conflicts.push({
				rule: "holding",
				shotId,
				message: `实体 ${h.entityId} 上一镜结束在 ${prevHand} 手、本镜开始显式声明在 ${h.hand} 手，且无时间省略豁免（换手必须有动作交代）`,
			});
		}
	}
	return conflicts;
}

/** R4 · 位置/朝向连续性：start 显式声明偏离上一镜 end 且无豁免 → 冲突（瞬移/无故转向） */
function continuityConflicts(shotId: string, field: "position" | "facing", prevEnd: StoryboardState, declaredStart: StoryboardState): StateConflict[] {
	const declared = declaredStart[field];
	if (declared === undefined || prevEnd[field] === undefined) return [];
	if (declared === prevEnd[field]) return [];
	return [
		{
			rule: field,
			shotId,
			message: `${field === "position" ? "位置" : "朝向"}从上一镜结束的「${prevEnd[field]}」变为「${declared}」，但本镜未声明时间省略/闪回（空间迁移或转身须有镜头交代）`,
		},
	];
}

/** 主入口：对 plan 序列做 R1-R6 全量校验，返回冲突列表（空 shots 返回 []）。 */
export function validateStoryboard(
	doc: StoryboardDoc,
	entityIds: EntityIds,
	options: ValidateStoryboardOptions = {},
): StateConflict[] {
	const conflicts: StateConflict[] = [];
	const shots = doc?.shots ?? [];
	if (shots.length === 0) return conflicts;

	const knownProps = new Set(entityIds?.props ?? []);

	// R5 · shotId 重复
	const seenIds = new Set<string>();
	for (const card of shots) {
		if (seenIds.has(card.shotId)) {
			conflicts.push({ rule: "relation-validity", shotId: card.shotId, message: `shotId 重复：${card.shotId}` });
		}
		seenIds.add(card.shotId);
	}

	// R5 · 首镜不应声明 relation（没有"上一镜"可接）
	if (shots[0]?.relation) {
		conflicts.push({ rule: "relation-validity", shotId: shots[0].shotId, message: "首镜声明了 relation（没有上一镜可衔接）" });
	}

	// R5 · flashback 后一镜必须显式声明 relation（回到主线的交代）
	for (let i = 0; i < shots.length - 1; i++) {
		if (shots[i].relation?.time === "flashback" && !shots[i + 1].relation) {
			conflicts.push({ rule: "relation-validity", shotId: shots[i + 1].shotId, message: `上一镜 ${shots[i].shotId} 是闪回，本镜必须显式声明 relation 以交代回到主线` });
		}
	}

	// R1-R4：逐镜折叠 + 跨镜比对
	let prevEnd: StoryboardState | null = null;
	for (const card of shots) {
		const declaredStart = card.plan?.start ?? {};
		const unobservable = declaredStart.unobservable === true;
		const exempted = timeJumpExempted(card);

		if (prevEnd !== null && !unobservable && !exempted) {
			conflicts.push(...holdingCrossConflicts(card.shotId, prevEnd, declaredStart));
			conflicts.push(...continuityConflicts(card.shotId, "position", prevEnd, declaredStart));
			conflicts.push(...continuityConflicts(card.shotId, "facing", prevEnd, declaredStart));
		}

		conflicts.push(...holdingSelfConflicts(card.shotId, declaredStart, knownProps));
		conflicts.push(...holdingSelfConflicts(card.shotId, card.plan?.end ?? {}, knownProps));

		const effectiveStart = prevEnd === null ? foldState({}, declaredStart) : foldState(prevEnd, declaredStart);
		prevEnd = foldState(effectiveStart, card.plan?.end ?? {});
	}

	// R6 · soundCues 边界（镜长由调用方传入，缺省跳过）
	const durations = options.durations ?? {};
	for (const card of shots) {
		const duration = durations[card.shotId];
		for (const cue of card.soundCues ?? []) {
			if (!Number.isFinite(cue.t) || cue.t < 0) {
				conflicts.push({ rule: "soundcue-bounds", shotId: card.shotId, message: `声音事件 t=${cue.t} 非法（须为 ≥0 的有限秒数）` });
				continue;
			}
			if (duration !== undefined && cue.t > duration) {
				conflicts.push({ rule: "soundcue-bounds", shotId: card.shotId, message: `声音事件 t=${cue.t}s 超出镜长 ${duration}s` });
			}
			if (cue.kind === "dialogue" && !card.dialogueTurn) {
				conflicts.push({ rule: "soundcue-bounds", shotId: card.shotId, message: "kind=dialogue 的声音事件必须有对应 dialogueTurn（谁在说）" });
			}
		}
	}

	return conflicts;
}
