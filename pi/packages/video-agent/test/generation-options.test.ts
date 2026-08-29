import { describe, expect, test } from "vitest";
import {
	DEFAULT_GENERATION_OPTIONS,
	NEGATIVE_PROMPT_PRESETS,
	pixelDimensions,
	resolveGenerationOptions,
} from "../src/generation/options.ts";

describe("生成质量选项", () => {
	test("默认值完整", () => {
		const defaults = DEFAULT_GENERATION_OPTIONS;
		expect(defaults.resolution).toBe("720p");
		expect(defaults.aspectRatio).toBe("16:9");
		expect(defaults.shotCount).toBe(5);
		expect(defaults.clipDurationSec).toBe(5);
		expect(defaults.fps).toBe(24);
		expect(defaults.motionIntensity).toBe("medium");
		expect(defaults.detailBoost).toBe(true);
		expect(defaults.promptLanguage).toBe("zh");
		expect(defaults.negativePrompt).toContain("watermark");
		expect(defaults.seed).toBeUndefined();
		expect(defaults.audioDrive).toBe("off");
	});

	test("空/undefined 输入返回默认副本", () => {
		expect(resolveGenerationOptions()).toEqual(DEFAULT_GENERATION_OPTIONS);
		expect(resolveGenerationOptions({})).toEqual(DEFAULT_GENERATION_OPTIONS);
	});

	test("合法字段透传", () => {
		const resolved = resolveGenerationOptions({
			resolution: "1080p",
			aspectRatio: "9:16",
			shotCount: 3,
			clipDurationSec: 10,
			fps: 60,
			motionIntensity: "high",
			detailBoost: false,
			promptLanguage: "en",
			negativePrompt: "custom",
			seed: 7,
			audioDrive: "dialogue",
		});
		expect(resolved).toMatchObject({
			resolution: "1080p",
			aspectRatio: "9:16",
			shotCount: 3,
			clipDurationSec: 10,
			fps: 60,
			motionIntensity: "high",
			detailBoost: false,
			promptLanguage: "en",
			negativePrompt: "custom",
			seed: 7,
			audioDrive: "dialogue",
		});
	});

	test("A6：镜长白名单放开为 3–12 整数区间（台词镜以音频反推镜长的前提）", () => {
		// 原白名单 [3,5,8,10] 会把 7 静默钳回 5；现在 7、4、12 都是合法档位
		expect(resolveGenerationOptions({ clipDurationSec: 7 }).clipDurationSec).toBe(7);
		expect(resolveGenerationOptions({ clipDurationSec: 4 }).clipDurationSec).toBe(4);
		expect(resolveGenerationOptions({ clipDurationSec: 12 }).clipDurationSec).toBe(12);
		expect(resolveGenerationOptions({ clipDurationSec: 3 }).clipDurationSec).toBe(3);
		// 非整数 / 越界仍回退默认
		expect(resolveGenerationOptions({ clipDurationSec: 7.5 as never }).clipDurationSec).toBe(5);
		expect(resolveGenerationOptions({ clipDurationSec: 2 as never }).clipDurationSec).toBe(5);
		expect(resolveGenerationOptions({ clipDurationSec: 13 as never }).clipDurationSec).toBe(5);
	});

	test("非法值回退默认（白名单校验）", () => {
		const resolved = resolveGenerationOptions({
			resolution: "8k" as never,
			aspectRatio: "21:9" as never,
			// 50 超出 MAX_SHOTS=30，按范围校验回退默认；中间值（如 9、20）现在合法不再回退
			shotCount: 50 as never,
			// A6：3–12 整数合法化（台词镜"以音频反推镜长"需要任意整数）；13 越界回退
			clipDurationSec: 13 as never,
			fps: 48 as never,
			motionIntensity: "extreme" as never,
			detailBoost: "yes" as never,
			promptLanguage: "fr" as never,
			seed: -3,
			audioDrive: "lip-sync" as never,
		});
		expect(resolved.resolution).toBe("720p");
		expect(resolved.aspectRatio).toBe("16:9");
		expect(resolved.shotCount).toBe(5);
		expect(resolved.clipDurationSec).toBe(5);
		expect(resolved.fps).toBe(24);
		expect(resolved.motionIntensity).toBe("medium");
		expect(resolved.detailBoost).toBe(true);
		expect(resolved.promptLanguage).toBe("zh");
		expect(resolved.seed).toBeUndefined();
		expect(resolved.audioDrive).toBe("off");
	});

	test("audioDrive 白名单：dialogue 透传，缺省与非法值一律 off", () => {
		// 台词模式是闸门管控能力（服务端只对共创来源放行），选项层只做白名单校验
		expect(resolveGenerationOptions({ audioDrive: "dialogue" }).audioDrive).toBe("dialogue");
		expect(resolveGenerationOptions({ audioDrive: "off" }).audioDrive).toBe("off");
		expect(resolveGenerationOptions().audioDrive).toBe("off");
		expect(resolveGenerationOptions({ audioDrive: "" as never }).audioDrive).toBe("off");
		expect(resolveGenerationOptions({ audioDrive: true as never }).audioDrive).toBe("off");
	});

	test("范围内任意分镜数（包上下限）合法通过", () => {
		// 边界：MIN_SHOTS 和 MAX_SHOTS，以及中段长片场景
		expect(resolveGenerationOptions({ shotCount: 3 as never }).shotCount).toBe(3);
		expect(resolveGenerationOptions({ shotCount: 12 as never }).shotCount).toBe(12);
		expect(resolveGenerationOptions({ shotCount: 30 as never }).shotCount).toBe(30);
		// 上下限外回退默认
		expect(resolveGenerationOptions({ shotCount: 2 as never }).shotCount).toBe(5);
		expect(resolveGenerationOptions({ shotCount: 31 as never }).shotCount).toBe(5);
		// 非整数舍入（保持整数）
		expect(resolveGenerationOptions({ shotCount: 7.9 as never }).shotCount).toBe(7);
	});

	test("非整数 seed 被丢弃", () => {
		expect(resolveGenerationOptions({ seed: 3.14 }).seed).toBeUndefined();
		expect(resolveGenerationOptions({ seed: 0 }).seed).toBe(0);
	});

	test("负向提示词预设：clean-product 覆盖实战高频排除项", () => {
		const value = NEGATIVE_PROMPT_PRESETS.cleanProduct.value;
		for (const keyword of ["watermark", "garbled text", "UI overlays", "debug frames", "distorted hands"]) {
			expect(value).toContain(keyword);
		}
		expect(NEGATIVE_PROMPT_PRESETS.none.value).toBe("");
	});
});

describe("pixelDimensions", () => {
	test("16:9 标准尺寸", () => {
		expect(pixelDimensions("720p", "16:9")).toEqual({ width: 1280, height: 720 });
		expect(pixelDimensions("1080p", "16:9")).toEqual({ width: 1920, height: 1080 });
	});

	test("9:16 竖版", () => {
		expect(pixelDimensions("720p", "9:16")).toEqual({ width: 720, height: 1280 });
	});

	test("1:1 与 4:3", () => {
		expect(pixelDimensions("480p", "1:1")).toEqual({ width: 480, height: 480 });
		expect(pixelDimensions("480p", "4:3")).toEqual({ width: 640, height: 480 });
	});

	test("结果始终为偶数（编码器友好）", () => {
		// 480*16/9 = 853.33 → 854
		expect(pixelDimensions("480p", "16:9")).toEqual({ width: 854, height: 480 });
	});
});
