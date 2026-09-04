/**
 * A2 台词链路纯函数契约：停顿 filter 构造 / 托管 URL 与落点 / env 解析 /
 * 台词 reference 提交参数分支。行为链路见 dialogue-clips.test.ts。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPauseFilters } from "../src/ffmpeg.ts";
import { cloudPathFor, parseCosUploadUrl, parseEnvFile, publicUrlFor } from "../src/hosting/tcb.ts";
import { dialogueCondenseMessages } from "../src/prompts.ts";
import { dialogueDerivedSec, isAgnesVideo25, videoSubmitParamsForDialogue } from "../src/redo-adapters.ts";
import type { ServerContext } from "../src/config.ts";

describe("dialogueCondenseMessages（A4 精简重写 prompt 契约）", () => {
	it("包含目标字数、双语原文与 JSON 输出约定", () => {
		const prompt = dialogueCondenseMessages("SH07", "非常长的一句台词", "a very long line", 20);
		assert.ok(prompt.includes("SH07"));
		assert.ok(prompt.includes("20 字"), "目标字数必须显式出现（中文 ~4 字/秒 折算）");
		assert.ok(prompt.includes("非常长的一句台词"));
		assert.ok(prompt.includes("a very long line"));
		assert.ok(prompt.includes('{"zh"'), "必须约定只输出 {zh,en} JSON");
	});

	it("下限保护：极短镜长的目标字数不低于 8（max(8, floor(sec*4))）", () => {
		const prompt = dialogueCondenseMessages("SH01", "台词", "line", 8);
		assert.ok(prompt.includes("8 字"));
	});
});

describe("buildPauseFilters（A2 台词停顿插入）", () => {
	it("无停顿 → null（调用方直接用原音频，不跑 ffmpeg）", () => {
		assert.equal(buildPauseFilters(4.2, []), null);
		assert.equal(buildPauseFilters(4.2, [0, -1, Number.NaN]), null, "非正数停顿项全部过滤后 = 无停顿");
	});

	it("单停顿：2 段语音 + 1 段静音，等分切点与 concat 数量正确", () => {
		const f = buildPauseFilters(6, [0.5])!;
		assert.match(f, /atrim=start=0\.000:end=3\.000/);
		assert.match(f, /atrim=start=3\.000:end=6\.000/);
		assert.match(f, /aevalsrc=0:d=0\.500:s=44100/);
		assert.match(f, /concat=n=3:v=0:a=1\[out\]/);
		assert.match(f, /aformat=sample_rates=44100:channel_layouts=mono/, "语音段规格统一，规避 concat 响亮失败");
	});

	it("多停顿：n 项 → n+1 段语音、2n+1 路 concat，段宽 = total/(n+1)", () => {
		const f = buildPauseFilters(8, [0.3, 0.6])!;
		assert.match(f, /atrim=start=0\.000:end=2\.667/);
		assert.match(f, /atrim=start=2\.667:end=5\.333/);
		assert.match(f, /atrim=start=5\.333:end=8\.000/);
		assert.match(f, /aevalsrc=0:d=0\.300:s=44100/);
		assert.match(f, /aevalsrc=0:d=0\.600:s=44100/);
		assert.match(f, /concat=n=5:v=0:a=1\[out\]/);
	});

	it("非法输入：totalSec 非正 → null", () => {
		assert.equal(buildPauseFilters(0, [0.5]), null);
		assert.equal(buildPauseFilters(-1, [0.5]), null);
	});
});

describe("CloudBase 托管纯函数（A2）", () => {
	it("publicUrlFor：COS 直连公开域（08-29 实测定案：tcb.qcloud.la 前置层 418，不走它），容忍前导斜杠", () => {
		assert.equal(
			publicUrlFor("6d79-myagent-x-1253451683", "ap-shanghai", "video-agent/run1/tts-SH01.mp3"),
			"https://6d79-myagent-x-1253451683.cos.ap-shanghai.myqcloud.com/video-agent/run1/tts-SH01.mp3",
		);
		assert.equal(publicUrlFor("b", "ap-shanghai", "/x.mp3"), "https://b.cos.ap-shanghai.myqcloud.com/x.mp3");
	});

	it("parseCosUploadUrl：从上传元数据 URL 解析桶/区域；非 COS 域返回 null", () => {
		const parsed = parseCosUploadUrl(
			"https://6d79-myagent-x-1253451683.cos.ap-shanghai.myqcloud.com/video-agent/acl-probe/discover.txt",
		);
		assert.deepEqual(parsed, { bucket: "6d79-myagent-x-1253451683", region: "ap-shanghai" });
		assert.equal(parseCosUploadUrl("https://env-1.tcb.qcloud.la/x.mp3"), null);
	});

	it("cloudPathFor：按 run/shot 归位（同路径重传即覆盖，幂等）", () => {
		assert.equal(cloudPathFor("run-7", "SH01"), "video-agent/run-7/tts-SH01.mp3");
	});

	it("parseEnvFile：KEY=VALUE / 注释 / 引号值 / 空行容错", () => {
		const parsed = parseEnvFile(
			["# 注释", "", "TCB_ENV_ID=my-env", 'TCB_SECRET_ID="id-with-quotes"', "TCB_SECRET_KEY='sk'", "BROKEN_LINE", "=NOKEY"].join("\n"),
		);
		assert.deepEqual(parsed, { TCB_ENV_ID: "my-env", TCB_SECRET_ID: "id-with-quotes", TCB_SECRET_KEY: "sk" });
	});
});

describe("videoSubmitParamsForDialogue（A2 台词 reference 分支）", () => {
	function makeCtx(model: string): ServerContext {
		return {
			mediaConfig: { media: [{ id: "v", kind: "video", model }], defaults: { concurrency: 1, maxAttempts: 3, priority: 0 } },
		} as unknown as ServerContext;
	}

	it("2.5 系列：mode=reference + audios=[URL]，seconds 字符串（A4b 后读镜长实参）", () => {
		assert.ok(isAgnesVideo25(makeCtx("agnes-video-2.5-flash")));
		const params = videoSubmitParamsForDialogue(makeCtx("agnes-video-2.5-flash"), "https://x/a.mp3", 5);
		assert.deepEqual(params, { seconds: "5", mode: "reference", audios: ["https://x/a.mp3"] });
	});

	it("2.5 系列：不足 4s 按 4s、超 12s 按 12s（与 estimateClipSeconds 同一钳位）", () => {
		const low = videoSubmitParamsForDialogue(makeCtx("agnes-video-2.5-flash"), "https://x/a.mp3", 2);
		assert.equal((low as { seconds: string }).seconds, "4");
		const high = videoSubmitParamsForDialogue(makeCtx("agnes-video-2.5-flash"), "https://x/a.mp3", 15);
		assert.equal((high as { seconds: string }).seconds, "12");
	});

	it("2.0 及其他：audios 被静默忽略（实测）→ 返回 null，调用方降旁白，不赌 400", () => {
		assert.ok(!isAgnesVideo25(makeCtx("agnes-video-v2.0")));
		assert.equal(videoSubmitParamsForDialogue(makeCtx("agnes-video-v2.0"), "https://x/a.mp3", 5), null);
	});
});

describe("dialogueDerivedSec（A4b 以音频反推镜长）", () => {
	it("ceil 后钳进 [4,12]（设计 3.3：ceil(audioDur)）", () => {
		assert.equal(dialogueDerivedSec(4.2), 5);
		assert.equal(dialogueDerivedSec(6.3), 7);
		assert.equal(dialogueDerivedSec(5.0), 5);
		assert.equal(dialogueDerivedSec(3.5), 4, "3.5 → ceil 4（2.5 下限 4）");
		assert.equal(dialogueDerivedSec(12.6), 12, "超上限钳 12");
	});
});

describe("词级时间戳字幕（TTS timestamp=true 返回 JSON · StepFun 实际 shape）", () => {
	it("adapter 应在 TTS JSON 响应（data.url + data.subtitles[0].items，毫秒）里提取 wordTimestamps 并下载音频", async () => {
		const { createOpenAICompatibleAdapter } = await import("../../coding-agent/examples/extensions/studio/media/openai-compatible.ts");
		const adapter = createOpenAICompatibleAdapter({
			id: "step-tts",
			kind: "tts",
			type: "openai-compatible",
			baseUrl: "https://api.stepfun.com",
			path: "/step_plan/v1/audio/speech",
			model: "stepaudio-2.5-tts",
			apiKey: "test",
		});
		const payload = {
			data: {
				url: "https://cdn.example.com/tts.mp3",
				subtitles: [{
					text: "你好世界",
					items: [
						{ text: "你", start_time: 100, end_time: 300 },
						{ text: "好", start_time: 350, end_time: 500 },
						{ text: "世", start_time: 600, end_time: 800 },
						{ text: "界", start_time: 850, end_time: 1100 },
					],
				}],
			},
		};
		const originalFetch = globalThis.fetch;
		let downloadedUrl = "";
		globalThis.fetch = async (url: string) => {
			const u = typeof url === "string" ? url : (url as URL).toString();
			if (u.startsWith("https://cdn.example.com/tts.mp3")) {
				downloadedUrl = u;
				return new Response(new ArrayBuffer(8), { status: 200, headers: { "content-type": "audio/mpeg" } }) as unknown as Response;
			}
			if (u.startsWith("https://api.stepfun.com/step_plan/v1/audio/speech")) {
				return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }) as unknown as Response;
			}
			return originalFetch(url);
		};
		try {
			const tmpDir = mkdtempSync(path.join(tmpdir(), "tts-out-"));
			const result = await adapter.generate({
				kind: "tts",
				prompt: "你好世界",
				params: { timestamp: true, return_url: true },
				outputBase: path.join(tmpDir, "tts-test"),
				signal: new AbortController().signal,
			});
			assert.ok(result.filePath.endsWith(".mp3"));
			assert.equal(result.meta?.url, "https://cdn.example.com/tts.mp3");
			// 毫秒 → 秒转换（StepFun 实际行为）
			assert.deepEqual(result.meta?.wordTimestamps, [
				{ text: "你", start: 0.1, end: 0.3 },
				{ text: "好", start: 0.35, end: 0.5 },
				{ text: "世", start: 0.6, end: 0.8 },
				{ text: "界", start: 0.85, end: 1.1 },
			]);
			assert.equal(downloadedUrl, "https://cdn.example.com/tts.mp3");
			rmSync(tmpDir, { recursive: true, force: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("adapter 应在无 audioUrl 但含 subtitles.items 时仍保留词级时间戳", async () => {
		const { createOpenAICompatibleAdapter } = await import("../../coding-agent/examples/extensions/studio/media/openai-compatible.ts");
		const adapter = createOpenAICompatibleAdapter({
			id: "step-tts",
			kind: "tts",
			type: "openai-compatible",
			baseUrl: "https://api.stepfun.com",
			path: "/step_plan/v1/audio/speech",
			model: "stepaudio-2.5-tts",
			apiKey: "test",
		});
		const payload = {
			data: {
				subtitles: [{
					text: "hello world",
					items: [
						{ text: "hello", start_time: 0, end_time: 300 },
						{ text: "world", start_time: 400, end_time: 800 },
					],
				}],
			},
		};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url: string) => {
			const u = typeof url === "string" ? url : (url as URL).toString();
			if (u.startsWith("https://api.stepfun.com/step_plan/v1/audio/speech")) {
				return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }) as unknown as Response;
			}
			return originalFetch(url);
		};
		try {
			const tmpDir = mkdtempSync(path.join(tmpdir(), "tts-out-"));
			const result = await adapter.generate({
				kind: "tts",
				prompt: "hello world",
				params: { timestamp: true, return_url: true },
				outputBase: path.join(tmpDir, "tts-test2"),
				signal: new AbortController().signal,
			});
			assert.ok(result.filePath.endsWith(".mp3"));
			// 毫秒护栏：items[1].start_time=400 ≥ 100 → 整批按毫秒处理；items[0].start_time=0 也被转换
			assert.deepEqual(result.meta?.wordTimestamps, [
				{ text: "hello", start: 0, end: 0.3 },
				{ text: "world", start: 0.4, end: 0.8 },
			]);
			rmSync(tmpDir, { recursive: true, force: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
