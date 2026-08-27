/**
 * 生成质量选项 —— UI 提供给用户的常用质量调优项。
 *
 * 这些选项独立于访谈（Intent/directives 管"创意方向"，
 * 这里管"技术参数"），最终一并进入 EnrichedBrief 交给管线。
 * 全部字段带默认值与白名单校验：非法输入回退默认，不抛错。
 */

import type { Locale } from "../clarify/types.ts";

export type Resolution = "480p" | "720p" | "1080p";
export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3";
export type ClipDurationSec = 3 | 5 | 8 | 10;
export type Fps = 24 | 30 | 60;
export type MotionIntensity = "low" | "medium" | "high";
export type ShotCount = 3 | 4 | 5 | 6;

export interface GenerationOptions {
	/** 输出分辨率 */
	resolution: Resolution;
	/** 画幅比例 */
	aspectRatio: AspectRatio;
	/** 镜头数（3-6，越多叙事越完整但生成时间与成本越高） */
	shotCount: ShotCount;
	/** 单镜头时长（秒） */
	clipDurationSec: ClipDurationSec;
	/** 帧率 */
	fps: Fps;
	/** 运动强度（运镜/画面动态幅度） */
	motionIntensity: MotionIntensity;
	/** 细节增强（画质增强开关） */
	detailBoost: boolean;
	/** 生成内容语言：旁白与字幕用中文还是英文（中英可选） */
	promptLanguage: Locale;
	/** 负向提示词：排除项（逗号分隔），见预设 */
	negativePrompt: string;
	/** 随机种子（可选）：固定后同参数可复现 */
	seed?: number;
}

/** 分辨率 → 像素宽高（按画幅换算） */
const RESOLUTION_BASE: Record<Resolution, number> = {
	"480p": 480,
	"720p": 720,
	"1080p": 1080,
};

/** 负向提示词预设（来自实战教训：文字乱码/水印/HUD 残留/手部畸变） */
export const NEGATIVE_PROMPT_PRESETS = {
	cleanProduct: {
		id: "clean-product",
		label: { zh: "干净产品片", en: "Clean product" },
		value: "watermark, garbled text, on-screen captions, UI overlays, debug frames, low resolution, blur, distorted hands, extra fingers, morphing objects",
	},
	portrait: {
		id: "portrait",
		label: { zh: "人物出镜", en: "Portrait" },
		value: "watermark, garbled text, UI overlays, debug frames, low resolution, blur, distorted face, asymmetric eyes, distorted hands, extra fingers",
	},
	stylized: {
		id: "stylized",
		label: { zh: "风格化动画", en: "Stylized" },
		value: "watermark, garbled text, UI overlays, photorealistic skin texture, low resolution, blur",
	},
	none: {
		id: "none",
		label: { zh: "不排除", en: "None" },
		value: "",
	},
} as const;

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
	resolution: "720p",
	aspectRatio: "16:9",
	shotCount: 5,
	clipDurationSec: 5,
	fps: 24,
	motionIntensity: "medium",
	detailBoost: true,
	promptLanguage: "zh",
	negativePrompt: NEGATIVE_PROMPT_PRESETS.cleanProduct.value,
};

const RESOLUTIONS: readonly Resolution[] = ["480p", "720p", "1080p"];
const ASPECT_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3"];
const SHOT_COUNTS: readonly ShotCount[] = [3, 4, 5, 6];
const CLIP_DURATIONS: readonly ClipDurationSec[] = [3, 5, 8, 10];
const FPS_VALUES: readonly Fps[] = [24, 30, 60];
const MOTION_INTENSITIES: readonly MotionIntensity[] = ["low", "medium", "high"];

/**
 * 合并用户输入与默认值：逐字段白名单校验，非法值回退默认。
 * 负向提示词不校验内容（自由文本），seed 保留正整数。
 */
export function resolveGenerationOptions(partial?: Partial<GenerationOptions>): GenerationOptions {
	if (!partial) return { ...DEFAULT_GENERATION_OPTIONS };
	const merged: GenerationOptions = {
		resolution: RESOLUTIONS.includes(partial.resolution as Resolution)
			? (partial.resolution as Resolution)
			: DEFAULT_GENERATION_OPTIONS.resolution,
		aspectRatio: ASPECT_RATIOS.includes(partial.aspectRatio as AspectRatio)
			? (partial.aspectRatio as AspectRatio)
			: DEFAULT_GENERATION_OPTIONS.aspectRatio,
		shotCount: SHOT_COUNTS.includes(partial.shotCount as ShotCount)
			? (partial.shotCount as ShotCount)
			: DEFAULT_GENERATION_OPTIONS.shotCount,
		clipDurationSec: CLIP_DURATIONS.includes(partial.clipDurationSec as ClipDurationSec)
			? (partial.clipDurationSec as ClipDurationSec)
			: DEFAULT_GENERATION_OPTIONS.clipDurationSec,
		fps: FPS_VALUES.includes(partial.fps as Fps) ? (partial.fps as Fps) : DEFAULT_GENERATION_OPTIONS.fps,
		motionIntensity: MOTION_INTENSITIES.includes(partial.motionIntensity as MotionIntensity)
			? (partial.motionIntensity as MotionIntensity)
			: DEFAULT_GENERATION_OPTIONS.motionIntensity,
		detailBoost: typeof partial.detailBoost === "boolean" ? partial.detailBoost : true,
		promptLanguage: partial.promptLanguage === "en" ? "en" : "zh",
		negativePrompt:
			typeof partial.negativePrompt === "string"
				? partial.negativePrompt
				: DEFAULT_GENERATION_OPTIONS.negativePrompt,
	};
	if (typeof partial.seed === "number" && Number.isInteger(partial.seed) && partial.seed >= 0) {
		merged.seed = partial.seed;
	}
	return merged;
}

/** 分辨率 + 画幅 → 具体像素尺寸（宽高均为偶数，编码器友好） */
export function pixelDimensions(resolution: Resolution, aspectRatio: AspectRatio): { width: number; height: number } {
	const base = RESOLUTION_BASE[resolution];
	switch (aspectRatio) {
		case "16:9":
			return { width: even((base * 16) / 9), height: base };
		case "9:16":
			return { width: base, height: even((base * 16) / 9) };
		case "1:1":
			return { width: base, height: base };
		case "4:3":
			return { width: even((base * 4) / 3), height: base };
	}
}

function even(n: number): number {
	const rounded = Math.round(n);
	return rounded % 2 === 0 ? rounded : rounded + 1;
}
