/**
 * 跳过 adapter，直接用 node fetch 打 StepFun TTS，dump raw response。
 * 目的：定位 L1 失败根因（参数被拒？回错字段？451 指纹问题？）
 *
 * 用法：node e2e/dump-stepfun-tts.mjs
 */

import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(".pi-studio/models.json", "utf-8"));
const tts = cfg.media.find((m) => m.kind === "tts");
console.log("[dump] baseUrl:", tts.baseUrl);
console.log("[dump] path:", tts.path);
console.log("[dump] model:", tts.model);
console.log("[dump] voice:", tts.voice);

// 测试 4 种参数组合，每种都 dump 完整响应
const cases = [
	{
		name: "A · 默认（基线对照，无 timestamp/return_url）",
		body: { model: tts.model, input: "今天天气真不错，咱们去吃点东西吧。", voice: tts.voice },
	},
	{
		name: "B · timestamp=true + return_url=true（目标方案）",
		body: { model: tts.model, input: "今天天气真不错，咱们去吃点东西吧。", voice: tts.voice, timestamp: true, return_url: true },
	},
	{
		name: "C · stream_format=sse（备选方案）",
		body: { model: tts.model, input: "今天天气真不错，咱们去吃点东西吧。", voice: tts.voice, stream_format: "sse", timestamp: true },
	},
	{
		name: "D · instruction 也带（看 instruction 是不是 451 触发点）",
		body: { model: tts.model, input: "今天天气真不错，咱们去吃点东西吧。", voice: tts.voice, instruction: "中性自然", timestamp: true, return_url: true },
	},
];

for (const c of cases) {
	console.log(`\n${"=".repeat(60)}\n${c.name}\n${"=".repeat(60)}`);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 60_000);
	try {
		const resp = await fetch(tts.baseUrl + tts.path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": "Bearer " + tts.apiKey,
			},
			body: JSON.stringify(c.body),
			signal: ctrl.signal,
		});
		clearTimeout(timer);
		console.log("status:", resp.status);
		console.log("content-type:", resp.headers.get("content-type"));
		const text = await resp.text();
		console.log("size:", text.length, "bytes");
		console.log("body (前 1500 字符):");
		console.log(text.slice(0, 1500));
	} catch (e) {
		clearTimeout(timer);
		console.log("error:", e.message);
	}
}
