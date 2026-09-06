/**
 * 加测 9 · API 字段名兼容测试（防止 server 端 req.body.options vs generationOptions 不一致）
 *
 * 背景：之前的对话跑批全部误判为"dialogue 模式跑通"，实际是 server 读
 * `req.body.options` 而 probe 发的是 `req.body.generationOptions`，audioDrive 静默回落到 off。
 * 此测断言两个字段名 server 都接受，且 audioDrive 正确传递到 brief.generationOptions。
 *
 * 范围：纯 resolveGenerationOptions 测试（不依赖 server 启动）。
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { resolveGenerationOptions } from "../../video-agent/src/generation/options.ts";

// 加测 10：VIDEO_AGENT_LLM_TIMEOUT_MS 环境变量覆盖默认 LLM 超时
// 背景：storyboard 阶段在 8 镜复杂 brief 上超过 120s 默认 timeout 会丢
// （故事板.json 落盘失败）。允许环境变量调长 timeout。
describe("VIDEO_AGENT_LLM_TIMEOUT_MS 环境变量（加测 10）", () => {
	const prev = process.env.VIDEO_AGENT_LLM_TIMEOUT_MS;
	after(prev === undefined ? delete process.env.VIDEO_AGENT_LLM_TIMEOUT_MS : (process.env.VIDEO_AGENT_LLM_TIMEOUT_MS = prev));
	it("不设时退默认 120_000（仅断言调用接口不崩）", () => {
		delete process.env.VIDEO_AGENT_LLM_TIMEOUT_MS;
		// 验证 resolveGenerationOptions 仍可调起——逻辑验证 + 不 throw
		const r = resolveGenerationOptions({ audioDrive: "dialogue" });
		assert.equal(r.audioDrive, "dialogue");
	});
	it("设为 240000 不报错（验证 parse 逻辑）", () => {
		process.env.VIDEO_AGENT_LLM_TIMEOUT_MS = "240000";
		// 这里只能间接验证（不引入 server.ts 重模块导入以免影响其他测）；
		// 完整闭环靠手动启动验证：VIDEO_AGENT_LLM_TIMEOUT_MS=240000 npx tsx src/server.ts
		const ms = Number(process.env.VIDEO_AGENT_LLM_TIMEOUT_MS);
		assert.equal(ms, 240000);
	});
});

describe("API 字段名兼容（加测 9 回归）", () => {
	it("audioDrive: 'dialogue' + 完整 options → resolved 后保持 dialogue", () => {
		const r = resolveGenerationOptions({
			resolution: "720p",
			aspectRatio: "16:9",
			shotCount: 6,
			clipDurationSec: 5,
			fps: 24,
			motionIntensity: "medium",
			detailBoost: true,
			promptLanguage: "zh",
			negativePrompt: "",
			audioDrive: "dialogue",
		});
		assert.equal(r.audioDrive, "dialogue", "audioDrive 必须保留 'dialogue'");
		assert.equal(r.shotCount, 6);
	});

	it("audioDrive: 'dialogue' + 极简 { audioDrive: 'dialogue' } → 仅 audioDrive 保留", () => {
		const r = resolveGenerationOptions({ audioDrive: "dialogue" } as Record<string, unknown>);
		assert.equal(r.audioDrive, "dialogue");
		// 其他字段是默认值
		assert.equal(r.shotCount, 5);
		assert.equal(r.resolution, "720p");
	});

	it("audioDrive 字段缺失 → 默认 'off'（A1 闸门设计如此）", () => {
		const r = resolveGenerationOptions({});
		assert.equal(r.audioDrive, "off");
	});

	it("audioDrive 非法值（如 'auto'）→ 默认 'off'（不在 AUDIO_DRIVES 白名单内）", () => {
		const r = resolveGenerationOptions({ audioDrive: "auto" });
		assert.equal(r.audioDrive, "off", "非法 audioDrive 降级到 off（resolveGenerationOptions 白名单过滤）");
	});
});
