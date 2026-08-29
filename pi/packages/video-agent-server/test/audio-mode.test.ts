/**
 * 音频驱动 A1 契约测试（node:test，零新增依赖、不打网络）：
 * - shouldGateAudioDrive：台词模式只对共创来源开放（A1.4 服务端兜底闸门判定）；
 * - sanitizeDialogue：台词子结构宽容清洗（LLM 产物永远不可信，入库前先洗）；
 * - normalizeScript：audioMode 白名单 + 不留"台词态却无台词"的悬空状态；
 * - detectSpeakers / hasMultipleSpeakers / enforceSingleSpeaker：D1 多角色对白前置拦截；
 * - dialogueFor：按内容语言取台词。
 *
 * 闸门判定抽成纯函数直接测（不起管线），锁的是决策本身；
 * startRun 的接线由 audio-gate.test.ts 的集成用例覆盖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GENERATION_OPTIONS } from "../../video-agent/src/generation/options.ts";
import {
	detectSpeakers,
	enforceSingleSpeaker,
	bindCharacterVoices,
	hasMultipleSpeakers,
	shouldGateAudioDrive,
} from "../src/audio-mode.ts";
import { normalizeScript } from "../src/pipeline.ts";
import { dialogueFor, sanitizeDialogue, type ScriptDoc, type ScriptShot } from "../src/prompts.ts";

// ---------------------------------------------------------------------------
// A1.4 服务端兜底闸门
// ---------------------------------------------------------------------------

describe("shouldGateAudioDrive（A1.4 闸门判定）", () => {
	it("请求台词模式但无共创空间 → 强制回落（true）", () => {
		assert.equal(shouldGateAudioDrive("dialogue", undefined), true);
		assert.equal(shouldGateAudioDrive("dialogue", null), true);
	});

	it("请求台词模式且带共创空间 → 放行（false）", () => {
		assert.equal(shouldGateAudioDrive("dialogue", { characters: [] }), false);
	});

	it("off / 缺省 / 非法值 → 永不拦截（闸门只针对 dialogue）", () => {
		assert.equal(shouldGateAudioDrive("off", undefined), false);
		assert.equal(shouldGateAudioDrive(undefined, undefined), false);
		assert.equal(shouldGateAudioDrive("cinematic", undefined), false);
	});
});

// ---------------------------------------------------------------------------
// 台词子结构清洗
// ---------------------------------------------------------------------------

describe("sanitizeDialogue（台词子结构宽容清洗）", () => {
	it("合法全字段：清洗后逐字段保留（字符串去首尾空白）", () => {
		const cleaned = sanitizeDialogue({
			characterId: " 小林 ",
			voiceId: " voice-01 ",
			lines: { zh: " 这口气泡，冲！ ", en: "That fizz hits." },
			emotion: "兴奋上扬",
			pace: "fast",
			pausesSec: [0.5, 1.2],
			audioDurationSec: 3.4,
			audioUrl: "https://cdn.example.com/a.mp3",
		});
		assert.deepEqual(cleaned, {
			characterId: "小林",
			voiceId: "voice-01",
			lines: { zh: "这口气泡，冲！", en: "That fizz hits." },
			emotion: "兴奋上扬",
			pace: "fast",
			pausesSec: [0.5, 1.2],
			audioDurationSec: 3.4,
			audioUrl: "https://cdn.example.com/a.mp3",
		});
	});

	it("必要条件缺一即整体丢弃：无 characterId / 无台词文本 / 非对象", () => {
		assert.equal(sanitizeDialogue({ lines: { zh: "你好", en: "Hi" } }), null);
		assert.equal(sanitizeDialogue({ characterId: "小林", lines: { zh: "", en: "  " } }), null);
		assert.equal(sanitizeDialogue(null), null);
		assert.equal(sanitizeDialogue("小林：你好"), null);
	});

	it("单边台词合法即成立（另一侧允许空串）", () => {
		const cleaned = sanitizeDialogue({ characterId: "小林", lines: { zh: "开机！", en: "" } });
		assert.deepEqual(cleaned?.lines, { zh: "开机！", en: "" });
	});

	it("非法可选字段逐项过滤：pace / pausesSec / audioDurationSec / audioUrl", () => {
		const cleaned = sanitizeDialogue({
			characterId: "小林",
			lines: { zh: "你好", en: "Hi" },
			pace: "ludicrous",
			pausesSec: [-1, 999, "0.5", NaN, 0.8],
			audioDurationSec: -2,
			audioUrl: "http://insecure.example.com/a.mp3",
		});
		assert.ok(cleaned);
		assert.equal(cleaned!.pace, undefined);
		assert.deepEqual(cleaned!.pausesSec, [0.8]);
		assert.equal(cleaned!.audioDurationSec, undefined);
		assert.equal(cleaned!.audioUrl, undefined);
	});

	it("pausesSec 全部非法 → 字段本身不存在（而非空数组）", () => {
		const cleaned = sanitizeDialogue({ characterId: "小林", lines: { zh: "你好", en: "" }, pausesSec: [-1] });
		assert.ok(cleaned);
		assert.equal("pausesSec" in cleaned!, false);
	});
});

// ---------------------------------------------------------------------------
// normalizeScript：audioMode 白名单 + 悬空状态兜底
// ---------------------------------------------------------------------------

const OPTS = DEFAULT_GENERATION_OPTIONS;

function makeScript(shots: Partial<ScriptShot>[]): ScriptDoc {
	return {
		title: "测试片",
		logline: "契约测试用",
		shots: shots.map((s, i) => ({
			id: s.id ?? `SH${String(i + 1).padStart(2, "0")}`,
			narrationZh: s.narrationZh ?? "",
			narrationEn: s.narrationEn ?? "",
			visual: s.visual ?? "a test shot",
			durationSec: s.durationSec ?? 4,
			...(s.audioMode !== undefined ? { audioMode: s.audioMode } : {}),
			...(s.dialogue !== undefined ? { dialogue: s.dialogue } : {}),
		})),
	};
}

describe("normalizeScript（audioMode 白名单清洗）", () => {
	it("既有作品无 audioMode → narration，语义零变化", () => {
		const out = normalizeScript(makeScript([{ visual: "old shot" }]), OPTS);
		assert.equal(out.shots[0]!.audioMode, "narration");
		assert.equal(out.shots[0]!.dialogue, undefined);
	});

	it("合法 dialogue + 合法台词内容 → 原样保留", () => {
		const out = normalizeScript(
			makeScript([
				{
					audioMode: "dialogue",
					dialogue: { characterId: "小林", lines: { zh: "来一口？", en: "Want a sip?" } },
				},
			]),
			OPTS,
		);
		assert.equal(out.shots[0]!.audioMode, "dialogue");
		assert.equal(out.shots[0]!.dialogue?.characterId, "小林");
	});

	it("声明 dialogue 但台词清洗失败 → 整镜回落 narration，不留悬空状态", () => {
		const out = normalizeScript(
			makeScript([{ audioMode: "dialogue", dialogue: { lines: { zh: "", en: "" } } as never }]),
			OPTS,
		);
		assert.equal(out.shots[0]!.audioMode, "narration");
		assert.equal("dialogue" in out.shots[0]!, false);
	});

	it("silent 透传；白名单外的非法值一律回落 narration", () => {
		const out = normalizeScript(
			makeScript([
				{ audioMode: "silent" },
				{ audioMode: "singing" as never },
				{ audioMode: 42 as never },
			]),
			OPTS,
		);
		assert.deepEqual(
			out.shots.map((s) => s.audioMode),
			["silent", "narration", "narration"],
		);
	});
});

// ---------------------------------------------------------------------------
// D1：多角色对白识别与前置拦截
// ---------------------------------------------------------------------------

function dialogueShot(overrides: Partial<ScriptShot> = {}): ScriptShot {
	return {
		id: "SH01",
		narrationZh: "",
		narrationEn: "",
		visual: "two people talking",
		durationSec: 5,
		audioMode: "dialogue",
		dialogue: { characterId: "小林", lines: { zh: "你好", en: "Hi" } },
		...overrides,
	};
}

describe("detectSpeakers / hasMultipleSpeakers（D1 判定依据）", () => {
	it("中文冒号与英文冒号的说话人前缀都识别，且去重", () => {
		assert.deepEqual(detectSpeakers("小明：来了？\n小红：来了。\n小明：坐。"), ["小明", "小红"]);
		assert.deepEqual(detectSpeakers("Anna: hey\nBen: yo"), ["Anna", "Ben"]);
	});

	it("无前缀 / 单一前缀 → 单说话人，不拦", () => {
		assert.deepEqual(detectSpeakers("这口气泡水真爽。"), []);
		assert.deepEqual(detectSpeakers("小林：真爽。\n小林：再来一口。"), ["小林"]);
	});

	it("非台词镜永远返回 false", () => {
		assert.equal(hasMultipleSpeakers(dialogueShot({ audioMode: "narration" })), false);
		assert.equal(hasMultipleSpeakers(dialogueShot({ dialogue: undefined })), false);
	});

	it("台词文本含两位说话人 → true（中英两侧合并判定）", () => {
		const shot = dialogueShot({
			dialogue: { characterId: "小林", lines: { zh: "小林：喝吗？", en: "Anna: want some?" } },
		});
		assert.equal(hasMultipleSpeakers(shot), true);
	});

	it("characterId 被写成数组且长度>1 → 视为多角色（LLM 偶发形态）", () => {
		const shot = dialogueShot({
			dialogue: { characterId: ["小林", "Anna"] as never, lines: { zh: "干杯", en: "Cheers" } },
		});
		assert.equal(hasMultipleSpeakers(shot), true);
	});
});

describe("enforceSingleSpeaker（剧本落盘前的前置闸门）", () => {
	it("多说话人镜降级为旁白：台词并入旁白字段、去掉 dialogue、附警告", () => {
		const script = makeScript([
			{
				id: "SH02",
				audioMode: "dialogue",
				dialogue: { characterId: "小林", lines: { zh: "小林：喝吗？\n小红：喝！", en: "Lin: sip?" } },
			},
		]);
		const { script: fixed, warnings } = enforceSingleSpeaker(script);
		const shot = fixed.shots[0]!;
		assert.equal(shot.audioMode, "narration");
		assert.equal(shot.narrationZh, "小林：喝吗？\n小红：喝！");
		assert.equal(shot.narrationEn, "Lin: sip?");
		assert.equal("dialogue" in shot, false);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0]!.includes("SH02"));
		assert.ok(warnings[0]!.includes("拆镜"));
	});

	it("单说话人台词镜与非台词镜原样通过、零警告", () => {
		const script = makeScript([
			{ audioMode: "dialogue", dialogue: { characterId: "小林", lines: { zh: "独白一句", en: "Solo" } } },
			{ audioMode: "narration", narrationZh: "旁白" },
			{ audioMode: "silent" },
		]);
		const { script: fixed, warnings } = enforceSingleSpeaker(script);
		assert.deepEqual(fixed.shots, script.shots);
		assert.deepEqual(warnings, []);
	});
});

// ---------------------------------------------------------------------------
// bindCharacterVoices（A7：共创角色卡音色 → 台词镜 voiceId 确定性注入）
// ---------------------------------------------------------------------------

describe("bindCharacterVoices（A7 音色绑定）", () => {
	it("按 characterId 把角色卡的 voiceId 注入台词镜（旁白/无声镜不动）", () => {
		const script = makeScript([
			{ audioMode: "dialogue", dialogue: { characterId: "小林", lines: { zh: "台词", en: "line" } } },
			{ audioMode: "narration", narrationZh: "旁白" },
		]);
		const fixed = bindCharacterVoices(script, {
			characters: [
				{ name: "小林", voiceId: "funny-voice" },
				{ name: "未出场", voiceId: "other" },
			],
		});
		assert.equal(fixed.shots[0]!.dialogue!.voiceId, "funny-voice");
		assert.equal(fixed.shots[1]!.audioMode, "narration");
	});

	it("LLM 自带 voiceId 时不覆盖；无绑定/空 voiceId 原样返回", () => {
		const withVoice = makeScript([
			{ audioMode: "dialogue", dialogue: { characterId: "小林", voiceId: "keep-me", lines: { zh: "a", en: "b" } } },
		]);
		assert.equal(
			bindCharacterVoices(withVoice, { characters: [{ name: "小林", voiceId: "not-me" }] }).shots[0]!.dialogue!.voiceId,
			"keep-me",
		);
		const plain = makeScript([{ audioMode: "dialogue", dialogue: { characterId: "小林", lines: { zh: "a", en: "b" } } }]);
		assert.deepEqual(bindCharacterVoices(plain, undefined), plain);
		assert.deepEqual(bindCharacterVoices(plain, { characters: [{ name: "小林" }] }), plain);
	});
});

// ---------------------------------------------------------------------------
// dialogueFor
// ---------------------------------------------------------------------------

describe("dialogueFor（按内容语言取台词）", () => {
	it("台词镜按语言取对应台词", () => {
		const shot = dialogueShot({
			dialogue: { characterId: "小林", lines: { zh: "中文台词", en: "English line" } },
		});
		assert.equal(dialogueFor(shot, "zh"), "中文台词");
		assert.equal(dialogueFor(shot, "en"), "English line");
	});

	it("非台词镜返回空串", () => {
		assert.equal(dialogueFor(dialogueShot({ audioMode: "narration" }), "zh"), "");
	});
});
