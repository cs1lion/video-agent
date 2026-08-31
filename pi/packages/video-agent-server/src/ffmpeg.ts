/**
 * ffmpeg 合成层：
 * 1. 逐镜归一化（缩放/补边/统一帧率，TTS 音轨对齐时长，不足静音填充）；
 * 2. assembleTimeline：xfade 转场链 + 旁白 J-cut 定位混音 + BGM 闪避 → 成片；
 *    concatWithSubtitles 作为 xfade 不可用时的降级路径。
 *
 * 所有 ffmpeg 调用以镜头目录为 cwd、使用相对路径，规避 Windows
 * 盘符冒号在 filter 参数里的转义问题。
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;

export class FfmpegError extends Error {}

/** ffprobe 探测媒体时长（秒）；失败或非Finite返回 null（调用方回退估算） */
export function probeDuration(file: string, cwd: string): Promise<number | null> {
	return new Promise((resolve) => {
		execFile(
			"ffprobe",
			["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
			{ cwd, timeout: 30_000, windowsHide: true },
			(error, stdout) => {
				if (error) {
					resolve(null);
					return;
				}
				const sec = Number(String(stdout).trim());
				resolve(Number.isFinite(sec) && sec > 0 ? sec : null);
			},
		);
	});
}

/** 运行 ffmpeg（args 均为相对 cwd 的路径或滤镜参数） */
export function runFfmpeg(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	return runFfmpegCapture(args, cwd, signal).then(({ stdout }) => stdout);
}

/** 同 runFfmpeg，但成功时同时返回 stderr（loudnorm print_format=json 输出在 stderr） */
export function runFfmpegCapture(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"ffmpeg",
			args,
			{ cwd, timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				if (signal?.aborted) {
					reject(new Error("已中止"));
					return;
				}
				if (error) {
					reject(new FfmpegError(`ffmpeg 失败: ${String(stderr).slice(-400)}`));
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			},
		);
		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("exit", () => signal?.removeEventListener("abort", onAbort));
	});
}

/** 从 silencedetect 日志解析静音区间，反转为语音段（秒） */
export function parseSpeechSegments(log: string, totalSec: number, minSilenceSec = 0.25): { start: number; end: number }[] {
	const silences: { start: number; end: number }[] = [];
	let cur: { start: number; end: number } | null = null;
	for (const line of log.split(/\r?\n/)) {
		const sm = line.match(/silence_start:\s*([\d.]+)/);
		if (sm) cur = { start: parseFloat(sm[1]!), end: totalSec };
		const em = line.match(/silence_end:\s*([\d.]+)/);
		if (em && cur) {
			cur.end = parseFloat(em[1]!);
			if (cur.end - cur.start >= minSilenceSec) silences.push(cur);
			cur = null;
		}
	}
	if (cur) {
		cur.end = totalSec;
		if (cur.end - cur.start >= minSilenceSec) silences.push(cur);
	}
	// 静音区间取反 → 语音段
	const speech: { start: number; end: number }[] = [];
	let pos = 0;
	for (const si of silences) {
		if (si.start - pos >= 0.15) speech.push({ start: pos, end: si.start });
		pos = Math.max(pos, si.end);
	}
	if (totalSec - pos >= 0.15) speech.push({ start: pos, end: totalSec });
	return speech;
}

/** 实测媒体文件内的人声/有声段（silencedetect -38dB / 0.25s），供字幕精确对齐 */
export async function detectSpeechSegments(cwd: string, mediaPath: string, signal?: AbortSignal): Promise<{ start: number; end: number }[]> {
	const { stderr } = await runFfmpegCapture(
		["-v", "info", "-i", mediaPath, "-af", "silencedetect=noise=-38dB:d=0.25", "-f", "null", "-"],
		cwd,
		signal,
	);
	const total = (() => {
		const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
		return m ? Number(m[1]!) * 3600 + Number(m[2]!) * 60 + Number(m[3]!) + Number(`0.${m[4]}`) : 0;
	})();
	return parseSpeechSegments(stderr, total);
}

