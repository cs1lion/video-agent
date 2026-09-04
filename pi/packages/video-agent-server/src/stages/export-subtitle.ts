/**
 * 台词字幕起止纯函数（stageExport 用）。
 *
 * N1 · ROADMAP 近期「词级时间戳字幕」：把字幕起止锚到实测 TTS 词时间上，
 * 替代之前「镜起点 + 整镜覆盖」估算。逻辑三层回退（按精度由高到低）：
 *   ① 词级时间戳（wordTimestamps）：TTS `timestamp=true` 返回的 words 数组
 *   ② silencedetect 实测：本地 TTS 音频二次核位（消费 stream_segments）
 *   ③ 三重收束：起点=镜切点、时长=min(镜长-0.3, 下一切点-0.1, 人声+0.8)——
 *      末镜不允许超过视频边界（避免 end > final.mp4 duration）。
 *
 * 抽纯函数的动机：stageExport 单测成本太高（要 mock ffmpeg/queue/LLM）；
 * 这里只测「给定输入算 subStart/subDur」三段行为契约。
 */

export interface DialogueSubtitleArgs {
	/** 本镜在时间线上的起点（秒） */
	shotStart: number;
	/** 本镜时长（秒） */
	shotDur: number;
	/** 下一镜在时间线上的起点（秒；末镜 = Infinity） */
	nextShotStart: number;
	/** 实测台词人声时长（停顿后、垫尾前；与 audioDurationSec 同义但更准确） */
	speechSec: number;
	/** TTS 词级时间戳（可选；首尾词的 start/end 决定字幕起止） */
	wordTimestamps?: { text: string; start: number; end: number }[];
}

export interface DialogueSubtitleResult {
	subStart: number;
	subDur: number;
}

/** 三重收束：起点=本镜切点、时长=min(镜长-0.3, 下一切点-0.1, 人声+0.8) */
export function fallbackSubtitleTiming(args: DialogueSubtitleArgs): DialogueSubtitleResult {
	const subStart = args.shotStart;
	const subDur = Math.max(0.8, Math.min(
		args.shotDur - 0.3,
		args.nextShotStart - args.shotStart - 0.1,
		args.speechSec + 0.8,
	));
	return { subStart, subDur };
}

/** silencedetect 实测：用语音段首尾推算字幕起止（与词时间戳同等精度档位的回落） */
export function measuredSubtitleTiming(
	args: DialogueSubtitleArgs,
	segments: { start: number; end: number }[],
): DialogueSubtitleResult {
	if (segments.length === 0) return fallbackSubtitleTiming(args);
	const maxSubEnd = args.shotStart + args.shotDur;
	const subStart = args.shotStart + segments[0]!.start;
	const subDur = Math.max(0.8, Math.min(
		segments[segments.length - 1]!.end - segments[0]!.start + 0.5,
		args.nextShotStart - subStart - 0.1,
		maxSubEnd - subStart,
	));
	return { subStart, subDur };
}

/** 词级时间戳：起=首词 start、止=末词 end+0.5s 收尾（与 silencedetect 等价的 +0.5 余量） */
export function wordTimestampSubtitleTiming(args: DialogueSubtitleArgs): DialogueSubtitleResult | null {
	if (!args.wordTimestamps || args.wordTimestamps.length === 0) return null;
	const maxSubEnd = args.shotStart + args.shotDur;
	const subStart = args.shotStart + args.wordTimestamps[0]!.start;
	const subDur = Math.max(0.8, Math.min(
		args.wordTimestamps[args.wordTimestamps.length - 1]!.end - args.wordTimestamps[0]!.start + 0.5,
		args.nextShotStart - subStart - 0.1,
		maxSubEnd - subStart,
	));
	return { subStart, subDur };
}
