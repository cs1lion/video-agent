/**
 * 故事板状态机校验器 · 契约测试（P1-S6，2026-09-05）。
 *
 * 锁什么：validateStoryboard 六条规则（R1-R6）的判定口径与豁免语义。
 * 变异语义（每条反例注明：拿掉哪条规则 → 本用例红）：
 * - 拿掉 R1 foldState 继承折叠 → 「隔镜换手」用例红（无折叠则隔镜 endState 丢失，比对不到）；
 * - 拿掉 R2 unobservable 豁免 → 「遮挡镜」用例红（误报冲突）；
 * - 拿掉 R3 holdingSelfConflicts → 「未知实体/重复声明」用例红；
 * - 拿掉 R4 continuityConflicts → 「瞬移」用例红；
 * - 拿掉 R5 关系合法性 → 「重复 shotId/首镜 relation/闪回无交代」用例红；
 * - 拿掉 R6 边界检查 → 「t 超镜长/dialogue 无轮次」用例红。
 *
 * fixture：设计思路.txt 的咖啡杯三镜头（办公室拿杯 → 手部特写 → 门口推门）+ 第四镜时间省略。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoryboardDoc, StoryboardShotCard, StoryboardState } from "../src/prompts.ts";
import { validateStoryboard, type EntityIds } from "../src/storyboard-state.ts";

const ENTITIES: EntityIds = { characters: ["CH01"], props: ["PR01"], scenes: ["SC01", "SC02"] };

const card = (shotId: string, overrides: Partial<StoryboardShotCard>): StoryboardShotCard => ({
	shotId,
	action: overrides.action ?? "",
	plan: overrides.plan ?? { start: {}, end: {} },
	...overrides,
});

const hold = (entityId: string, hand: "left" | "right" | "both") => ({ entityId, hand });

/** 设计思路咖啡杯：SH01 拿杯（右手）→ SH02 持杯触门把手 → SH03 推门入走廊 → SH04 时间省略到咖啡店 */
function coffeeDoc(): StoryboardDoc {
	const s01Start: StoryboardState = { position: "办公桌旁", facing: "东" };
	return {
		version: 1,
		shots: [
			card("SH01", {
				action: "右手握住杯柄，拿起杯子",
				plan: { start: s01Start, end: { ...s01Start, holding: [hold("PR01", "right")] } },
				soundCues: [{ t: 1, kind: "object", desc: "陶瓷杯离开桌面" }],
			}),
			card("SH02", {
				action: "右手把杯子拿稳，左手伸向门把手",
				relation: { time: "continuous", space: "same-location", sound: "none" },
				plan: { start: {}, end: { facing: "东" } },
				soundCues: [{ t: 0.5, kind: "ambient", desc: "办公室键盘余音" }],
			}),
			card("SH03", {
				action: "左手转动门把手并推门，走入走廊",
				relation: { time: "continuous", space: "follow", sound: "carry-over" },
				plan: { start: {}, end: { position: "走廊", holding: [hold("PR01", "right")] } },
			}),
			card("SH04", {
				action: "沿走廊走向电梯",
				relation: { time: "ellipsis", space: "new-location", sound: "none" },
				plan: { start: { position: "电梯厅" }, end: { position: "电梯厅" } },
			}),
		],
	};
}

