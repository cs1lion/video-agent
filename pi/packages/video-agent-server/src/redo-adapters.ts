/**
 * 重做路径共用的"媒体适配器查找 + 视频请求参数构造"小工具。
 * 从 pipeline.ts 抽出来，让 stages/ 和 redo/ 子目录能直接 import 而无循环依赖。
 *
 * 保持函数零状态：纯查询/拼装，副作用（如 pushEvent / persistRun）由调用方管。
 */

import type { ServerContext } from "./config.ts";
import type { GenerationOptions } from "../../video-agent/src/index.ts";

export type VideoAdapterRef = { id: string; kind: "video"; model?: string };
export type TtsAdapterRef = { id: string; kind: "tts"; model?: string };

/** 查找当前项目的视频适配器（可能未配置——返回 null 让调用方走降级） */
export function videoAdapterOf(ctx: ServerContext): VideoAdapterRef | null {
	const a = ctx.mediaConfig.media.find((m: { kind: string }) => m.kind === "video");
	if (!a) return null;
	return { id: a.id, kind: "video", model: a.model };
}

/** 查找当前项目的 TTS 适配器 */
export function ttsAdapterOf(ctx: ServerContext): TtsAdapterRef | null {
	const a = ctx.mediaConfig.media.find((m: { kind: string }) => m.kind === "tts");
	if (!a) return null;
	return { id: a.id, kind: "tts", model: a.model };
}

/** 视频适配器是否为 Agnes 2.5 系列（OpenAI Videos 兼容参数体系） */
export function isAgnesVideo25(ctx: ServerContext): boolean {
	return /2\.5/.test(ctx.mediaConfig.media.find((a: { kind: string }) => a.kind === "video")?.model ?? "");
}

/**
 * 配额预留用的镜头秒数预估：必须与 videoSubmitParams 实际请求的秒数一致，
 * 否则账本按错误的量纲预留（2.5 系列不足 4s 也按 4s 生成、上限 12s）。
 */
export function estimateClipSeconds(ctx: ServerContext, opts: GenerationOptions): number {
	if (isAgnesVideo25(ctx)) return Math.min(12, Math.max(4, Math.round(opts.clipDurationSec)));
	return opts.clipDurationSec;
}

/**
 * 视频生成请求参数（按适配器代际分支）：
 * - Agnes 2.5：seconds 为字符串 "4"-"12"（不足 4s 按 4s 生成，剪辑阶段裁切）；
 *   width/height/frame_rate/image 均禁传（400）；首帧锚定走 mode=keyframe + first_frame（data URI 已实测可用）。
 * - Agnes 2.0 及其他：像素 + 帧数体系，image 为图生视频。
 */
export function videoSubmitParams(
	ctx: ServerContext,
	opts: GenerationOptions,
	width: number,
	height: number,
	imageDataUrl: string | null,
): Record<string, unknown> {
	if (isAgnesVideo25(ctx)) {
		const seconds = String(Math.min(12, Math.max(4, Math.round(opts.clipDurationSec))));
		return imageDataUrl ? { seconds, mode: "keyframe", first_frame: imageDataUrl } : { seconds, mode: "text" };
	}
	return {
		width,
		height,
		frame_rate: opts.fps,
		seconds: opts.clipDurationSec,
		...(imageDataUrl ? { image: imageDataUrl } : {}),
	};
}
