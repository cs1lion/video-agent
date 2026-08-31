/**
 * 生成质量选项 —— UI 提供给用户的常用质量调优项。
 *
 * 这些选项独立于访谈（Intent/directives 管"创意方向"，
 * 这里管"技术参数"），最终一并进入 EnrichedBrief 交给管线。
 * 全部字段带默认值与白名单校验：非法输入回退默认，不抛错。
 */
export const MIN_SHOTS = 3;
export const MAX_SHOTS = 30;
/** 分镜数预设（Quick select）。长片场景在共创实验室已开放至 30。 */
export const SHOT_COUNT_PRESETS = [3, 4, 5, 6, 8, 10, 12, 15];
/** 分辨率 → 像素宽高（按画幅换算） */
const RESOLUTION_BASE = {
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
};
export const DEFAULT_GENERATION_OPTIONS = {
    resolution: "720p",
    aspectRatio: "16:9",
    shotCount: 5,
    clipDurationSec: 5,
    fps: 24,
    motionIntensity: "medium",
    detailBoost: true,
    promptLanguage: "zh",
    negativePrompt: NEGATIVE_PROMPT_PRESETS.cleanProduct.value,
    audioDrive: "off",
};
const RESOLUTIONS = ["480p", "720p", "1080p"];
const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3"];
const CLIP_DURATION_MIN = 3;
const CLIP_DURATION_MAX = 12;
const FPS_VALUES = [24, 30, 60];
const MOTION_INTENSITIES = ["low", "medium", "high"];
const AUDIO_DRIVES = ["off", "dialogue"];
/** 镜头数范围校验（替代原白名单）
 *  越界或小数 →默认，与其他字段一致（程序性异常而非用户选择）。
 *  UI 输入框限定 MIN..MAX，用户路径不会触发越界。 */
function clampShotCount(value) {
    const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
    if (!Number.isFinite(n) || n < MIN_SHOTS || n > MAX_SHOTS) {
        return DEFAULT_GENERATION_OPTIONS.shotCount;
    }
    return n;
}
/**
 * 合并用户输入与默认值：逐字段白名单校验，非法值回退默认。
 * 负向提示词不校验内容（自由文本），seed 保留正整数。
 */
export function resolveGenerationOptions(partial) {
    if (!partial)
        return { ...DEFAULT_GENERATION_OPTIONS };
    const merged = {
        resolution: RESOLUTIONS.includes(partial.resolution)
            ? partial.resolution
            : DEFAULT_GENERATION_OPTIONS.resolution,
        aspectRatio: ASPECT_RATIOS.includes(partial.aspectRatio)
            ? partial.aspectRatio
            : DEFAULT_GENERATION_OPTIONS.aspectRatio,
        shotCount: clampShotCount(partial.shotCount),
        clipDurationSec: (() => {
            // A6：白名单 [3,5,8,10] 放开为 3–12 整数区间——台词镜的"以音频反推镜长"
            // （A4b，ceil(audioDur) 钳 4–12）需要任意整数镜长；UI 快捷档不变。
            // 上界 12 对齐 2.5-flash 的 seconds 上限。
            const v = partial.clipDurationSec;
            return Number.isInteger(v) && v >= CLIP_DURATION_MIN && v <= CLIP_DURATION_MAX
                ? v
                : DEFAULT_GENERATION_OPTIONS.clipDurationSec;
        })(),
        fps: FPS_VALUES.includes(partial.fps) ? partial.fps : DEFAULT_GENERATION_OPTIONS.fps,
        motionIntensity: MOTION_INTENSITIES.includes(partial.motionIntensity)
            ? partial.motionIntensity
            : DEFAULT_GENERATION_OPTIONS.motionIntensity,
        detailBoost: typeof partial.detailBoost === "boolean" ? partial.detailBoost : true,
        promptLanguage: partial.promptLanguage === "en" ? "en" : "zh",
        negativePrompt: typeof partial.negativePrompt === "string"
            ? partial.negativePrompt
            : DEFAULT_GENERATION_OPTIONS.negativePrompt,
    };
    if (AUDIO_DRIVES.includes(partial.audioDrive)) {
        merged.audioDrive = partial.audioDrive;
    }
    else {
        merged.audioDrive = "off";
    }
    if (typeof partial.seed === "number" && Number.isInteger(partial.seed) && partial.seed >= 0) {
        merged.seed = partial.seed;
    }
    return merged;
}
/** 分辨率 + 画幅 → 具体像素尺寸（宽高均为偶数，编码器友好） */
export function pixelDimensions(resolution, aspectRatio) {
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
function even(n) {
    const rounded = Math.round(n);
    return rounded % 2 === 0 ? rounded : rounded + 1;
}
