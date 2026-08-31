/**
 * 质检-修复自动闭环 · 目标选择契约测试。
 *
 * selectAutoRepairTargets 是「每次跑片自动提质量」的闸门：
 * - fail 一律入选（客观重问题，补拍收益确定——F1-SH03 78 fail→92 pass 实证过）；
 * - warn 仅认「人物:/物理:」前缀（客观可判），无前缀 warn（道具违和/光线跳跃等观感问题）
 *   不入选——每次补拍烧一个 RPM 提交窗口，滥选比漏选贵；
 * - 每轮 ≤2 镜、保序（前 2 个），是「防失控」契约的一部分。
 *
 * 变异验证约定：把 warn 前缀判断拿掉（warn 全收）→ 用例 2 变红；
 * 把 slice 拿掉 → 用例 3 变红；把 fail 分支拿掉 → 用例 1 变红。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectAutoRepairTargets, type QaShotVerdict } from "../src/pipeline.ts";

const shot = (id: string, verdict: QaShotVerdict["verdict"], reason: string): QaShotVerdict => ({ id, verdict, reason });

describe("selectAutoRepairTargets（自动闭环目标选择）", () => {
	it("fail 一律入选；warn 带人物:/物理: 前缀入选（用例锁 warn 覆盖路径）", () => {
		const targets = selectAutoRepairTargets(
			[
				shot("SH01", "ok", "通过"),
				shot("SH02", "fail", "物理: 多指畸形"),
				shot("SH03", "warn", "人物: 父亲服装夹克变为连帽衫"),
				shot("SH04", "warn", "人物: 少年球衣颜色红变蓝"),
			],
			5,
		);
		assert.deepEqual(
			targets.map((s) => s.id),
			["SH02", "SH03", "SH04"],
			"fail + 带前缀 warn 全部入选，ok 镜永不入选（上限语义由下一用例锁定）",
		);
	});

	it("无前缀 warn 不入选（G3-SH04 实测案例：羽毛球拍乱入不带前缀）", () => {
		const targets = selectAutoRepairTargets([
			shot("SH04", "warn", "父亲手持疑似羽毛球拍（拍面过大）与乒乓球训练设定不符；但台词准确，人物形象连贯"),
			shot("SH05", "warn", "蒸汽特效虚假不自然，AI 生成痕迹明显"),
		]);
		assert.deepEqual(targets, [], "无前缀 warn = 风格/观感问题，不自动补拍");
	});

	it("每轮最多 2 镜且保持原顺序（防失控：控时长与配额）", () => {
		const targets = selectAutoRepairTargets([
			shot("SH01", "fail", "人物: 形象漂移"),
			shot("SH02", "warn", "物理: 物体形变"),
			shot("SH03", "fail", "文字: 乱码"),
			shot("SH04", "warn", "人物: 发型突变"),
		]);
		assert.deepEqual(
			targets.map((s) => s.id),
			["SH01", "SH02"],
			"只取前 2 个合格目标，顺序与 verdict.shots 一致",
		);
	});

	it("边界：空列表 / reason 缺失 / 自定义上限", () => {
		assert.deepEqual(selectAutoRepairTargets([]), []);
		assert.deepEqual(selectAutoRepairTargets([shot("SH01", "warn", "")]), [], "reason 为空 = 无前缀 = 不入选");
		const one = selectAutoRepairTargets(
			[shot("SH01", "fail", "物理: 崩坏"), shot("SH02", "fail", "人物: 漂移")],
			1,
		);
		assert.deepEqual(one.map((s) => s.id), ["SH01"], "maxTargets 可收紧（预算联动用）");
	});
});
