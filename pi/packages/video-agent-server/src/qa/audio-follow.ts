/**
 * 台词跟读校验（reference-follow check）—— 「模型自行配音」的确定性防线。
 *
 * 症状（2026-08-30 用户反馈）：成片里人物口型在动、有吐字，但**不是人话**——
 * 这是 reference 模式的已知失败模式（08-29 变体实验记录：跟读失败时音轨与参考
 * 包络相关 -0.227（不可懂），成功时 +0.990），失败音轨会被 export 的
 * keepSourceAudio 原样保留。视觉模型听不出语音可懂度——只有这条数值防线能抓。
 *
 * 方法：把成片段音轨与参考台词音频都降到 8kHz 单声道，按 50ms 窗求 RMS 包络，
 * 容忍 ±1.5s 起点偏移取最大 Pearson 相关。阈值 0.35（实测两态分隔清晰，
 * 取 -0.227 与 +0.990 的中点偏保守侧）。
 */

import { decodeMonoPcm } from "../ffmpeg.ts";

/** 跟读判定阈值：低于它视为「模型自行配音」（不可懂人声）。
 *  2026-08-30 批次实测：0.37/0.38 压线过审的镜头用户听感仍是胡言乱语，
 *  0.82 清晰可懂 → 阈值从 0.35 提到 0.7（08-29 两态实测 -0.227 vs +0.990，
 *  中间带一律按不可懂处理——宁可降级旁白也不放乱语进成片）。 */
export const REFERENCE_FOLLOW_THRESHOLD = 0.7;

/** 窗长 50ms（8kHz 下 400 采样） */
const WINDOW_SAMPLES = 400;
/** 允许的起点偏移（±1.5s，模型可能延迟开口） */
const MAX_SHIFT_SEC = 1.5;

/** RMS 包络（窗 = 50ms；末尾不足一窗的零填充忽略） */
export function envelope(samples: Int16Array, windowSamples = WINDOW_SAMPLES): Float32Array {
	const windows = Math.floor(samples.length / windowSamples);
	const out = new Float32Array(windows);
	for (let w = 0; w < windows; w += 1) {
		let sum = 0;
		for (let i = 0; i < windowSamples; i += 1) {
			const v = samples[w * windowSamples + i]!;
			sum += v * v;
		}
		out[w] = Math.sqrt(sum / windowSamples);
	}
	return out;
}

/** Pearson 相关（零均值归一）；长度不足/零方差返回 0 */
export function pearson(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length);
	if (n < 4) return 0;
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < n; i += 1) {
		ma += a[i]!;
		mb += b[i]!;
	}
	ma /= n;
	mb /= n;
	let num = 0;
	let da = 0;
	let dbb = 0;
	for (let i = 0; i < n; i += 1) {
		const x = a[i]! - ma;
		const y = b[i]! - mb;
		num += x * y;
		da += x * x;
		dbb += y * y;
	}
	if (da <= 1e-9 || dbb <= 1e-9) return 0;
	return num / Math.sqrt(da * dbb);
}

/**
 * 包络互相关：在 ±maxShiftSec 窗口偏移内取最大相关（模型开口可能晚于参考音频）。
 * 纯函数，确定性。
 */
export function envelopeCorrelation(
	clip: Int16Array,
	reference: Int16Array,
	sampleRate = 8000,
	maxShiftSec = MAX_SHIFT_SEC,
): number {
	const ea = envelope(clip);
	const eb = envelope(reference);
	const maxShift = Math.round(maxShiftSec * sampleRate / WINDOW_SAMPLES);
	let best = -1;
	for (let s = -maxShift; s <= maxShift; s += 1) {
		const a = s >= 0 ? ea.subarray(s) : ea;
		const b = s >= 0 ? eb : eb.subarray(-s);
		const c = pearson(a, b);
		if (c > best) best = c;
	}
	return Math.max(0, best);
}

export interface FollowCheckResult {
	follows: boolean;
	/** 包络相关（0-1；越接近 1 越是严格跟读） */
	correlation: number;
}

/**
 * 校验成片段音轨是否跟读了参考台词音频。
 * 任一音轨解码失败（如降级片无音轨）→ follows=false（调用方走降级链）。
 */
export async function referenceFollows(
	cwd: string,
	clipPath: string,
	referenceAudioPath: string,
	signal?: AbortSignal,
	opts: { threshold?: number } = {},
): Promise<FollowCheckResult> {
	const threshold = opts.threshold ?? REFERENCE_FOLLOW_THRESHOLD;
	try {
		const [clipPcm, refPcm] = await Promise.all([
			decodeMonoPcm(cwd, clipPath, 8000, signal),
			decodeMonoPcm(cwd, referenceAudioPath, 8000, signal),
		]);
		const correlation = envelopeCorrelation(clipPcm, refPcm);
		return { follows: correlation >= threshold, correlation };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { follows: false, correlation: 0 };
	}
}
