/**
 * 重做路径共用的"媒体适配器查找 + 视频请求参数构造"小工具。
 * 从 pipeline.ts 抽出来，让 stages/ 和 redo/ 子目录能直接 import 而无循环依赖。
 *
 * 保持函数零状态：纯查询/拼装，副作用（如 pushEvent / persistRun）由调用方管。
 */
/** 查找当前项目的视频适配器（可能未配置——返回 null 让调用方走降级） */
export function videoAdapterOf(ctx) {
    const a = ctx.mediaConfig.media.find((m) => m.kind === "video");
    if (!a)
        return null;
    return { id: a.id, kind: "video", model: a.model };
}
/** 查找当前项目的 TTS 适配器 */
export function ttsAdapterOf(ctx) {
    const a = ctx.mediaConfig.media.find((m) => m.kind === "tts");
    if (!a)
        return null;
    return { id: a.id, kind: "tts", model: a.model };
}
/** 视频适配器是否为 Agnes 2.5 系列（OpenAI Videos 兼容参数体系） */
export function isAgnesVideo25(ctx) {
    return /2\.5/.test(ctx.mediaConfig.media.find((a) => a.kind === "video")?.model ?? "");
}
/**
 * 配额预留用的镜头秒数预估：必须与 videoSubmitParams 实际请求的秒数一致，
 * 否则账本按错误的量纲预留（2.5 系列不足 4s 也按 4s 生成、上限 12s）。
 */
export function estimateClipSeconds(ctx, opts, durationSecOverride) {
    const base = durationSecOverride ?? opts.clipDurationSec;
    if (isAgnesVideo25(ctx))
        return Math.min(12, Math.max(4, Math.round(base)));
    return base;
}
/**
 * A4b：以音频时长反推台词镜镜长（设计 3.3）——ceil(audioDur) 后钳进 2.5-flash
 * 的 seconds 合法区间 [4,12]。需要在 A6 白名单放开（3–12 整数）之后才可行。
 */
export function dialogueDerivedSec(audioDurationSec) {
    return Math.min(12, Math.max(4, Math.ceil(audioDurationSec)));
}
/**
 * 视频生成请求参数（按适配器代际分支）：
 * - Agnes 2.5：seconds 为字符串 "4"-"12"（不足 4s 按 4s 生成，剪辑阶段裁切）；
 *   width/height/frame_rate/image 均禁传（400）；首帧锚定走 mode=keyframe + first_frame（data URI 已实测可用）。
 * - Agnes 2.0 及其他：像素 + 帧数体系，image 为图生视频。
 */
export function videoSubmitParams(ctx, opts, width, height, imageDataUrl, durationSecOverride) {
    const base = durationSecOverride ?? opts.clipDurationSec;
    if (isAgnesVideo25(ctx)) {
        const seconds = String(Math.min(12, Math.max(4, Math.round(base))));
        return imageDataUrl ? { seconds, mode: "keyframe", first_frame: imageDataUrl } : { seconds, mode: "text" };
    }
    return {
        width,
        height,
        frame_rate: opts.fps,
        seconds: base,
        ...(imageDataUrl ? { image: imageDataUrl } : {}),
    };
}
/**
 * 台词镜（音频驱动）的视频提交参数（A2）。
 * 2.5 系列：mode=reference + audios=[公开URL]——prompt 需经
 * `withReferenceAudioInstruction` 注入 `<Audio 1>` 占位符与严格跟读指令
 * （占位符缺失时供应商按无音频处理）。2.0 及其他：audios 被静默忽略
 * （总文档 2.1 实测）——返回 null，调用方按"视频模型不支持音频驱动"降级为
 * 普通生成 + QA 标记，不赌 400。首帧锚定（first_frame）与 reference 混用
 * 未经验证，不传——宁可少一个锚点，不赌一次 400（实测参数体系：2.5 禁传
 * width/height/frame_rate/image）。
 */
export function videoSubmitParamsForDialogue(ctx, audioUrl, durationSec) {
    if (!isAgnesVideo25(ctx))
        return null;
    const seconds = String(Math.min(12, Math.max(4, Math.round(durationSec))));
    return { seconds, mode: "reference", audios: [audioUrl] };
}
/**
 * reference 模式 prompt 注入（08-29 变体实验定案，n=4）：
 * 裸放 `<Audio 1>` 占位符 → 模型自行配音（与参考包络相关 -0.227，语音不可懂）；
 * 指令后置（画面描述在前）→ 0.295～0.781 波动大；**指令前置 → +0.990**
 * （同轮对照：后置 0.781 / 08-28 基线 0.665）。结论：严格跟读指令必须是
 * prompt 第一句。占位符只出现一次。
 */
export function withReferenceAudioInstruction(prompt) {
    return `严格按 <Audio 1> 的内容与节奏说话，声音响起时口型开合、静音时闭嘴。${prompt}`;
}