describe("validateStoryboard（故事板状态机 R1-R6）", () => {
	it("咖啡杯四镜合法序列：零冲突（正例锚点）", () => {
		const conflicts = validateStoryboard(coffeeDoc(), ENTITIES, { durations: { SH01: 3, SH02: 2, SH03: 4, SH04: 5 } });
		assert.deepEqual(conflicts, []);
	});

	it("边界：空 shots / 缺 plan 字段容错", () => {
		assert.deepEqual(validateStoryboard({ version: 1, shots: [] }, ENTITIES), []);
		const doc: StoryboardDoc = { version: 1, shots: [{ shotId: "SH01", action: "" } as unknown as StoryboardShotCard] };
		assert.deepEqual(validateStoryboard(doc, ENTITIES), []);
	});

	it("R1 默认保持：隔镜换手被折叠暴露（拿掉 foldState 继承 → 此用例红）", () => {
		const doc = coffeeDoc();
		doc.shots[2].plan.start.holding = [hold("PR01", "left")]; // SH03 start 显式换左手（SH01→SH02 未交代）
		const conflicts = validateStoryboard(doc, ENTITIES);
		const hit = conflicts.filter((c) => c.rule === "holding" && c.shotId === "SH03");
		assert.ok(hit.length === 1, `期望恰 1 条 holding 冲突，实际 ${JSON.stringify(conflicts)}`);
		assert.match(hit[0].message, /PR01/);
	});

	it("R2 未观察保持：遮挡镜不与上一镜比对（拿掉 unobservable 豁免 → 此用例红=误报）", () => {
		const doc = coffeeDoc();
		doc.shots[2].plan.start = { position: "走廊", facing: "南", holding: [hold("PR01", "left")], unobservable: true };
		assert.deepEqual(validateStoryboard(doc, ENTITIES), []);
	});

	it("R3：未知实体与同状态重复声明（拿掉 holdingSelfConflicts → 此用例红）", () => {
		const doc = coffeeDoc();
		doc.shots[0].plan.end.holding = [hold("PR99", "right"), hold("PR01", "both"), hold("PR01", "left")];
		const conflicts = validateStoryboard(doc, ENTITIES);
		const msgs = conflicts.filter((c) => c.rule === "holding").map((c) => c.message);
		assert.ok(msgs.some((m) => m.includes("PR99")), "应报未知实体");
		assert.ok(msgs.some((m) => m.includes("PR01") && m.includes("多次")), "应报重复声明");
	});

	it("R4：无豁免的瞬移被抓（拿掉 continuityConflicts → 此用例红）", () => {
		const doc = coffeeDoc();
		doc.shots[2].plan.start.position = "走廊另一端"; // SH02 end 未声明位置变化，SH03 start 显式跳变
		const conflicts = validateStoryboard(doc, ENTITIES);
		assert.ok(conflicts.some((c) => c.rule === "position" && c.shotId === "SH03"));
	});

	it("R4：ellipsis/flashback 豁免跨镜比对（豁免口径回归）", () => {
		const doc = coffeeDoc();
		doc.shots[3].plan.start = { position: "咖啡店", holding: [hold("PR01", "both")] };
		assert.deepEqual(validateStoryboard(doc, ENTITIES), []);
	});

	it("R5：重复 shotId / 首镜 relation / 闪回后未交代（拿掉关系合法性检查 → 此用例红）", () => {
		const doc = coffeeDoc();
		doc.shots[1].shotId = "SH01";
		doc.shots[0].relation = { time: "continuous", space: "same-location", sound: "none" };
		doc.shots[2].relation = { time: "flashback", space: "same-location", sound: "none" };
		delete doc.shots[3].relation; // 移除 SH04 原有的 ellipsis，制造"闪回后未交代"
		const conflicts = validateStoryboard(doc, ENTITIES);
		const validity = conflicts.filter((c) => c.rule === "relation-validity").map((c) => c.message);
		assert.ok(validity.some((m) => m.includes("重复")), "应报 shotId 重复");
		assert.ok(validity.some((m) => m.includes("首镜")), "应报首镜 relation");
		assert.ok(validity.some((m) => m.includes("闪回")), "应报闪回后未交代");
	});

	it("R6：t 超镜长 / 负值 / dialogue 缺轮次（拿掉边界检查 → 此用例红）", () => {
		const doc = coffeeDoc();
		doc.shots[0].soundCues = [
			{ t: 5, kind: "object", desc: "超镜长" }, // durationSec 3
			{ t: -1, kind: "sfx", desc: "负值" },
		];
		doc.shots[1].soundCues = [{ t: 1, kind: "dialogue", desc: "无 dialogueTurn" }];
		const conflicts = validateStoryboard(doc, ENTITIES, { durations: { SH01: 3, SH02: 2 } });
		const msgs = conflicts.filter((c) => c.rule === "soundcue-bounds").map((c) => c.message);
		assert.ok(msgs.some((m) => m.includes("超出镜长")));
		assert.ok(msgs.some((m) => m.includes("非法")));
		assert.ok(msgs.some((m) => m.includes("dialogueTurn")));
	});

	it("R6：未提供镜长的镜跳过边界检查、保留其他规则", () => {
		const doc = coffeeDoc();
		doc.shots[0].soundCues = [{ t: 999, kind: "object", desc: "无镜长信息" }];
		const conflicts = validateStoryboard(doc, ENTITIES);
		assert.deepEqual(conflicts, []);
	});
});