/**
 * 解码任意媒体的单声道 PCM（s16le），供音频比对类校验（台词跟读包络相关性）使用。
 * 8kHz 足够包络分析且体积小（1 分钟 ≈ 960KB）。
 */
export async function decodeMonoPcm(cwd: string, mediaPath: string, sampleRate = 8000, signal?: AbortSignal): Promise<Int16Array> {
	const { stdout } = await runFfmpegCapture(
		["-v", "error", "-i", mediaPath, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"],
		cwd,
		signal,
	);
	const buf = Buffer.from(stdout, "binary");
	const samples = new Int16Array(buf.length >> 1);
	for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readInt16LE(i * 2);
	return samples;
}

// ============================================================================
// 台词停顿插入（A2 · 静音段是表演的一部分）
// ============================================================================

/**
 * 台词 mp3 的停顿插入 filter 串（纯函数，可测——与 buildDmeFilters 同款模式）。
 *
 * v1 近似语义：把 [0, totalSec] 均分为 n+1 段语音，段间依次插入 pausesSec 的
 * 各段静音（每项 = 一处句间停顿的秒数）。近似假设"台词均匀朗读"；
 * 未来升级路径：TTS 时间戳精确落点（等真实链路听感反馈后再做）。
 * 返回 null 表示无需处理（无停顿/非法输入），调用方直接用原音频。
 */
export function buildPauseFilters(totalSec: number, pausesSec: number[]): string | null {
	const pauses = (pausesSec ?? []).filter((p) => Number.isFinite(p) && p > 0);
	if (pauses.length === 0 || !Number.isFinite(totalSec) || totalSec <= 0) return null;
	const seg = totalSec / (pauses.length + 1);
	const fmt = (n: number): string => n.toFixed(3);
	const parts: string[] = [];
	const labels: string[] = [];
	for (let i = 0; i <= pauses.length; i += 1) {
		const start = fmt(i * seg);
		const end = fmt((i + 1) * seg);
		parts.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=mono[a${i}]`);
		labels.push(`[a${i}]`);
		if (i < pauses.length) {
			parts.push(`aevalsrc=0:d=${fmt(pauses[i]!)}:s=44100[s${i}]`);
			labels.push(`[s${i}]`);
		}
	}
	parts.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[out]`);
	return parts.join(";");
}

/**
 * 生成带停顿的台词音频（in/out 均为相对 cwd 的路径）。
 * 输出采样率统一 44100/mono，规避 concat 的规格不一致响亮失败。
 */
export async function insertPauses(o: {
	cwd: string;
	inPath: string;
	outPath: string;
	totalSec: number;
	pausesSec: number[];
	signal?: AbortSignal;
}): Promise<void> {
	const filter = buildPauseFilters(o.totalSec, o.pausesSec);
	if (!filter) {
		await fs.promises.copyFile(path.join(o.cwd, o.inPath), path.join(o.cwd, o.outPath));
		return;
	}
	await runFfmpeg(
		["-y", "-i", o.inPath, "-filter_complex", filter, "-map", "[out]", "-ar", "44100", "-ac", "1", o.outPath],
		o.cwd,
		o.signal,
	);
}

/**
 * A4 时长对齐·尾部补静音：台词音频短于镜长时补齐到 targetSec（留白比硬拉好看，
 * 也让 2.5-flash 的口型在结尾自然闭合）。inputSec ≥ targetSec 时跳过（返回
 * "skipped"，outPath 不产出，调用方继续用 inPath）。统一 44100/mono。
 */
export async function padTailToSec(o: {
	cwd: string;
	inPath: string;
	outPath: string;
	targetSec: number;
	inputSec: number;
	signal?: AbortSignal;
}): Promise<"padded" | "skipped"> {
	const target = Number.isFinite(o.targetSec) && o.targetSec > 0 ? o.targetSec : 0;
	if (!(target > 0) || o.inputSec >= target - 0.05) return "skipped";
	await runFfmpeg(
		[
			"-y",
			"-i",
			o.inPath,
			"-af",
			`apad=whole_dur=${target.toFixed(3)}`,
			"-t",
			target.toFixed(3),
			"-ar",
			"44100",
			"-ac",
			"1",
			o.outPath,
		],
		o.cwd,
		o.signal,
	);
	return "padded";
}

// ============================================================================
// ASS 字幕
// ============================================================================

export interface SubtitleEntry {
	/** 相对成片开头的起始秒 */
	start: number;
	duration: number;
	text: string;
}

function assTime(seconds: number): string {
	const cs = Math.max(0, Math.round(seconds * 100));
	const h = Math.floor(cs / 360000);
	const m = Math.floor((cs % 360000) / 6000);
	const s = Math.floor((cs % 6000) / 100);
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** ASS 文本转义：换行 → \N，花括号防标签注入 */
function assText(text: string): string {
	return text.replace(/\r?\n/g, "\\N").replace(/[{}]/g, "").trim();
}

/** 生成 ASS 字幕文件内容（底部居中，白字黑边，按画幅缩放字号） */
export function buildAssSubtitles(entries: SubtitleEntry[], width: number, height: number): string {
	const fontSize = Math.round(height * 0.052);
	const marginV = Math.round(height * 0.06);
	const events = entries
		.map((entry) => {
			const start = assTime(entry.start);
			const end = assTime(entry.start + entry.duration);
			// ⚠️ Dialogue 字段数必须与下方 Events Format 声明（10 字段）一致：
			// 此前只写 5 字段，字幕文本落进 Name 列、Text 渲染列为空——libass 按 Format
			// 定位解析，渲染出来是空行，烧录字幕从未真正出现在成片里（e2e 抽帧实锤 2026-08-30）。
			// Text 是最后一段（含逗号安全，assText 已转义换行与花括号）。
			return `Dialogue: 0,${start},${end},Sub,,0,0,0,,${assText(entry.text)}`;
		})
		.join("\n");
	return [
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${width}`,
		`PlayResY: ${height}`,
		"WrapStyle: 0",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		`Style: Sub,Microsoft YaHei,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H96000000,0,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(fontSize / 16))},1,2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${marginV},1`,
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		events,
		"",
	].join("\n");
}

// ============================================================================
// 合成步骤
// ============================================================================

/**
 * 归一化单个镜头：视频统一到 WxH/fps/时长，音频对齐时长（TTS 或静音）。
 * 竖版目标（高>宽）采用 center-crop（信息流标准），其余补边（pad）。
 * clipPath/audioPath 均为相对 cwd 的路径。
 */
export async function normalizeShot(options: {
	cwd: string;
	clipPath: string;
	audioPath: string | null;
	/** 无 audioPath 时保留镜头自带音轨（台词镜，A3）；audioPath 存在时本字段无效 */
	keepSourceAudio?: boolean;
	outPath: string;
	width: number;
	height: number;
	fps: number;
	durationSec: number;
	signal?: AbortSignal;
}): Promise<void> {
	const { cwd, clipPath, audioPath, outPath, width, height, fps, durationSec, signal } = options;
	const fitFilter =
		height > width
			? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},`
			: `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,`;
	const videoFilter = `${fitFilter}setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${Math.ceil(durationSec)}`;
	const args = ["-y", "-loglevel", "error", "-i", clipPath];
	if (audioPath) {
		args.push("-i", audioPath);
		args.push("-filter_complex", `[0:v]${videoFilter}[v];[1:a]aresample=48000,apad[a]`, "-map", "[v]", "-map", "[a]");
	} else if (options.keepSourceAudio) {
		// 台词镜：对白在镜头自带音轨里（A3）。主链在 assembleTimeline 按时间轴定位混音，
		// 这里保留源音轨是为降级 concat 路径——硬拼时各镜自带声音，对白不丢。
		// 不变量：调用方保证该镜头确有音轨（台词镜来自音频驱动生成）；违背时 ffmpeg 会响亮失败。
		args.push("-filter_complex", `[0:v]${videoFilter}[v];[0:a]aresample=48000,apad[a]`, "-map", "[v]", "-map", "[a]");
	} else {
		args.push(
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=48000:cl=stereo",
			"-filter_complex",
			`[0:v]${videoFilter}[v];[1:a]atrim=duration=${durationSec + 5}[a]`,
			"-map",
			"[v]",
			"-map",
			"[a]",
		);
	}
	args.push(
		"-t",
		String(durationSec),
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"20",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		outPath,
	);
	await runFfmpeg(args, cwd, signal);
}

/** concat 归一化后的镜头并烧录 ASS 字幕，输出成片（路径均相对 cwd） */
export async function concatWithSubtitles(options: {
	cwd: string;
	shotPaths: string[];
	assPath: string | null;
	outPath: string;
	signal?: AbortSignal;
}): Promise<void> {
	const { cwd, shotPaths, assPath, outPath, signal } = options;
	const listPath = "concat-list.txt";
	await fs.promises.writeFile(
		path.join(cwd, listPath),
		shotPaths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
		"utf-8",
	);
	const args = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath];
	if (assPath) args.push("-vf", `ass=${assPath.replace(/\\/g, "/")}`);
	args.push(
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"19",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		"-movflags",
		"+faststart",
		outPath,
	);
	try {
		await runFfmpeg(args, cwd, signal);
	} finally {
		await fs.promises.rm(path.join(cwd, listPath), { force: true }).catch(() => {});
	}
}

