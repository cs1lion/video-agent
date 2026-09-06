/**
 * 故事板 normalizeStoryboardDoc 契约测试（加测 5 补档）。
 *
 * 加测 5 在密集对话跑批中发现：LLM 偶尔输出 nested-by-character 结构
 * （{CH01: {position: ...}, CH02: {unobservable: true}}）—— 偏离 prompt 期望的 flat
 * 结构 + StoryboardState 类型。stageStoryboard 之前从未调用 normalizeStoryboardDoc，
 * 导致 validateStoryboard 与 planActualConflicts 静默跳过该镜 → 0 状态: 抓出。
 *
 * 修法：
 *  - maybeFlattenNestedState 在 sanitizeState 入口检测并拍扁；
 *  - stageStoryboard 调 normalizeStoryboardDoc（在 validateStoryboard 之前）。
 *
 * 锁什么：
 *  - nested → flat 拍扁语义（多角色字段合并、holding 数组合并、unobservable 聚合）；
 *  - mixed 输入（nested + flat 字段同时存在）→ flat 字段优先；
 *  - 拍扁后 validateStoryboard / planActualConflicts 能正常读到数据。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScriptDoc, StoryboardDoc } from "../src/prompts.ts";
import {
	normalizeStoryboardDoc,
	validateStoryboard,
} from "../src/storyboard-state.ts";
import { planActualConflicts } from "../src/storyboard-actual.ts";

const SCRIPT: ScriptDoc = {
	title: "测试",
	logline: "测试",
	shots: [
		{ id: "SH01", narrationZh: "", narrationEn: "", visual: "v1", durationSec: 5, audioMode: "narration" },
		{ id: "SH02", narrationZh: "", narrationEn: "", visual: "v2", durationSec: 5, audioMode: "narration" },
	],
};

describe("normalizeStoryboardDoc · nested-by-character schema 拍扁（加测 5 修复）", () => {
	it("拍扁：nested CH01+CH02 → 单层 position/facing/holding/unobservable", () => {
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "两人入座",
					plan: {
						start: {
							CH01: { position: "SC01入口", facing: "SC01内部" },
							CH02: { unobservable: true },
						},
						end: {
							CH01: { position: "PR01旁侧", facing: "审讯桌对面" },
						},
					} as unknown as StoryboardDoc["shots"][number]["plan"],
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, ["PR01"]);
		const s = out.shots[0]!;
		// 拍扁后应为 flat
		assert.equal(s.plan.start.position, "SC01入口");
		assert.equal(s.plan.start.facing, "SC01内部");
		assert.equal(s.plan.end.position, "PR01旁侧");
		assert.equal(s.plan.end.facing, "审讯桌对面");
		// CH01 可观察 → 拍扁后整个 start 应该是可观察的（CH02 unobservable 被覆盖）
		assert.equal(s.plan.start.unobservable, undefined, "任一角色可观察 → 合并后状态可观察");
	});

	it("拍扁：holding 数组跨角色合并", () => {
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "两人拿东西",
					plan: {
						start: {},
						end: {
							CH01: { holding: [{ entityId: "PR01", hand: "right" }] },
							CH02: { holding: [{ entityId: "PR02", hand: "left" }] },
						},
					} as unknown as StoryboardDoc["shots"][number]["plan"],
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, ["PR01", "PR02"]);
		const holding = out.shots[0]!.plan.end.holding ?? [];
		assert.equal(holding.length, 2, "两角色 holding 合并为 2 项");
		const entities = holding.map((h) => h.entityId).sort();
		assert.deepEqual(entities, ["PR01", "PR02"]);
	});

	it("拍扁后 planActualConflicts 能读到 plan position（关键回归点）", () => {
		// 模拟加测 5 的真实场景：LLM 给 nested、actual 给 flat
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "坐",
					plan: {
						start: { CH01: { position: "PR01旁侧" } },
						end: { CH01: { position: "PR01旁侧" } },
					} as unknown as StoryboardDoc["shots"][number]["plan"],
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, ["PR01"]);
		// 双轨审计：plan "PR01旁侧" vs actual "审讯室门口" 应被抓出
		const conflicts = planActualConflicts(out.shots, {
			SH01: { position: "审讯室门口" },
		});
		assert.equal(conflicts.length, 1, "拍扁后 audit 应能抓到 plan vs actual 位置不一致");
		assert.equal(conflicts[0]!.axis, "position");
		assert.equal(conflicts[0]!.severe, false);
	});

	it("拍扁后 validateStoryboard 的 R3 holding 校验能跨角色抓出冲突", () => {
		// SH01 plan.end.CH01 holding=right、SH02 plan.start 显式声明 left 但无 ellipsis
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "右手握杯",
					plan: {
						start: {},
						end: { CH01: { holding: [{ entityId: "PR01", hand: "right" }] } },
					} as unknown as StoryboardDoc["shots"][number]["plan"],
				},
				{
					shotId: "SH02",
					action: "换左手",
					plan: {
						start: { holding: [{ entityId: "PR01", hand: "left" }] },
						end: {},
					},
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, ["PR01"]);
		const conflicts = validateStoryboard(out, { characters: [], props: ["PR01"], scenes: [] });
		const holding = conflicts.filter((c) => c.rule === "holding");
		assert.ok(holding.length > 0, "拍扁后 validateStoryboard 应抓到 R3 换手冲突");
		assert.equal(holding[0]!.shotId, "SH02");
	});

	it("混合输入（nested + flat 字段同时存在）→ flat 字段优先", () => {
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "混合",
					plan: {
						start: {
							position: "flat的",
							CH01: { position: "nested的", facing: "北" },
						},
						end: {},
					} as unknown as StoryboardDoc["shots"][number]["plan"],
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, []);
		// 混合时 flat 字段优先（防止 LLM 偏离 prompt 后被静默覆盖）
		assert.equal(out.shots[0]!.plan.start.position, "flat的");
	});

	it("保持向后兼容：纯 flat 输入行为不变", () => {
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "坐",
					plan: {
						start: { position: "办公桌旁" },
						end: { holding: [{ entityId: "PR01", hand: "right" }] },
					},
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, ["PR01"]);
		assert.equal(out.shots[0]!.plan.start.position, "办公桌旁");
		assert.equal(out.shots[0]!.plan.end.holding?.length, 1);
	});

	it("未注册道具实体被过滤（脏数据兜底）", () => {
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "坐",
					plan: {
						start: {},
						end: { holding: [{ entityId: "PR99", hand: "right" }] }, // 不在注册表
					},
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, ["PR01"]);
		assert.equal(out.shots[0]!.plan.end.holding, undefined, "未知实体被过滤");
	});

	it("shotId 不在 script 里的被丢弃（防 LLM 编造）", () => {
		const raw: Partial<StoryboardDoc> = {
			version: 1,
			shots: [
				{
					shotId: "SH01",
					action: "v1",
					plan: { start: {}, end: {} },
				},
				{
					shotId: "SH99",
					action: "v99",
					plan: { start: {}, end: {} },
				},
			],
		};
		const out = normalizeStoryboardDoc(raw, SCRIPT, []);
		// 应只剩 SH01、SH02（按 SCRIPT 对齐补齐空卡）
		const ids = out.shots.map((s) => s.shotId);
		assert.deepEqual(ids, ["SH01", "SH02"], "script 缺 SH99 的镜被丢弃、缺镜补空卡");
	});
});
