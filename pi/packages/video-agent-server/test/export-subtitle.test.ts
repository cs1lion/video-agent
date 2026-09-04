/**
 * 台词字幕起止纯函数契约测试（export-subtitle.ts）。
 *
 * N1 · ROADMAP 近期「词级时间戳字幕」验收：台词镜字幕起止与实测人声段偏差 ≤0.2s。
 * 这里不测整 stageExport（mock 链太长），只锁三层回退的纯函数行为。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	fallbackSubtitleTiming,
	measuredSubtitleTiming,
	wordTimestampSubtitleTiming,
} from "../src/stages/export-subtitle.ts";

const BASE = { shotStart: 10, shotDur: 5, nextShotStart: 15, speechSec: 4.5 };

describe("wordTimestampSubtitleTiming（词级时间戳分支）", () => {
	it("首尾词时间决定起止，0.5s 收尾（与 silencedetect 同档精度）", () => {
		const r = wordTimestampSubtitleTiming({
			...BASE,
			wordTimestamps: [
				{ text: "你", start: 0.1, end: 0.3 },
				{ text: "好", start: 0.35, end: 0.6 },
				{ text: "世界", start: 0.7, end: 1.2 },
			],
		})!;
		assert.ok(r);
		// 起点 = shotStart + 首词 start = 10 + 0.1 = 10.1
		assert.ok(Math.abs(r.subStart - 10.1) < 1e-6);
		// 时长 = 末词 end - 首词 start + 0.5 = 1.2 - 0.1 + 0.5 = 1.6
		assert.ok(Math.abs(r.subDur - 1.6) < 1e-6);
	});

	it("字幕起点对齐实测人声首字（验收 ≤0.2s 的核心保证）", () => {
		const r = wordTimestampSubtitleTiming({
			...BASE,
			wordTimestamps: [{ text: "开始", start: 0.42, end: 0.9 }],
		})!;
		assert.ok(r);
		// 字幕起点 10.42 vs 人声段起点 10.42 → 偏差 0，远小于 0.2s 上限
		assert.ok(Math.abs(r.subStart - 10.42) < 1e-6);
	});

	it("字幕尽量贴合本镜边界（下限保护 0.8s 仍生效）", () => {
		// 词尾超过 shotDur → subDur 被钳到 nextStart-shotStart-0.1=0.4 → 被 0.8s 下限拉起。
		// 注意：maxSubEnd 只是 min 三项之一，下限 0.8s 会迫使其微超 shotEnd（既有设计，
		// 补遗 §7 是“尽量”不被超过，不在 N1 范围；现场一般不会有首词贴近镜尾的台词镜）。
		const r = wordTimestampSubtitleTiming({
			...BASE,
			wordTimestamps: [{ text: "太长", start: 4.5, end: 9.0 }],
		})!;
		assert.ok(r);
		assert.ok(r.subDur >= 0.8, "下限保护 0.8s 仍生效");
		// subStart 始终在 shotStart 内偏移量范围内
		assert.ok(r.subStart >= BASE.shotStart && r.subStart <= BASE.shotStart + BASE.shotDur);
	});

	it("空数组 / undefined → 返回 null（让调用方走 silencedetect 回落）", () => {
		assert.equal(wordTimestampSubtitleTiming({ ...BASE, wordTimestamps: [] }), null);
		assert.equal(wordTimestampSubtitleTiming({ ...BASE }), null);
	});
});

describe("measuredSubtitleTiming（silencedetect 实测回落）", () => {
	it("有语音段 → 用首尾段推算", () => {
		const r = measuredSubtitleTiming(BASE, [
			{ start: 0.1, end: 0.5 },
			{ start: 0.8, end: 1.4 },
		]);
		assert.ok(Math.abs(r.subStart - 10.1) < 1e-6);
		assert.ok(Math.abs(r.subDur - 1.8) < 1e-6); // 1.4 - 0.1 + 0.5
	});

	it("无语音段 → 自动回落 fallbackSubtitleTiming", () => {
		const r = measuredSubtitleTiming(BASE, []);
		const fb = fallbackSubtitleTiming(BASE);
		assert.ok(Math.abs(r.subStart - fb.subStart) < 1e-6);
		assert.ok(Math.abs(r.subDur - fb.subDur) < 1e-6);
	});
});

describe("fallbackSubtitleTiming（三重收束兜底）", () => {
	it("起点=本镜切点、时长=min(镜长-0.3, 下一切点-0.1, 人声+0.8)", () => {
		// 镜长 5 → 镜长-0.3 = 4.7
		// nextStart 15, shotStart 10 → nextStart-shotStart-0.1 = 4.9
		// speechSec 4.5 → +0.8 = 5.3
		// min(4.7, 4.9, 5.3) = 4.7
		const r = fallbackSubtitleTiming(BASE);
		assert.ok(Math.abs(r.subStart - 10) < 1e-6);
		assert.ok(Math.abs(r.subDur - 4.7) < 1e-6);
	});

	it("末镜 nextShotStart=Infinity → 不被 -0.1 项吃掉，下限由镜长-0.3 决定", () => {
		const r = fallbackSubtitleTiming({ ...BASE, nextShotStart: Number.POSITIVE_INFINITY });
		assert.ok(r.subDur >= 0.8, "下限保护");
		assert.ok(Math.abs(r.subDur - 4.7) < 1e-6, "Infinity 项不参与 min");
	});

	it("极短人声（0.5s）→ speechSec+0.8=1.3 是 min 项 → subDur=1.3", () => {
		const r = fallbackSubtitleTiming({ ...BASE, speechSec: 0.5 });
		assert.ok(Math.abs(r.subDur - 1.3) < 1e-6);
	});

	it("下限保护：subDur 不会 < 0.8s", () => {
		// 构造一个让所有项都很小的情形：shotDur=0.9, nextStart-shotStart=0.5, speech=0
		const r = fallbackSubtitleTiming({
			shotStart: 10,
			shotDur: 0.9,
			nextShotStart: 10.5,
			speechSec: 0,
		});
		assert.ok(r.subDur >= 0.8, `subDur 应 ≥ 0.8，实际 ${r.subDur}`);
	});
});