/** 从成片中抽第 shotIndex 镜的中点帧，用于视觉质检（相对 cwd） */
export async function extractFrame(options: {
	cwd: string;
	videoPath: string;
	atSec: number;
	outPath: string;
	signal?: AbortSignal;
}): Promise<void> {
	const { cwd, videoPath, atSec, outPath, signal } = options;
	await runFfmpeg(
		[
			"-y",
			"-loglevel",
			"error",
			"-ss",
			String(Math.max(0, atSec)),
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-q:v",
			"4",
			outPath,
		],
		cwd,
		signal,
	);
}

// ============================================================================
// 时间线合成（转场 + J-cut 旁白 + BGM 闪避）
// ============================================================================

/** EDL 转场类型（cut 走 concat，其余映射 xfade transition） */
export type TransitionType = "cut" | "fade" | "dip" | "white" | "wipeleft" | "slideup";

const XFADE_OF: Record<Exclude<TransitionType, "cut">, string> = {
	fade: "fade",
	dip: "fadeblack",
	white: "fadewhite",
	wipeleft: "wipeleft",
	slideup: "slideup",
};

export const TRANSITION_LABEL: Record<TransitionType, string> = {
	cut: "硬切",
	fade: "叠化",
	dip: "黑场过渡",
	white: "白闪",
	wipeleft: "左擦除",
	slideup: "上滑",
};

