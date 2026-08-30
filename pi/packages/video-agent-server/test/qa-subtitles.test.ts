/**
 * 字幕结构审核契约测试（qa/subtitles.ts 纯函数）。
 *
 * 背景：2026-08-30 e2e 抽帧实锤——buildAssSubtitles 的 Dialogue 行 5 字段 vs
 * Events Format 10 字段，字幕文本落进 Name 列，Text 渲染列恒空，烧录字幕
 * 从未真正出现在成片里。解析器按 Format 列映射，两类布局都必须能读；
 * 修复后的 builder 输出必须全绿通过审核。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAssSubtitles } from "../src/ffmpeg.ts";
import { auditSubtitles, parseAssSubtitles } from "../src/qa/subtitles.ts";

const HEADER = (w: number, h: number) =>
	[
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${w}`,
		`PlayResY: ${h}`,
		"WrapStyle: 0",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		"Style: Sub,Microsoft YaHei,37,&H00FFFFFF,&H00FFFFFF,&H00101010,&H96000000,0,0,0,0,100,100,0,0,1,2,1,2,102,102,43,1",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	].join("\n");

describe("parseAssSubtitles（Format 列映射解析）", () => {
	it("修复后的 10 字段布局（Text 在最后一段，含逗号安全）", () => {
		const ass = `${HEADER(1280, 720)}
Dialogue: 0,0:00:09.15,0:00:12.98,Sub,,0,0,0,,末班车总在等的路上迟到
Dialogue: 0,0:00:13.38,0:00:16.60,Sub,,0,0,0,,一句,含逗号的,字幕
`;
		const parsed = parseAssSubtitles(ass);
		assert.equal(parsed.length, 2);
		assert.equal(parsed[0]!.text, "末班车总在等的路上迟到");
		assert.ok(Math.abs(parsed[0]!.startSec - 9.15) < 1e-6);
		assert.ok(Math.abs(parsed[0]!.endSec - 12.98) < 1e-6);
		assert.equal(parsed[1]!.text, "一句,含逗号的,字幕", "Text 是尾段：文本内逗号不破坏解析");
	});

	it("旧的 5 字段布局（历史现场）也能读出文本", () => {
		const ass = `${HEADER(1280, 720)}
Dialogue: 0,0:00:09.15,0:00:12.98,Sub,旧布局文本
`;
		const parsed = parseAssSubtitles(ass);
		// 旧布局里文本实际落 Name 列（Text 列缺失）——解析器容忍缺列：读不到 Text 就跳过。
		// 旧布局渲染为空 = 历史缺陷，audit 层用 expectedLines 覆盖率兜住它。
		assert.equal(parsed.length, 0, "5 字段布局 Text 列不存在 → 不可渲染 → 视为无有效字幕行");
	});
});

describe("auditSubtitles（结构审核）", () => {
	it("健康字幕 + 覆盖率对齐 → issues 空", () => {
		const ass = `${HEADER(1280, 720)}
Dialogue: 0,0:00:00.50,0:00:03.20,Sub,,0,0,0,,凌晨的面馆亮着灯
Dialogue: 0,0:00:03.60,0:00:06.80,Sub,,0,0,0,,老板把面端到窗边
`;
		const audit = auditSubtitles(ass, 2, "zh");
		assert.equal(audit.present, true);
		assert.equal(audit.lines, 2);
		assert.deepEqual(audit.issues, []);
	});

	it("有旁白却零字幕行（历史 bug 的形状）→ 显式报字幕缺失", () => {
		const ass = `${HEADER(1280, 720)}
Dialogue: 0,0:00:09.15,0:00:12.98,Sub,文本在Name列渲染不出来
`;
		const audit = auditSubtitles(ass, 3, "zh");
		assert.equal(audit.present, false);
		assert.ok(audit.issues[0]!.includes("字幕缺失"), audit.issues.join("; "));
	});

	it("覆盖缺口 / 时间轴重叠 / 停留过短 / 中文行无 CJK 各自成issue", () => {
		const ass = `${HEADER(1280, 720)}
Dialogue: 0,0:00:01.00,0:00:01.10,Sub,,0,0,0,,太短
Dialogue: 0,0:00:01.05,0:00:04.00,Sub,,0,0,0,,hello world
Dialogue: 0,0:00:03.00,0:00:05.00,Sub,,0,0,0,,与上一行重叠
`;
		const audit = auditSubtitles(ass, 4, "zh");
		const joined = audit.issues.join(" | ");
		assert.ok(joined.includes("覆盖缺口"), joined);
		assert.ok(joined.includes("停留过短"), joined);
		assert.ok(joined.includes("重叠"), joined);
		assert.ok(joined.includes("无 CJK"), joined);
	});

	it("乱码替换符 / 控制字符被点名", () => {
		const ass = `${HEADER(1280, 720)}
Dialogue: 0,0:00:01.00,0:00:03.00,Sub,,0,0,0,,出现\uFFFD替换符的行
Dialogue: 0,0:00:04.00,0:00:06.00,Sub,,0,0,0,,带\u0007控制字符
`;
		const audit = auditSubtitles(ass, 2, "zh");
		const joined = audit.issues.join(" | ");
		assert.ok(joined.includes("疑似乱码"), joined);
		assert.equal(audit.issues.filter((s) => s.includes("疑似乱码")).length, 2, "替换符行与控制字符行各记一次乱码类问题");
		assert.ok(joined.includes("控制字符"), joined);
	});

	it("无旁白来源（expectedLines=0）+ 无字幕行 → 合法通过", () => {
		const audit = auditSubtitles(HEADER(1280, 720) + "\n", 0, "zh");
		assert.equal(audit.present, false);
		assert.deepEqual(audit.issues, []);
	});
});

describe("buildAssSubtitles（修复回归锁）", () => {
	it("Dialogue 行必须含 10 字段（文本在 Text 列），且通过自家审核", () => {
		const ass = buildAssSubtitles(
			[
				{ start: 1, duration: 2.5, text: "第一行字幕" },
				{ start: 4, duration: 3, text: "第二行,带逗号" },
			],
			1280,
			720,
		);
		const dialogueLines = ass.split(/\r?\n/).filter((l) => l.startsWith("Dialogue:"));
		assert.equal(dialogueLines.length, 2);
		for (const line of dialogueLines) {
			const fieldCount = line.slice("Dialogue:".length).split(",").length;
			// 9 个结构字段 + 文本（文本自身可含逗号 → ≥10）；少于 10 说明文本落进 Name 列
			assert.ok(fieldCount >= 10, `Dialogue 行至少 10 字段（此前 5 字段导致字幕渲染为空）：${line}`);
		}
		const audit = auditSubtitles(ass, 2, "zh");
		assert.deepEqual(audit.issues, [], "builder 产出必须通过自家结构审核");
		assert.equal(audit.lines, 2);
	});
});
