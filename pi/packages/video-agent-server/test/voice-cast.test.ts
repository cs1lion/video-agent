/**
 * 配音选角契约测试（voice-cast.ts 纯函数）。
 *
 * 背景（2026-08-30 用户反馈）：旁白 TTS 从不传 voice、角色未绑音色时回落同一适配器
 * 默认音色——旁白开场后人物开口是同一个声音。音色库按官方清单扩到 24 个后，
 * 本套锁四条铁律：
 *   1. 旁白音色必须避开全部角色音色（播音腔偏好序）；
 *   2. 角色音色按人物设计推导（性别 × 年龄段分池）且同片去重；
 *   3. 显式绑定优先，永不覆盖；
 *   4. 池耗尽跨池补位必须留痕。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignCastVoices, narratorVoiceFor, voicePoolForDescription } from "../src/voice-cast.ts";

const CATALOG = {
	磁性男声: "cixingnansheng",
	深沉男音: "shenchennanyin",
	自信男声: "zixinnansheng",
	元气男声: "yuanqinansheng",
	播音男声: "boyinnansheng",
	儒雅男士: "ruyananshi",
	温柔男声: "wenrounansheng",
	正派青年: "zhengpaiqingnian",
	青年大学生: "qingniandaxuesheng",
	温柔公子: "wenrougongzi",
	爽快男声: "shuangkuainansheng",
	轻声绅士: "soft-spoken-gentleman",
	经典女声: "jingdiannvsheng",
	邻家姐姐: "linjiajiejie",
	清纯少女: "qingchunshaonv",
	元气少女: "yuanqishaonv",
	甜美女声: "tianmeinvsheng",
	温柔女声: "wenrounvsheng",
	温柔熟女: "wenroushunv",
	优雅女声: "youyanvsheng",
	冷艳御姐: "lengyanyujie",
	机灵少女: "jilingshaonv",
	软萌女声: "ruanmengnvsheng",
	活力轻快: "livelybreezy-female",
};

describe("voicePoolForDescription（人物设计 → 分龄音色池）", () => {
	it("性别 × 年龄段分池：老年男 / 成年男 / 女童 / 成年女 / 年轻女", () => {
		assert.deepEqual(voicePoolForDescription("爷爷；68 岁男性退休教师，银白短发"), ["shenchennanyin", "cixingnansheng", "ruyananshi"]);
		assert.deepEqual(voicePoolForDescription("老板；55 岁男性面馆老板，花白寸头"), ["shenchennanyin", "cixingnansheng", "ruyananshi"], "≥55 岁按老年");
		assert.deepEqual(voicePoolForDescription("小周；28 岁女性代驾司机，短黑发"), [
			"jingdiannvsheng",
			"youyanvsheng",
			"lengyanyujie",
			"linjiajiejie",
			"wenrounvsheng",
			"tianmeinvsheng",
		]);
		assert.deepEqual(voicePoolForDescription("孙女；8 岁女孩，黑色双马尾"), ["ruanmengnvsheng", "qingchunshaonv"], "≤12 岁按女童");
		assert.deepEqual(voicePoolForDescription("邻居男孩；10 岁男孩，黑色板寸"), ["ruanmengnvsheng", "qingchunshaonv"], "男童由女童声反串（配音惯例）");
	});
});

describe("assignCastVoices（配音选角）", () => {
	it("铁律一：旁白音色必须避开全部角色音色", () => {
		const r = assignCastVoices([{ name: "老板", description: "55 岁男性面馆老板，花白寸头" }], CATALOG);
		assert.equal(r.byCharacter["老板"], "shenchennanyin", "≥55 男 → 深沉男音");
		assert.equal(r.narratorVoiceId, "boyinnansheng", "播音男声未被占用 → 旁白");
		assert.deepEqual(r.notes, []);
	});

	it("铁律二：同片三角色（爷/孙女/男孩）各得其所、互不相同、旁白再错开", () => {
		const r = assignCastVoices(
			[
				{ name: "爷爷", description: "68 岁男性退休教师，银白短发" },
				{ name: "孙女", description: "8 岁女孩，黑色双马尾" },
				{ name: "邻居男孩", description: "10 岁男孩，黑色板寸" },
			],
			CATALOG,
		);
		assert.equal(r.byCharacter["爷爷"], "shenchennanyin");
		assert.equal(r.byCharacter["孙女"], "ruanmengnvsheng");
		assert.equal(r.byCharacter["邻居男孩"], "qingchunshaonv", "男童反串女童声，与孙女同池 → 顺延不撞声");
		const all = [...Object.values(r.byCharacter), r.narratorVoiceId];
		assert.equal(new Set(all).size, all.length, "旁白+全员音色不得重复");
		assert.ok(r.narratorVoiceId && !Object.values(r.byCharacter).includes(r.narratorVoiceId));
	});

	it("铁律三：显式绑定优先，自动分配避开显式音色", () => {
		const r = assignCastVoices(
			[
				{ name: "阿姐", description: "30 岁女性", voiceId: "jingdiannvsheng" },
				{ name: "妹妹", description: "25 岁女性" },
			],
			CATALOG,
		);
		assert.equal(r.byCharacter["阿姐"], "jingdiannvsheng", "显式绑定不被覆盖");
		assert.equal(r.byCharacter["妹妹"], "youyanvsheng", "自动分配避开已被占用的经典女声");
	});

	it("两个成年男性角色：同池顺延不同声，无需跨池", () => {
		const r = assignCastVoices(
			[
				{ name: "老周", description: "46 岁男性外卖骑手" },
				{ name: "司机", description: "38 岁男性司机" },
			],
			CATALOG,
		);
		assert.equal(r.byCharacter["老周"], "zixinnansheng");
		assert.equal(r.byCharacter["司机"], "cixingnansheng");
		assert.deepEqual(r.notes, [], "音色库 24 个后成年男池不再需要跨池");
	});

	it("无角色卡（纯旁白片）→ 旁白取播音腔首位", () => {
		const solo = assignCastVoices([], CATALOG);
		assert.equal(solo.narratorVoiceId, "boyinnansheng");
	});

	// 2026-08-31 五剧跑批反馈：gender 字段加入。详踩坑补遗 §2.1。
	describe("gender 字段（2026-08-31 五剧跑批反馈）", () => {
		it("直呼姓名+无性别描述：显式 male 强制走男声池（不再兜底 femaleAdult）", () => {
			const r = assignCastVoices(
				[{ name: "李明", description: "35 岁，科技公司产品经理", gender: "male" }],
				CATALOG,
			);
			assert.equal(
				r.byCharacter["李明"],
				"zixinnansheng",
				"male adult 池首选 + 描述无性别词 + 不再兜底 femaleAdult",
			);
		});

		it("直呼姓名+无性别描述：显式 female 走女声池", () => {
			const r = assignCastVoices(
				[{ name: "张薇", description: "35 岁，非营利组织项目主管" }],
				CATALOG,
			);
			assert.equal(r.byCharacter["张薇"], "jingdiannvsheng", "female adult 池首选");
		});

		it("同片男+女+显式 gender，音色不撞、同片去重", () => {
			const r = assignCastVoices(
				[
					{ name: "陈律师", description: "32 岁新手律师", gender: "male" },
					{ name: "张律师", description: "45 岁资深律师", gender: "male" },
					{ name: "林佳", description: "28 岁编辑", gender: "female" },
				],
				CATALOG,
			);
			assert.equal(r.byCharacter["陈律师"], "zixinnansheng");
			assert.equal(r.byCharacter["张律师"], "cixingnansheng", "同池顺延不撞声");
			assert.equal(r.byCharacter["林佳"], "jingdiannvsheng");
			// 旁白必须避开 3 个角色音色
			assert.ok(r.narratorVoiceId);
			assert.ok(!Object.values(r.byCharacter).includes(r.narratorVoiceId!));
			const all = [...Object.values(r.byCharacter), r.narratorVoiceId];
			assert.equal(new Set(all).size, all.length, "旁白+全员音色不得重复");
		});

		it("gender: male + regex 也命中 female 词（'女士'在描述）→ gender 优先，不被 female 词覆盖", () => {
			const r = assignCastVoices(
				[
					// 描述里出现「女同事」描述同片同事，但角色本人是男：gender 字段优先
					{ name: "王队", description: "48 岁男刑警，旁边坐着女书记员", gender: "male" },
				],
				CATALOG,
			);
			assert.equal(r.byCharacter["王队"], "zixinnansheng", "gender=male 优先于描述里的 '女' 关键词");
		});

		it("gender 缺省时：原 regex 行为完全保留（向后兼容）", () => {
			// '老板' 在 MALE_HINTS 里 → 老周无 gender 字段时仍然走男声池
			const r = assignCastVoices(
				[{ name: "老周", description: "46 岁男性外卖骑手" }], // 描述里 '男' 触发 regex
				CATALOG,
			);
			assert.equal(r.byCharacter["老周"], "zixinnansheng", "regex 命中 male 词 → 男声池不变");
		});

		it("gender 缺省 + regex 不命中：保留原 femaleAdult 兜底（不破坏旧调用）", () => {
			const r = assignCastVoices(
				[{ name: "陈默", description: "32 岁前数据分析师，冷静克制" }],
				CATALOG,
			);
			assert.equal(
				r.byCharacter["陈默"],
				"jingdiannvsheng",
				"回归报告 §2.1 的现象：不传 gender + regex 失配 → 仍兜底 femaleAdult（向后兼容）",
			);
		});
	});
});

describe("narratorVoiceFor（重录路径速查）", () => {
	it("避开台词镜已占用的音色；显式参数最优先；全占用回落首位", () => {
		assert.equal(narratorVoiceFor(CATALOG, ["cixingnansheng", "shenchennanyin"]), "boyinnansheng");
		assert.equal(narratorVoiceFor(CATALOG, ["boyinnansheng"], "jingdiannvsheng"), "jingdiannvsheng");
		assert.equal(narratorVoiceFor(CATALOG, Object.values(CATALOG)), "boyinnansheng");
	});
});