export interface TimelineShot {
	/** 归一化后片段（相对 cwd） */
	path: string;
	durationSec: number;
	/** 旁白音频（相对 cwd），null = 该镜无旁白 */
	narrationPath: string | null;
	/** 旁白在成片时间轴上的起点（秒，已含 J-cut 提前量） */
	narrationStartSec: number;
	narrationDurationSec: number;
	/** 字幕文本（null = 无字幕） */
	subtitle: string | null;
	/** 保留镜头自带音轨进混音（台词镜：对白由音频驱动生成，声音就在视频里）。
	 *  缺省 false = 维持现状（源音轨不参与混音，A3 之前的行为）。 */
	keepSourceAudio?: boolean;
}

export interface TimelineTransition {
	/** 转场发生在第 afterShotIndex 镜之后（0-based） */
	afterShotIndex: number;
	type: TransitionType;
	durationSec: number;
	/** 转场音效类型（null = 该切点无音效） */
	sfxType: SfxType | null;
}

/** SFX 音效类型（ffmpeg lavfi 合成，零素材依赖） */
export type SfxType = "whoosh" | "impact" | "riser";

export const SFX_LABEL: Record<SfxType, string> = {
	whoosh: "嗖声",
	impact: "低频冲击",
	riser: "上升音",
};

export interface TimelineSfx {
	/** 成片时间轴上的起点（秒） */
	startSec: number;
	type: SfxType;
	durationSec: number;
}

