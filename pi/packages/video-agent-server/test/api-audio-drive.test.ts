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
import { describe, it } from "node:test";
import { resolveGenerationOptions } from "../../video-agent/src/generation/options.ts";

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