/** DME 混音链构建参数（输入索引由调用方决定：主遍 = 镜头视频 → 旁白 → 台词源音轨 → BGM；
 *  测量遍不含镜头视频，索引需调用方换算——镜头视频只被 `[i:v]` 消费，不占音频输入） */
export interface DmeInput {
	/** 旁白输入起始索引 */
	narrBase: number;
	/** BGM 输入索引（-1 = 无 BGM） */
	bgmIdx: number;
	/** 旁白轨（路径相对 cwd + 时间轴起点） */
	narrations: { narrationPath: string; narrationStartSec: number }[];
	/** 台词镜源音轨（A3）：对白在镜头自带音轨里，按镜头起点定位进对白层。
	 *  inputIdx 是该音轨在输入列表里的绝对索引；路径供测量遍单独 -i。 */
	sourceAudios?: { inputIdx: number; path: string; startSec: number; durationSec: number }[];
	/** SFX 时间轴 */
	sfx: TimelineSfx[];
	/** 成片总时长（秒），BGM 按 atrim 裁齐 */
	totalSec: number;
}

/**
 * 构建 DME 三层混音 filter_complex 片段：
 * D（对白）旁白 adelay 定位 → amix；台词镜源音轨按镜头起点定位后并入对白总线（A3）；
 * M（音乐）BGM 裁长 + 淡入淡出 → sidechaincompress 被对白闪避；
 * E（音效）lavfi 合成 → adelay 定位。
 * 返回滤镜数组与混音输出标签（供 loudnorm 接续）。
 */
/** 导出供行为测试锁定滤镜串构造语义（test/ffmpeg-mix.test.ts）。
 *  纯函数、无 I/O：混音链是台词模式改造的胜负手（源音轨当前被丢弃），必须可精确断言。 */
export function buildDmeFilters(input: DmeInput): { filters: string[]; preLoud: string; silent: boolean } {
	const { narrBase, bgmIdx, narrations, sfx, totalSec } = input;
	const sources = input.sourceAudios ?? [];
	const filters: string[] = [];
	const narrParts: string[] = [];
	narrations.forEach((n, k) => {
		const ms = Math.max(0, Math.round(n.narrationStartSec * 1000));
		narrParts.push(`[${narrBase + k}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}:all=1[nd${k}]`);
	});
	// 台词源音轨（A3）：对白随镜头自带音轨而来，按镜头在时间轴上的起点精确定位
	// （无 J-cut 提前——口型对齐容不得偏移），先裁到镜长防越界再 adelay。
	const srcParts: string[] = [];
	sources.forEach((s, j) => {
		const ms = Math.max(0, Math.round(s.startSec * 1000));
		srcParts.push(
			`[${s.inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
				`atrim=0:${s.durationSec.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${ms}:all=1[src${j}]`,
		);
	});
	const hasNarr = narrParts.length > 0;
	const hasBgm = bgmIdx >= 0;
	const hasSfx = sfx.length > 0;
	if (hasNarr) {
		filters.push(...narrParts);
		filters.push(
			`${narrations.map((_, k) => `[nd${k}]`).join("")}amix=inputs=${narrations.length}:duration=longest:normalize=0[narr]`,
		);
	}
	if (srcParts.length > 0) filters.push(...srcParts);
	// 对白总线（voice）：旁白与台词源音轨同属 D 层——BGM 闪避与总混只认这条总线，
	// 保证"有人说话就压低 BGM"对旁白与对白一视同仁。
	const voiceParts: string[] = [];
	if (hasNarr) voiceParts.push("narr");
	sources.forEach((_, j) => voiceParts.push(`src${j}`));
	let voice: string | null = null;
	if (voiceParts.length === 1) {
		voice = voiceParts[0]!;
	} else if (voiceParts.length > 1) {
		filters.push(
			`${voiceParts.map((p) => `[${p}]`).join("")}amix=inputs=${voiceParts.length}:duration=longest:normalize=0[voice]`,
		);
		voice = "voice";
	}
	if (hasBgm) {
		filters.push(
			`[${bgmIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${totalSec.toFixed(3)},asetpts=N/SR/TB,` +
				`volume=0.32,afade=t=in:st=0:d=0.7,afade=t=out:st=${Math.max(0, totalSec - 0.9).toFixed(3)}:d=0.9[bgm]`,
		);
	}
	if (hasSfx) {
		sfx.forEach((s, k) => {
			filters.push(sfxSource(k, s));
		});
	}
	// 组合三层：BGM 闪避后的轨 + 对白总线 + SFX
	const mixParts: string[] = [];
	if (hasBgm) {
		if (voice) {
			// 对白作 sidechain 压 BGM：说话时自动闪避
			filters.push(`[bgm][${voice}]sidechaincompress=threshold=0.02:ratio=8:attack=25:release=600[duck]`);
			mixParts.push("duck");
		} else {
			mixParts.push("bgm");
		}
	}
	if (voice) mixParts.push(voice);
	if (hasSfx) {
		mixParts.push(sfx.length > 1 ? "sfxmix" : "sfx0");
		if (sfx.length > 1) {
			filters.push(
				`${sfx.map((_, k) => `[sfx${k}]`).join("")}amix=inputs=${sfx.length}:duration=longest:normalize=0[sfxmix]`,
			);
		}
	}
	if (mixParts.length === 0) {
		filters.push(`anullsrc=r=48000:cl=stereo[premix]`);
		return { filters, preLoud: "premix", silent: true };
	}
	if (mixParts.length === 1) {
		return { filters, preLoud: mixParts[0]!, silent: false };
	}
	filters.push(
		`${mixParts.map((p) => `[${p}]`).join("")}amix=inputs=${mixParts.length}:duration=longest:normalize=0[premix]`,
	);
	return { filters, preLoud: "premix", silent: false };
}

/**
 * 响度测量遍：只跑 DME 音频链（无视频滤镜）+ loudnorm 动态归一，
 * 再挂 ebur128 读回实际 Integrated。短内容下 loudnorm 动态模式的输出
 * 会偏离目标值（高 crest 素材 + TP 约束可差 2~3 LU），需要测出实际值
 * 才能在正式导出时用 volume 精确补偿。失败返回 null（导出不补偿）。
 */
async function measureLoudness(input: {
	cwd: string;
	bgmPath: string | null;
	dme: DmeInput;
	signal?: AbortSignal;
}): Promise<number | null> {
	const { cwd, bgmPath, dme, signal } = input;
	const args: string[] = ["-y", "-hide_banner", "-nostats", "-loglevel", "info"];
	for (const n of dme.narrations) args.push("-i", n.narrationPath);
	for (const s of dme.sourceAudios ?? []) args.push("-i", s.path);
	if (bgmPath) args.push("-stream_loop", "-1", "-i", bgmPath);
	const { filters, preLoud } = buildDmeFilters(dme);
	filters.push(`[${preLoud}]loudnorm=I=-14:TP=-1.5:LRA=11,ebur128=peak=true[meas]`);
	args.push("-filter_complex", filters.join(";"), "-map", "[meas]", "-t", dme.totalSec.toFixed(3), "-f", "null", "-");
	try {
		const { stderr } = await runFfmpegCapture(args, cwd, signal);
		// ebur128 每帧都打 "I: xx LUFS"，取最后一个（汇总行，跑完才输出）
		const all = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
		const last = all.at(-1);
		const lufs = last ? Number(last[1]) : NaN;
		return Number.isFinite(lufs) && lufs > -70 ? lufs : null;
	} catch {
		return null;
	}
}

/**
 * lavfi 合成单个 SFX 音源（filter_complex 片段，输出 [sfxN]）。
 * 音效层级低于旁白（DME 中 E 最弱），音量内置。
 */
function sfxSource(k: number, s: TimelineSfx): string {
	const d = Math.max(0.2, Math.min(1.2, s.durationSec));
	const ms = Math.max(0, Math.round(s.startSec * 1000));
	const fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
	switch (s.type) {
		case "impact":
			return `sine=frequency=63:duration=${d.toFixed(3)},volume=0.32,afade=t=out:st=0:d=${d.toFixed(3)},${fmt},adelay=${ms}:all=1[sfx${k}]`;
		case "riser":
			return `anoisesrc=color=white:duration=${d.toFixed(3)}:seed=${1000 + k},highpass=f=350,volume=0.24,afade=t=in:st=0:d=${(d * 0.8).toFixed(3)},${fmt},adelay=${ms}:all=1[sfx${k}]`;
		default:
			return `anoisesrc=color=pink:duration=${d.toFixed(3)}:seed=${2000 + k},bandpass=f=600:w=900,volume=0.22,afade=t=in:st=0:d=${(d * 0.35).toFixed(3)},afade=t=out:st=${(d * 0.45).toFixed(3)}:d=${(d * 0.55).toFixed(3)},${fmt},adelay=${ms}:all=1[sfx${k}]`;
	}
}

/**
 * 合成成片：视频链（cut→concat / 其他→xfade）+ 旁白 adelay 定位（J-cut）+
 * 台词镜源音轨按镜头起点进对白层（A3，keepSourceAudio）+
 * BGM 循环铺底 + sidechaincompress 闪避 + SFX 音效层（DME 三层混音）+
 * 响度标准化（EBU R128 / 流媒体 -14 LUFS）+ ASS 字幕烧录，一条 filter_complex 完成。
 * 路径均相对 cwd。
 */
export async function assembleTimeline(options: {
	cwd: string;
	shots: TimelineShot[];
	transitions: TimelineTransition[];
	/** 转场音效时间轴（pipeline 按切点编排） */
	sfx: TimelineSfx[];
	/** BGM 音频（相对 cwd），null = 无 BGM */
	bgmPath: string | null;
	assPath: string | null;
	outPath: string;
	signal?: AbortSignal;
}): Promise<{ totalSec: number; usedTransitions: number; sfxUsed: number }> {
	const { cwd, shots, transitions, sfx, bgmPath, assPath, outPath, signal } = options;
	if (shots.length === 0) throw new FfmpegError("时间线为空");

	// ---- 视频链：offset 累进（转场重叠吃掉时长）；同时记录各镜的时间轴起点（台词源音轨定位用） ----
	const transitionOf = (afterIdx: number): TimelineTransition | undefined =>
		transitions.find((t) => t.afterShotIndex === afterIdx);
	const filters: string[] = [];
	// 统一 timebase：mp4 容器流 tb 各异（如 1/12288 与 concat 输出的 1/1000000
	// 不一致会让 xfade 报 Invalid argument，整条时间线降级为硬拼）
	for (let i = 0; i < shots.length; i += 1) {
		filters.push(`[${i}:v]settb=AVTB[st${i}]`);
	}
	const shotStartSec: number[] = [0];
	let prev = "st0";
	let cum = shots[0]!.durationSec;
	let used = 0;
	// 转场预算（2026-08-30 反馈"画面抢戏"）：花哨转场超过切点 1/3 就喧宾夺主——
	// 超出预算一律硬切，让内容而非特效承担节奏
	const maxTransitions = Math.max(1, Math.ceil(shots.length / 3));
	for (let i = 1; i < shots.length; i += 1) {
		const t = transitionOf(i - 1);
		const dur = t?.durationSec ?? 0;
		const usable =
			t !== undefined &&
			t.type !== "cut" &&
			dur >= 0.05 &&
			dur <= 0.8 &&
			used < maxTransitions &&
			cum - dur >= 0.25 &&
			shots[i]!.durationSec > dur;
		const out = `v${i}`;
		if (usable) {
			const offset = Math.max(0, cum - dur);
			filters.push(
				`[${prev}][st${i}]xfade=transition=${XFADE_OF[t!.type as Exclude<TransitionType, "cut">]}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`,
			);
			shotStartSec.push(offset);
			cum = offset + shots[i]!.durationSec;
			used += 1;
		} else {
			// cut：concat filter 无缝续接（也是转场决策缺省/非法值的兜底）
			filters.push(`[${prev}][st${i}]concat=n=2:v=1:a=0[${out}]`);
			shotStartSec.push(cum);
			cum += shots[i]!.durationSec;
		}
		prev = out;
	}
	const totalSec = cum;

	// ---- 输入列表：镜头视频 → 旁白 → 台词源音轨（A3）→ BGM（stream_loop） ----
	const args: string[] = ["-y", "-loglevel", "error"];
	for (const s of shots) args.push("-i", s.path);
	const narrations = shots.filter((s) => s.narrationPath !== null);
	const narrBase = shots.length; // 旁白输入起始索引
	for (const n of narrations) args.push("-i", n.narrationPath!);
	// 台词源音轨：归一化镜头文件再挂一次输入（视频已被 [i:v] 消费，这里单取 [i:a]）
	const sourceShots = shots
		.map((s, shotIdx) => ({ shot: s, shotIdx }))
		.filter((x) => x.shot.keepSourceAudio);
	const srcBase = narrBase + narrations.length;
	for (const x of sourceShots) args.push("-i", x.shot.path);
	let bgmIdx = -1;
	if (bgmPath) {
		bgmIdx = srcBase + sourceShots.length;
		args.push("-stream_loop", "-1", "-i", bgmPath);
	}
	const sourceAudios = sourceShots.map((x, j) => ({
		inputIdx: srcBase + j,
		path: x.shot.path,
		startSec: shotStartSec[x.shotIdx]!,
		durationSec: x.shot.durationSec,
	}));

	// ---- 字幕烧录 ----
	let vOut = prev;
	if (assPath) {
		filters.push(`[${vOut}]ass=${assPath.replace(/\\/g, "/")}[vout]`);
		vOut = "vout";
	}

	// ---- 音频链：DME 三层混音（构建函数见上） ----
	const dme = buildDmeFilters({
		narrBase,
		bgmIdx,
		narrations: narrations.map((n) => ({
			narrationPath: n.narrationPath!,
			narrationStartSec: n.narrationStartSec,
		})),
		sourceAudios,
		sfx,
		totalSec,
	});
	filters.push(...dme.filters);

	// ---- 响度标准化：两遍法（EBU R128 / 流媒体 -14 LUFS） ----
	// Pass 1（测量遍）跑同一条 loudnorm 动态链读回实际 Integrated I₁；
	// Pass 2 在 loudnorm 后接 volume=补偿增益 + alimiter 限峰。
	// 原因：短内容 + 高 crest 素材下 loudnorm 动态模式输出偏离目标 2~3 LU
	// （TP=-1.5 约束下 linear 模式会被自动回退），只能测量后精确补偿；
	// limiter 削峰会吃掉约 2 LU 响度，一并计入补偿量。
	let comp = "";
	if (!dme.silent) {
		const measured = await measureLoudness({
			cwd,
			bgmPath,
			dme: {
				narrBase: 0,
				bgmIdx: bgmIdx >= 0 ? narrations.length + sourceAudios.length : -1,
				narrations: narrations.map((n) => ({
					narrationPath: n.narrationPath!,
					narrationStartSec: n.narrationStartSec,
				})),
				sourceAudios: sourceAudios.map((s, j) => ({ ...s, inputIdx: narrations.length + j })),
				sfx,
				totalSec,
			},
			signal,
		});
		if (measured !== null) {
			const gainDb = Math.min(6, Math.max(0, -14 - measured + 2.0));
			if (gainDb >= 0.05) {
				comp = `volume=${gainDb.toFixed(2)}dB,alimiter=limit=0.8413:attack=1:release=10:level=disabled`;
			}
		}
	}
	// loudnorm 会升采样到 192k，需 aresample 回 48k
	const tail = comp ? `,${comp}` : "";
	filters.push(`[${dme.preLoud}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000${tail}[aout]`);
	const aOut = "aout";

	args.push(
		"-filter_complex",
		filters.join(";"),
		"-map",
		`[${vOut}]`,
		"-map",
		`[${aOut}]`,
		"-t",
		totalSec.toFixed(3),
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"19",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		"-movflags",
		"+faststart",
		outPath,
	);
	await runFfmpeg(args, cwd, signal);
	return { totalSec, usedTransitions: used, sfxUsed: sfx.length };
}
