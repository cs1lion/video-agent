/**
 * 真实生成管线：剧本 → 美术设计 → 镜头提示词+关键帧 → 镜头生成 → 音频 → 剪辑导出。
 *
 * - 文本阶段走 LLM（chatJson / chatVisionJson，严格 JSON）；
 * - 媒体阶段复用 studio 的 GenerationQueue（并发/限速/重试）；
 * - 导出阶段 ffmpeg 逐镜归一化 + concat + ASS 字幕烧录；
 * - 质检：每镜抽帧送视觉模型评分（briefFit/visualConsistency/pacing/textQuality），
 *   audioSync 由 TTS 成功率确定性计算 —— 不编造分数。
 *
 * 团队事件流：管线在关键交接点产出 TeamEvent（制片人/编剧/美术指导/分镜师/
 * 技术导演/声音设计/剪辑师/审片员），供 UI「团队频道」可视化角色协作。
 *
 * 确认闸门（视频生成额度昂贵，未确认不得烧钱）：
 *   gate=design     美术设计（风格+人物/场景概念图）完成后暂停，用户确认或改图再确认；
 *   gate=keyframes  分镜关键帧全部完成后暂停，用户确认或单镜重绘再确认；
 *   确认走 resumeRun（同时清闸门），之后才进入视频生成。
 *
 * 微调与续跑：六个阶段全部函数化 ——
 *   refineRun  重跑单个文本阶段（带用户指令，产物重塑）；
 *   resumeRun  确认闸门 / 从最早未完成阶段继续推进到导出。
 *
 * 运行目录：.pi-studio/video-agent-runs/<时间戳>-<slug>/，
 * 产物：script.json / visual-bible.json / prompts.json / assets/* / final.mp4。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { GenerationQueue } from "../../coding-agent/examples/extensions/studio/media/queue.ts";
import {
	type AspectRatio,
	type CoCreationSpace,
	type EnrichedBrief,
	type GenerationOptions,
	pixelDimensions,
	resolveGenerationOptions,
} from "../../video-agent/src/index.ts";
import type { ServerContext } from "./config.ts";
import {
	assembleTimeline,
	buildAssSubtitles,
	concatWithSubtitles,
	extractFrame,
	normalizeShot,
	probeDuration,
	SFX_LABEL,
	type SfxType,
	type SubtitleEntry,
	type TimelineSfx,
	type TimelineShot,
	type TimelineTransition,
	TRANSITION_LABEL,
	type TransitionType,
} from "./ffmpeg.ts";
import { chat, chatJson, chatVisionJson } from "./llm.ts";
import {
	type DesignBibleDoc,
	type DesignEntity,
	designBibleMessages,
	designSheetPrompt,
	type EdlDoc,
	edlPrompt,
	fallbackVoiceDirection,
	type KeyframeEntry,
	type KeyframesDoc,
	keyframePrompt,
	narrationFor,
	normalizeDesignDoc,
	PROMPT_VERSION,
	rettsNarrationMessages,
	type ScriptDoc,
	type ShotPromptDoc,
	scriptMessages,
	shotPromptMessages,
	type VisualBible,
	visualBibleMessages,
	voiceDirectionsMessages,
} from "./prompts.ts";

// ============================================================================
// Run 状态（与 UI 契约 RunView 一一对应）
// ============================================================================

export type StageId = "script" | "visual" | "prompts" | "clips" | "audio" | "export";
const STAGE_IDS: readonly StageId[] = ["script", "visual", "prompts", "clips", "audio", "export"];
/** 文本阶段（可单独 refine 重塑） */
const TEXT_STAGES: readonly StageId[] = ["script", "visual", "prompts"];

export type AxisId = "briefFit" | "visualConsistency" | "pacing" | "audioSync" | "textQuality";

export interface RunStage {
	id: StageId;
	status: "pending" | "running" | "done" | "failed";
	progress: number;
}

/** 审片员对单个镜头的标注（P1：逐镜三态裁决，镜头级重做的依据） */
export interface QaShotVerdict {
	id: string;
	verdict: "ok" | "warn" | "fail";
	reason: string;
}

export interface QaVerdict {
	overall: "pass" | "warn" | "fail";
	score: number;
	axes: { id: AxisId; score: number }[];
	/** 逐镜标注（质检模型支持时存在；旧 run 无此字段） */
	shots?: QaShotVerdict[];
}

/** 运行追踪 span（P2：Run 即 Trace，落盘 traces.ndjson） */
export interface TraceSpan {
	spanId: string;
	stage: StageId | "reshot" | "chat";
	name: string;
	kind: "llm" | "media" | "ffmpeg" | "qa";
	startAt: string;
	durationMs: number;
	status: "ok" | "error" | "semantic-fail";
	/** 输入摘要（prompt 前 120 字） */
	input?: string;
	/** 输出摘要（产物文件名 / 分数 / 错误信息） */
	output?: string;
}

/** 每镜重做上限（防不收敛循环：历史 T6 8 轮 55 视频的教训） */
export const MAX_RESHOT_PER_SHOT = 3;

/** 每镜旁白重录上限（同镜头级重做：防语音反复折腾） */
export const MAX_RETTS_PER_SHOT = 3;

/** 设计图 / 关键帧单卡重绘上限（图片便宜快速，但也要收敛） */
export const MAX_IMAGE_REDRAW = 3;

export interface RunMetrics {
	llmCalls: number;
	mediaCalls: number;
	retries: number;
	perAdapter: Record<string, number>;
}

/** 用户上传的参考素材（图片） */
export interface RunImage {
	id: string;
	name: string;
	/** run 目录内相对路径（assets/ref/<id>.<ext>） */
	file: string;
	url: string;
}

/** 事件关联产物的跳转目标（团队频道快捷链接；stage 为 UI 阶段 id，focus 为卡片定位键） */
export interface EventLink {
	stage: string;
	focus?: string;
	label?: string;
}

/** 团队频道事件：角色间交接 / 状态播报 / QA / 用户指令 / 导演回复 / 重做流水 */
export interface TeamEvent {
	id: string;
	at: string;
	from: RoleId;
	to: RoleId | "client" | "all";
	kind: "handoff" | "status" | "qa" | "user" | "director" | "redo";
	text: string;
	/** 关联生成物时的快捷跳转（无则不渲染链接） */
	link?: EventLink;
}

/** 进行中的重做标识（进度栏「重做中」态；阶段照常走 running，UI 叠加琥珀动效） */
export interface RedoActive {
	/** 重做类型：镜头补拍 / 旁白重录 / 重新导出 */
	kind: "reshot" | "retts" | "reexport";
	/** 命中的镜头（reexport 无） */
	shotId?: string;
	/** 展示用一句话（如「重录 SH03 旁白」） */
	label: string;
}

/** 视频制作团队角色（与 studio 十角色对齐的精简版） */
export type RoleId =
	| "producer"
	| "writer"
	| "art"
	| "storyboard"
	| "tech"
	| "sound"
	| "editor"
	| "reviewer"
	| "director";

export type RunStatus = "running" | "awaiting" | "done" | "failed" | "cancelled";

export interface RunView {
	id: string;
	status: RunStatus;
	stages: RunStage[];
	metrics?: RunMetrics;
	verdict?: QaVerdict;
	videoUrl?: string;
	error?: string;
	brief: { logline: string; keyMessage?: string };
	options: GenerationOptions;
	images: { id: string; name: string; url: string }[];
	events: TeamEvent[];
	/** refine 后存在未推进的下游阶段时为 true，UI 据此展示「继续推进」 */
	awaitingResume: boolean;
	/** 每镜重做次数（上限 MAX_RESHOT_PER_SHOT） */
	shotAttempts: Record<string, number>;
	/** 每镜历史版本文件名（clip-SHxx_v1.mp4…，当前版本恒占主名） */
	shotVersions: Record<string, string[]>;
	/** 每镜旁白重录次数（上限 MAX_RETTS_PER_SHOT） */
	ttsAttempts: Record<string, number>;
	/** 每镜旁白历史版本文件名（tts-SHxx_v1.mp3…，当前版本恒占主名） */
	ttsVersions: Record<string, string[]>;
	/** 进行中的重做（进度栏「重做中」态；无重做时缺省） */
	redoActive?: RedoActive;
	/** 最近一次导出的目标画幅（未设置 = 生成时主画幅） */
	exportAspectRatio?: AspectRatio;
	/** 最近一次导出的成片文件名（assets 下） */
	finalFile?: string;
}

export interface RunRecord {
	readonly id: string;
	readonly dir: string;
	readonly brief: EnrichedBrief;
	status: RunStatus;
	stages: RunStage[];
	metrics: RunMetrics;
	verdict?: QaVerdict;
	videoUrl?: string;
	error?: string;
	images: RunImage[];
	events: TeamEvent[];
	/** 每镜重做次数（镜头级重做的收敛护栏） */
	shotAttempts: Record<string, number>;
	/** 每镜历史版本文件名（当前版本恒占主名 clip-SHxx.mp4） */
	shotVersions: Record<string, string[]>;
	/** 每镜旁白重录次数（语音重做的收敛护栏） */
	ttsAttempts: Record<string, number>;
	/** 每镜旁白历史版本文件名（当前版本恒占主名 tts-SHxx.mp3） */
	ttsVersions: Record<string, string[]>;
	/** 进行中的重做（reshot/retts/reexport；null = 无） */
	redoActive: RedoActive | null;
	/** 确认闸门：美术设计/关键帧就绪后暂停，等用户确认（undefined = 无待确认闸门） */
	gate?: "design" | "keyframes";
	/** 重新导出的目标画幅（未设置 = 生成时的主画幅） */
	exportAspectRatio?: AspectRatio;
	/** 最近一次导出的成片文件名（assets 下，如 final.mp4 / final-9x16.mp4） */
	finalFile?: string;
	readonly abort: AbortController;
}

/** 序列化给 HTTP 的视图（structuredClone 防外部读到内部可变态） */
export function runView(run: RunRecord): RunView {
	return structuredClone({
		id: run.id,
		status: run.status,
		stages: run.stages,
		metrics: run.metrics,
		verdict: run.verdict,
		videoUrl: run.videoUrl,
		error: run.error,
		brief: {
			logline: run.brief.creative.logline,
			...(run.brief.creative.keyMessage ? { keyMessage: run.brief.creative.keyMessage } : {}),
		},
		options: optionsOf(run),
		images: run.images.map((img) => ({ id: img.id, name: img.name, url: img.url })),
		events: run.events,
		awaitingResume: run.status === "awaiting",
		shotAttempts: run.shotAttempts,
		shotVersions: run.shotVersions,
		ttsAttempts: run.ttsAttempts,
		ttsVersions: run.ttsVersions,
		...(run.redoActive ? { redoActive: run.redoActive } : {}),
		...(run.gate ? { gate: run.gate } : {}),
		...(run.exportAspectRatio ? { exportAspectRatio: run.exportAspectRatio } : {}),
		...(run.finalFile ? { finalFile: run.finalFile } : {}),
	});
}

// ============================================================================
// RunStore
// ============================================================================

export class RunStore {
	private runs = new Map<string, RunRecord>();
	private counter = 0;

	create(
		brief: EnrichedBrief,
		studioRoot: string,
		images: { id: string; name: string; ext: string }[] = [],
	): RunRecord {
		this.counter += 1;
		const id = `run-${Date.now().toString(36)}-${this.counter}`;
		const slug =
			brief.creative.logline
				.replace(/[\\/:*?"<>|\s]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 24) || "ad";
		const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
		const dir = path.join(studioRoot, ".pi-studio", "video-agent-runs", `${stamp}-${slug}-${id}`);
		const record: RunRecord = {
			id,
			dir,
			brief,
			status: "running",
			stages: STAGE_IDS.map((stageId) => ({ id: stageId, status: "pending", progress: 0 })),
			metrics: { llmCalls: 0, mediaCalls: 0, retries: 0, perAdapter: {} },
			images: images.map((img) => ({
				id: img.id,
				name: img.name,
				file: path.join("assets", "ref", `${img.id}.${img.ext}`),
				url: `/api/runs/${id}/files/assets/ref/${img.id}.${img.ext}`,
			})),
			events: [],
			shotAttempts: {},
			shotVersions: {},
			ttsAttempts: {},
			ttsVersions: {},
			redoActive: null,
			// 美术设计完成后必须经用户确认才进入关键帧/视频生成（闸门 A）
			gate: "design",
			abort: new AbortController(),
		};
		this.runs.set(id, record);
		return record;
	}

	get(id: string): RunRecord | undefined {
		return this.runs.get(id);
	}

	/**
	 * 启动时从磁盘恢复历史 run（run-state.json）。
	 * 重启中断语义：running → failed（管线无法原地续跑）；awaiting → 原样保留
	 * （确认闸门/refine 停机是稳定状态，用户确认后 resume 照常推进，不应被重启清掉）。
	 */
	loadAll(runsRoot: string): number {
		let loaded = 0;
		if (!fs.existsSync(runsRoot)) return loaded;
		for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const statePath = path.join(runsRoot, entry.name, "run-state.json");
			if (!fs.existsSync(statePath)) continue;
			try {
				const raw = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Omit<RunRecord, "abort">;
				if (typeof raw?.id !== "string" || !Array.isArray(raw?.stages) || typeof raw?.dir !== "string") continue;
				const crashed = raw.status === "running";
				const record: RunRecord = {
					...raw,
					images: Array.isArray(raw.images) ? raw.images : [],
					events: Array.isArray(raw.events) ? raw.events : [],
					shotAttempts: raw.shotAttempts && typeof raw.shotAttempts === "object" ? raw.shotAttempts : {},
					shotVersions: raw.shotVersions && typeof raw.shotVersions === "object" ? raw.shotVersions : {},
					ttsAttempts: raw.ttsAttempts && typeof raw.ttsAttempts === "object" ? raw.ttsAttempts : {},
					ttsVersions: raw.ttsVersions && typeof raw.ttsVersions === "object" ? raw.ttsVersions : {},
					redoActive: null,
					status: crashed ? "failed" : raw.status,
					error: crashed ? (raw.error ?? "服务重启，运行中断") : raw.error,
					abort: new AbortController(),
				};
				this.runs.set(record.id, record);
				console.log(`[loadAll] restored ${record.id} (${raw.status})`);
				loaded += 1;
				const seq = Number(record.id.split("-").pop());
				if (Number.isFinite(seq)) this.counter = Math.max(this.counter, seq);
			} catch {
				// 损坏的状态文件直接跳过
			}
		}
		return loaded;
	}
}

/** 状态落盘串行队列：并发 persistRun（事件流高频触发）交错写会把 JSON 写坏 */
let persistChain: Promise<void> = Promise.resolve();

/** 把 run 状态落盘（run-state.json，临时文件 + rename 原子替换），服务重启后可恢复查询/播放 */
function persistRun(run: RunRecord): void {
	const state = {
		id: run.id,
		dir: run.dir,
		brief: run.brief,
		status: run.status,
		stages: run.stages,
		metrics: run.metrics,
		verdict: run.verdict,
		videoUrl: run.videoUrl,
		error: run.error,
		images: run.images,
		events: run.events.slice(-400),
		shotAttempts: run.shotAttempts,
		shotVersions: run.shotVersions,
		ttsAttempts: run.ttsAttempts,
		ttsVersions: run.ttsVersions,
		redoActive: run.redoActive,
		...(run.gate ? { gate: run.gate } : {}),
		...(run.exportAspectRatio ? { exportAspectRatio: run.exportAspectRatio } : {}),
		...(run.finalFile ? { finalFile: run.finalFile } : {}),
	};
	persistChain = persistChain
		.then(async () => {
			const tmp = path.join(run.dir, `run-state.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
			await fs.promises.mkdir(run.dir, { recursive: true });
			await fs.promises.writeFile(tmp, JSON.stringify(state, null, "\t"), "utf-8");
			await fs.promises.rename(tmp, path.join(run.dir, "run-state.json"));
		})
		.catch(() => {
			// 状态落盘失败不影响管线运行
		});
}

// ============================================================================
// 团队事件流
// ============================================================================

export const ROLE_LABEL: Record<RoleId, string> = {
	producer: "制片人",
	writer: "编剧",
	art: "美术指导",
	storyboard: "分镜师",
	tech: "技术导演",
	sound: "声音设计",
	editor: "剪辑师",
	reviewer: "审片员",
	director: "导演",
};

function pushEvent(
	run: RunRecord,
	from: RoleId,
	to: TeamEvent["to"],
	kind: TeamEvent["kind"],
	text: string,
	link?: EventLink,
): void {
	run.events.push({
		id: `ev-${randomUUID().slice(0, 8)}`,
		at: new Date().toISOString(),
		from,
		to,
		kind,
		text,
		...(link ? { link } : {}),
	});
	if (run.events.length > 500) run.events.splice(0, run.events.length - 500);
	persistRun(run);
}

// ============================================================================
// 运行追踪（Run 即 Trace：一次 run 一棵 span 树，落盘 traces.ndjson）
// ============================================================================

/** 追加一个 span：ndjson 落盘 + 可选 OTLP 导出（P3：设 VIDEO_AGENT_OTLP_URL 后激活） */
function appendSpan(
	run: RunRecord,
	span: Omit<TraceSpan, "spanId" | "startAt" | "durationMs">,
	startedAt: number,
): void {
	const full: TraceSpan = {
		...span,
		spanId: randomUUID().slice(0, 8),
		startAt: new Date(startedAt).toISOString(),
		durationMs: Math.max(0, Date.now() - startedAt),
	};
	fs.promises.appendFile(path.join(run.dir, "traces.ndjson"), `${JSON.stringify(full)}\n`, "utf-8").catch(() => {
		// 追踪落盘失败不影响管线
	});
	maybeExportOtlp(run.id, full);
}

/** OTLP 导出桩：未配置端点时为 no-op，保留平滑对接 Maple/ClickStack 的升级路径 */
function maybeExportOtlp(traceId: string, span: TraceSpan): void {
	const url = process.env.VIDEO_AGENT_OTLP_URL;
	if (!url) return;
	void fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ traceId, span }),
	}).catch(() => {
		// 导出失败静默（追踪数据本地 ndjson 仍完整）
	});
}

// ============================================================================
// 管线执行（阶段函数化，支持 refine / resume）
// ============================================================================

interface StageCtx {
	run: RunRecord;
	ctx: ServerContext;
	queue: GenerationQueue;
	signal: AbortSignal;
}

function stage(run: RunRecord, id: StageId): RunStage {
	return run.stages.find((s) => s.id === id)!;
}

function setStage(run: RunRecord, id: StageId, status: RunStage["status"], progress: number): void {
	const s = stage(run, id);
	s.status = status;
	s.progress = progress;
	persistRun(run);
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("已中止");
}

/** 视频适配器是否为 Agnes 2.5 系列（OpenAI Videos 兼容参数体系） */
function isAgnesVideo25(ctx: ServerContext): boolean {
	return /2\.5/.test(ctx.mediaConfig.media.find((a) => a.kind === "video")?.model ?? "");
}

/**
 * 视频生成请求参数（按适配器代际分支）：
 * - Agnes 2.5：seconds 为字符串 "4"-"12"（不足 4s 按 4s 生成，剪辑阶段裁切）；
 *   width/height/frame_rate/image 均禁传（400）；首帧锚定走 mode=keyframe + first_frame（data URI 已实测可用）。
 * - Agnes 2.0 及其他：像素 + 帧数体系，image 为图生视频。
 */
function videoSubmitParams(
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

function optionsOf(run: RunRecord): GenerationOptions {
	return run.brief.generationOptions ?? resolveGenerationOptions();
}

/** 从简报（访谈富化 + 生成选项 + 参考图）启动一次完整管线（不阻塞调用方） */
export function startRun(
	ctx: ServerContext,
	store: RunStore,
	input: {
		logline: string;
		keyMessage?: string;
		generationOptions?: Partial<GenerationOptions>;
		/** 会话中 Clarifier compose 的结果（携带 intent/directives/log）；缺省则零答案起步 */
		enriched?: EnrichedBrief;
		/** 用户上传的参考图（服务端 uploads 目录内的文件） */
		images?: { id: string; name: string; ext: string }[];
		/** 共创空间（可选：共创模式沉淀的人物/场景/情节与音乐简报） */
		coSpace?: CoCreationSpace;
	},
): RunRecord {
	const options = resolveGenerationOptions(input.generationOptions);
	const enriched: EnrichedBrief =
		input.enriched ??
		({
			creative: { logline: input.logline, ...(input.keyMessage ? { keyMessage: input.keyMessage } : {}) },
			intent: {},
			generationDirectives: {
				script: { promptFragment: "", sources: [] },
				visual: { promptFragment: "", sources: [] },
				clips: { promptFragment: "", sources: [] },
				audio: { promptFragment: "", sources: [] },
				export: { promptFragment: "", sources: [] },
			},
			interviewLog: [],
			generationOptions: options,
		} satisfies EnrichedBrief);
	if (input.enriched) enriched.generationOptions = options;
	if (input.coSpace) enriched.coSpace = input.coSpace;
	const run = store.create(enriched, ctx.studioRoot, input.images ?? []);
	// 参考图复制进 run 目录（uploads 目录可能被清理，run 内自持副本）
	const copyJobs: Promise<unknown>[] = [];
	for (const img of run.images) {
		const src = path.join(ctx.studioRoot, ".pi-studio", "video-agent-uploads", path.basename(img.file));
		const dest = path.join(run.dir, img.file);
		copyJobs.push(
			fs.promises.mkdir(path.dirname(dest), { recursive: true }).then(() => fs.promises.copyFile(src, dest)),
		);
	}
	void beginRun(ctx, run, copyJobs);
	return run;
}

/** 新 run 的入口：参考图就位 → 开机事件 → 全阶段执行 */
async function beginRun(ctx: ServerContext, run: RunRecord, copyJobs: Promise<unknown>[]): Promise<void> {
	await fs.promises.mkdir(path.join(run.dir, "assets", "ref"), { recursive: true });
	await Promise.allSettled(copyJobs);
	const n = run.images.length;
	const musicNote = run.brief.coSpace?.musicBrief ? "（含共创音乐简报，已落盘 music-brief.json）" : "";
	pushEvent(
		run,
		"producer",
		"all",
		"status",
		`项目开机 🎬 需求「${run.brief.creative.logline.slice(0, 40)}${run.brief.creative.logline.length > 40 ? "…" : ""}」已确认，${n > 0 ? `含 ${n} 张参考图，` : ""}${run.brief.coSpace ? "含共创空间设定，" : ""}全组按 剧本 → 美术设计 → 分镜关键帧 → 片段生成 → 音频 → 导出 推进。美术设计与关键帧完成后会各暂停一次等你确认，避免未确认就消耗生成额度。${musicNote}`,
	);
	if (run.brief.coSpace?.musicBrief) {
		await fs.promises
			.writeFile(
				path.join(run.dir, "music-brief.json"),
				JSON.stringify(
					{
						brief: run.brief.coSpace.musicBrief,
						note: "BGM 生成模型尚未接入：本简报作为交付说明保留，接入音乐模型后可按此生成底床并混入时间线（闪避逻辑已在 assembleTimeline 内）。",
					},
					null,
					"\t",
				),
				"utf-8",
			)
			.catch(() => {});
	}
	await executeStages(ctx, run, [...STAGE_IDS], { fromResume: false });
}

// ---------------------------------------------------------------------------
// 阶段实现
// ---------------------------------------------------------------------------

/** 读取 run 内 JSON 产物（refine/resume 时从磁盘恢复上游产物） */
export async function readArtifact<T>(run: RunRecord, name: string): Promise<T> {
	const raw = await fs.promises.readFile(path.join(run.dir, name), "utf-8");
	return JSON.parse(raw) as T;
}

/** 参考图 → base64（注入视觉调用） */
async function refImageBase64(run: RunRecord): Promise<string[]> {
	const out: string[] = [];
	for (const img of run.images) {
		try {
			const buf = await fs.promises.readFile(path.join(run.dir, img.file));
			out.push(buf.toString("base64"));
		} catch {
			// 单张图缺失不阻断
		}
	}
	return out;
}

function refImageNote(run: RunRecord): string {
	if (run.images.length === 0) return "";
	return `参考素材: 用户上传了 ${run.images.length} 张图片。画面主体、产品外观与氛围请以参考图为准，在剧本与视觉规范中主动呼应图中的风格元素。`;
}

async function stageScript(sc: StageCtx): Promise<ScriptDoc> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	setStage(run, "script", "running", 10);
	pushEvent(run, "writer", "producer", "status", `编剧开工：解析需求，搭建 ${opts.shotCount} 镜叙事骨架。`);
	throwIfAborted(signal);
	let script = await generateDoc<ScriptDoc>(sc, scriptMessages(run.brief, opts), refImageNote(run), "script");
	script = normalizeScript(script, opts);
	if (script.shots.length !== opts.shotCount) {
		throwIfAborted(signal);
		const fixed = await generateDoc<ScriptDoc>(
			sc,
			scriptMessages(run.brief, opts),
			`（注意：必须恰好 ${opts.shotCount} 个镜头，上一轮只给了 ${script.shots.length} 个。）\n\n${refImageNote(run)}`,
			"script",
		);
		script = normalizeScript(fixed, opts);
	}
	await writeJson(run, "script.json", script);
	setStage(run, "script", "done", 100);
	pushEvent(
		run,
		"writer",
		"art",
		"handoff",
		`剧本《${script.title}》完成：${script.shots.length} 镜，${script.shots.reduce((a, s) => a + s.durationSec, 0)}s。Logline：${script.logline}。请据此制定全片视觉规范。`,
	);
	return script;
}

async function stageVisual(sc: StageCtx, script?: ScriptDoc): Promise<VisualBible> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	setStage(run, "visual", "running", 10);
	pushEvent(run, "art", "writer", "status", "美术指导收到剧本，正在制定美术设计方案：风格基因、色板与光线。");
	throwIfAborted(signal);
	const bible = normalizeBible(
		await generateDoc<VisualBible>(sc, visualBibleMessages(run.brief, opts), refImageNote(run), "visual"),
	);
	await writeJson(run, "visual-bible.json", bible);
	setStage(run, "visual", "running", 40);
	const doc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	// 美术设计核心素材：人物/道具/场景概念图（失败容忍，不阻断管线）
	await deriveDesignBible(sc, doc, bible);
	setStage(run, "visual", "done", 100);
	pushEvent(
		run,
		"art",
		"storyboard",
		"handoff",
		`美术设计定稿：风格 [${bible.styleKeywords.join(" / ")}]，色板 ${bible.palette.slice(0, 4).join("、")}。人物形象与场景设定图已产出，后续关键帧与视频将严格以此为原料。`,
	);
	return bible;
}

// ---------------------------------------------------------------------------
// 美术设计：人物 / 道具 / 场景概念设计图
// ---------------------------------------------------------------------------

/** step-image 支持的尺寸（height x width）按画幅就近取档 */
export function imageSizeFor(aspectRatio: string): string {
	switch (aspectRatio) {
		case "9:16":
			return "1360x768";
		case "1:1":
			return "1024x1024";
		case "4:3":
			return "896x1184";
		default:
			return "768x1360";
	}
}

/** 生一张图（走队列 kind=image）；返回 assets 相对路径，失败返回 null（abort 向上抛） */
/**
 * 出图：可选参考图（美术设计定稿 dataURL，经 params.image 透传给适配器）。
 * 供应商不识别额外字段或拒绝引用时自动降级为纯提示词重试一次 ——
 * 与视频链路“图生视频失败退文生视频”的降级策略对齐，不因增强功能牺牲可用性。
 */
async function generateImage(
	sc: StageCtx,
	prompt: string,
	outputName: string,
	size: string,
	options: { referenceImage?: string | null } = {},
): Promise<string | null> {
	const { run, signal } = sc;
	const baseParams: Record<string, unknown> = { size };
	const attempt = (withReference: boolean) => {
		const job = sc.queue.submit(
			{
				roleName: "video-agent",
				kind: "image",
				prompt,
				params:
					withReference && options.referenceImage ? { ...baseParams, image: options.referenceImage } : baseParams,
				outputName,
			},
			run.dir,
		);
		run.metrics.mediaCalls += 1;
		return sc.queue.awaitJob(job.id, undefined, signal);
	};
	let finished = await attempt(Boolean(options.referenceImage));
	if (!(finished.status === "done" && finished.filePath) && options.referenceImage) {
		pushEvent(run, "art", "producer", "status", "带参考图生成未成功，已降级纯提示词重试 ⚠️");
		finished = await attempt(false);
	}
	if (!(finished.status === "done" && finished.filePath)) return null;
	return path.relative(run.dir, finished.filePath!);
}

async function readDesignBible(run: RunRecord): Promise<DesignBibleDoc | null> {
	try {
		return await readArtifact<DesignBibleDoc>(run, "design-bible.json");
	} catch {
		return null;
	}
}

async function writeDesignBible(run: RunRecord, doc: DesignBibleDoc): Promise<void> {
	await writeJson(run, "design-bible.json", doc);
}

/**
 * 美术设计定稿后：LLM 推导设计实体 → 逐张生成概念设计图。
 * 单实体失败只标记该卡 failed；整体推导失败记录事件后跳过。
 */
async function deriveDesignBible(sc: StageCtx, script: ScriptDoc, bible: VisualBible): Promise<void> {
	const { run, signal } = sc;
	let doc: DesignBibleDoc;
	const t0 = Date.now();
	try {
		const raw = await chatJson<Partial<Record<"characters" | "props" | "scenes", unknown>>>(
			sc.ctx.llm,
			promptsToText(designBibleMessages(run.brief, script, bible)),
			signal,
		);
		run.metrics.llmCalls += 1;
		doc = normalizeDesignDoc(raw);
		appendSpan(
			run,
			{
				stage: "visual",
				name: "美术设计·实体推导",
				kind: "llm",
				status: "ok",
				input: `${script.title} + 美术设计`,
				output: `人物 ${doc.characters.length} / 道具 ${doc.props.length} / 场景 ${doc.scenes.length}`,
			},
			t0,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		appendSpan(
			run,
			{
				stage: "visual",
				name: "美术设计·实体推导",
				kind: "llm",
				status: "error",
				output: error instanceof Error ? error.message : String(error),
			},
			t0,
		);
		pushEvent(run, "art", "producer", "status", "设计实体推导失败 ⚠️（不影响后续阶段），可稍后在美术设计面板重试。");
		return;
	}
	const total = doc.characters.length + doc.props.length + doc.scenes.length;
	if (total === 0) {
		pushEvent(run, "art", "producer", "status", "剧本中没有需要单独出设计图的实体，跳过概念设计图生成。");
		return;
	}
	doc.generatedAt = new Date().toISOString();
	await writeDesignBible(run, doc);
	pushEvent(
		run,
		"art",
		"producer",
		"status",
		`美术设计开工：${total} 张概念设计图（人物 ${doc.characters.length} · 道具 ${doc.props.length} · 场景 ${doc.scenes.length}）逐张绘制中。`,
	);

	const entities: DesignEntity[] = [...doc.characters, ...doc.props, ...doc.scenes];
	let done = 0;
	for (const entity of entities) {
		throwIfAborted(signal);
		const tImg = Date.now();
		entity.attempts += 1;
		try {
			const file = await generateImage(
				sc,
				designSheetPrompt(entity, bible),
				`design-${entity.category}-${entity.id}`,
				"1024x1024",
			);
			if (file) {
				entity.file = file;
				entity.status = "done";
				entity.error = undefined;
			} else {
				entity.status = "failed";
				entity.error = "图像生成失败";
			}
		} catch (error) {
			if (signal.aborted) throw error;
			entity.status = "failed";
			entity.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
		}
		appendSpan(
			run,
			{
				stage: "visual",
				name: `设计图 ${entity.id}（${entity.name}）`,
				kind: "media",
				status: entity.status === "done" ? "ok" : "error",
				input: entity.design.slice(0, 120),
				output: entity.file ? path.basename(entity.file) : (entity.error ?? "失败"),
			},
			tImg,
		);
		pushEvent(
			run,
			"art",
			"producer",
			"status",
			entity.status === "done"
				? `设计图完成 ✅「${entity.name}」（${entity.category === "character" ? "人物" : entity.category === "prop" ? "道具" : "场景"} ${entity.id}）`
				: `设计图失败 ⚠️「${entity.name}」：${entity.error ?? "未知原因"}。可在美术设计面板重试。`,
			{ stage: "bible", focus: entity.id, label: "查看设计图" },
		);
		done += 1;
		setStage(run, "visual", "running", Math.round(40 + (done / total) * 55));
		await writeDesignBible(run, doc);
	}
	const okCount = entities.filter((e) => e.status === "done").length;
	pushEvent(
		run,
		"art",
		"producer",
		"status",
		`美术设计完成 ✅ ${okCount}/${total} 张设计图就绪，可在「美术设计」面板查看并逐张调整；确认前不会进入关键帧与视频生成。`,
	);
}

/** 手动调整重绘一张设计图（server 端点用；同步等待出图） */
export async function redesignEntity(
	ctx: ServerContext,
	run: RunRecord,
	entityId: string,
	instruction: string,
): Promise<{ ok: boolean; error?: string }> {
	// 同步占位：检查与置位之间无 await，杜绝双提交竞态窗口；结束（成功/失败）恢复原状态
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const prevStatus = run.status;
	run.status = "running";
	try {
		return await redesignEntityInner(ctx, run, entityId, instruction);
	} finally {
		run.status = prevStatus;
		persistRun(run);
	}
}

async function redesignEntityInner(
	ctx: ServerContext,
	run: RunRecord,
	entityId: string,
	instruction: string,
): Promise<{ ok: boolean; error?: string }> {
	const doc = await readDesignBible(run);
	if (!doc) return { ok: false, error: "美术设计图尚未生成" };
	const entity = [...doc.characters, ...doc.props, ...doc.scenes].find((e) => e.id === entityId);
	if (!entity) return { ok: false, error: `设计条目 ${entityId} 不存在` };
	if (entity.attempts >= MAX_IMAGE_REDRAW && instruction) {
		return {
			ok: false,
			error: `「${entity.name}」已重绘 ${MAX_IMAGE_REDRAW} 次达上限。建议在美术设计阶段微调整体风格。`,
		};
	}

	const bible = normalizeBible(
		await readArtifact<VisualBible>(run, "visual-bible.json").catch(() => ({
			styleKeywords: [],
			palette: [],
			lighting: "",
			grade: "",
		})),
	);
	const queue = new GenerationQueue(ctx.mediaConfig);
	const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
	// 参考传导：以该实体旧版定稿为参考，重绘是增量调整而非凭空再画（防人物改脸漂移）
	const prevRef =
		entity.file && fs.existsSync(path.join(run.dir, entity.file)) ? await fileDataUrl(run.dir, entity.file) : null;
	entity.attempts += 1;
	pushEvent(
		run,
		"art",
		"client",
		"redo",
		`美术指导正在重绘设计图「${entity.name}」（第 ${entity.attempts} 次）${instruction ? `：${instruction.slice(0, 60)}` : "（原样重绘）"}…`,
	);
	const t0 = Date.now();
	try {
		// 先备份旧图、再生成（与关键帧重绘同规：否则新图会先覆盖主名，
		// 随后的“备份”实际存的是新图、且旧图被静默销毁）。
		let backedUpOld = false;
		if (entity.file && fs.existsSync(path.join(run.dir, entity.file))) {
			const ext = path.extname(entity.file);
			const vName = `design-${entity.category}-${entity.id}_v${entity.versions.length + 1}${ext}`;
			await fs.promises.rename(path.join(run.dir, entity.file), path.join(run.dir, "assets", vName)).catch(() => {});
			entity.versions.push(path.join("assets", vName));
			backedUpOld = true;
		}
		const file = await generateImage(
			sc,
			designSheetPrompt(entity, bible, instruction || undefined),
			`design-${entity.category}-${entity.id}`,
			"1024x1024",
			{ referenceImage: prevRef },
		);
		if (!file) {
			// 两次尝试（带/不带参考）均失败：回滚刚备份的旧主图
			if (backedUpOld && entity.file && entity.versions.length > 0) {
				const prev = entity.versions[entity.versions.length - 1]!;
				await fs.promises.rename(path.join(run.dir, prev), path.join(run.dir, entity.file)).catch(() => {});
				entity.versions.pop();
			}
			entity.status = entity.file ? "done" : "failed";
			entity.error = "图像生成失败";
			await writeDesignBible(run, doc);
			pushEvent(run, "art", "client", "status", `设计图「${entity.name}」重绘未成功 ⚠️，可稍后在卡片上再次重试。`);
			return { ok: false, error: "图像生成失败，请稍后重试" };
		}
		entity.file = file;
		entity.status = "done";
		entity.error = undefined;
		await writeDesignBible(run, doc);
		appendSpan(
			run,
			{
				stage: "reshot",
				name: `设计图 ${entity.id} 调整重绘`,
				kind: "media",
				status: "ok",
				input: (instruction || "原样重绘").slice(0, 120),
				output: path.basename(file),
			},
			t0,
		);
		pushEvent(
			run,
			"art",
			"client",
			"redo",
			`设计图「${entity.name}」已按你的意见重绘完成${instruction ? `：${instruction.slice(0, 60)}` : ""}。`,
			{ stage: "bible", focus: entity.id, label: "查看设计图" },
		);
		return { ok: true };
	} catch (error) {
		if (sc.signal.aborted) return { ok: false, error: "已中止" };
		entity.status = entity.file ? "done" : "failed";
		entity.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
		await writeDesignBible(run, doc);
		pushEvent(run, "art", "client", "status", `设计图「${entity.name}」重绘出错 ⚠️：${entity.error}`);
		return { ok: false, error: entity.error ?? "重绘失败" };
	}
}

async function stagePrompts(sc: StageCtx, script?: ScriptDoc, bible?: VisualBible): Promise<ShotPromptDoc> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	setStage(run, "prompts", "running", 10);
	pushEvent(run, "storyboard", "tech", "status", "分镜师开工：逐镜拆解画面描述与运镜，生成视频模型提示词。");
	throwIfAborted(signal);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	const bibleDoc = bible ?? (await readArtifact<VisualBible>(run, "visual-bible.json"));
	// 角色外观锚点：美术设计若已产出，注入逐镜 prompt（跨镜服装/发型一致性）
	const designDoc = await readArtifact<DesignBibleDoc>(run, "design-bible.json").catch(() => null);
	const shotPrompts = normalizeShotPrompts(
		await generateDoc<ShotPromptDoc>(
			sc,
			shotPromptMessages(run.brief, scriptDoc, bibleDoc, opts, designDoc),
			"",
			"prompts",
		),
		scriptDoc,
		bibleDoc,
	);
	shotPrompts.promptVersion = PROMPT_VERSION;
	await writeJson(run, "prompts.json", shotPrompts);
	// 关键帧先行：分镜提示词就绪后立刻逐镜绘制首帧锚定图（美术设计素材 → 画面原料）
	setStage(run, "prompts", "running", 30);
	const keyframes = await readKeyframes(run);
	for (const [i, shot] of scriptDoc.shots.entries()) {
		throwIfAborted(signal);
		const prompt = shotPrompts.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual;
		await ensureKeyframe(sc, shot.id, prompt, bibleDoc, keyframes, shot);
		setStage(run, "prompts", "running", 30 + Math.round(((i + 1) / scriptDoc.shots.length) * 60));
	}
	setStage(run, "prompts", "done", 100);
	pushEvent(
		run,
		"storyboard",
		"tech",
		"handoff",
		`分镜锁定 ✅ ${scriptDoc.shots.length} 镜提示词与关键帧全部就绪（含一致性锚点与负面词）。技术导演待命，等你确认关键帧后按队列提交生成。`,
	);
	return shotPrompts;
}

// ---------------------------------------------------------------------------
// 分镜关键帧：每镜一张首帧锚定图（组图预览 + 图生视频输入）
// ---------------------------------------------------------------------------

async function readKeyframes(run: RunRecord): Promise<KeyframesDoc> {
	try {
		const doc = await readArtifact<KeyframesDoc>(run, "keyframes.json");
		if (Array.isArray(doc.frames)) return doc;
	} catch {
		// 首次生成
	}
	return { frames: [] };
}

async function fileDataUrl(dir: string, relPath: string): Promise<string | null> {
	try {
		const buf = await fs.promises.readFile(path.join(dir, relPath));
		const ext = path.extname(relPath).toLowerCase();
		const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
		return `data:${mime};base64,${buf.toString("base64")}`;
	} catch {
		return null;
	}
}

/**
 * 设计素材锚点（来自美术设计）：关键帧/重做提示词强制注入。
 * 分镜提示词由 LLM 转写时会 cherry-pick（实测只复述了服装、丢掉年龄/发色/场景），
 * 锚点必须在出图前程序性拼接，不能依赖 LLM 自觉复述。
 */
async function designAnchorsOf(run: RunRecord): Promise<string> {
	const doc = await readArtifact<DesignBibleDoc>(run, "design-bible.json").catch(() => null);
	const chars = (doc?.characters ?? []).filter((c) => c.design.trim().length > 0);
	const scenes = (doc?.scenes ?? []).filter((s) => s.design.trim().length > 0);
	const parts: string[] = [];
	if (chars.length) parts.push(chars.map((c) => `${c.name}(${c.design})`).join("; "));
	if (scenes.length) parts.push(scenes.map((s) => `${s.name}(${s.design})`).join("; "));
	return parts.join(" | ");
}

/**
 * 挑选与镜头最相关的设计定稿参考：优先人物（身份锚定最重要），其次场景；
 * 实体名出现在画面描述中加分。单镜只挂一张参考 —— 多参考图各供应商行为不一，
 * 单张最稳，且主要漂移风险来自人物。
 */
function pickReferenceEntity(doc: DesignBibleDoc | null, haystack: string): DesignEntity | null {
	const best = (list: { status: string; file?: string; name: string }[]): DesignEntity | null => {
		const ranked = list
			.filter((e) => e.status === "done" && e.file)
			.map((e) => ({ entity: e as DesignEntity, hits: haystack.split(e.name).length - 1 }))
			.sort((a, b) => b.hits - a.hits);
		return ranked[0]?.entity ?? null;
	};
	return best(doc?.characters ?? []) ?? best(doc?.scenes ?? []);
}

/** 该镜关键帧的参考图 dataURL：无则 null（不挂），有则由 generateImage 挂到 params.image */
async function keyframeReferenceOf(run: RunRecord, shotPrompt: string, shotVisual?: string): Promise<string | null> {
	const doc = await readDesignBible(run);
	const picked = pickReferenceEntity(doc, `${shotVisual ?? ""}\n${shotPrompt}`);
	if (!picked?.file) return null;
	pushEvent(run, "tech", "producer", "status", `镜头画面将锚定设计定稿「${picked.name}」（设计图 → 参考图传导）。`);
	return await fileDataUrl(run.dir, picked.file);
}

/** 确保该镜有关键帧；缺失则按分镜提示词生成一张（版本化备份由调用方重绘路径负责） */
async function ensureKeyframe(
	sc: StageCtx,
	shotId: string,
	shotPrompt: string,
	bible: VisualBible,
	doc: KeyframesDoc,
	shot?: { visual: string },
): Promise<KeyframeEntry> {
	const { run, signal } = sc;
	let entry = doc.frames.find((f) => f.shotId === shotId);
	if (entry?.status === "done" && entry.file) return entry;
	if (!entry) {
		entry = { shotId, status: "pending", attempts: 0, versions: [] };
		doc.frames.push(entry);
	}
	entry.attempts += 1;
	entry.status = "pending";
	const t0 = Date.now();
	const referenceImage = await keyframeReferenceOf(run, shotPrompt, shot?.visual);
	pushEvent(
		run,
		"tech",
		"producer",
		"status",
		`镜头 ${shotId} 先出关键帧（首帧锚定图${referenceImage ? " · 挂设计参考图" : ""}）…`,
	);
	try {
		const file = await generateImage(
			sc,
			keyframePrompt(shotPrompt, bible, await designAnchorsOf(run)),
			`key-${shotId}`,
			imageSizeFor(optionsOf(run).aspectRatio),
			{ referenceImage },
		);
		if (file) {
			entry.file = file;
			entry.status = "done";
			entry.error = undefined;
		} else {
			entry.status = "failed";
			entry.error = "关键帧生成失败";
		}
	} catch (error) {
		if (signal.aborted) throw error;
		entry.status = "failed";
		entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
	}
	appendSpan(
		run,
		{
			stage: "prompts",
			name: `关键帧 ${shotId}`,
			kind: "media",
			status: entry.status === "done" ? "ok" : "error",
			input: shotPrompt.slice(0, 120),
			output: entry.file ? path.basename(entry.file) : (entry.error ?? "失败"),
		},
		t0,
	);
	pushEvent(
		run,
		"tech",
		"producer",
		"status",
		entry.status === "done"
			? `关键帧完成 ✅ 镜头 ${shotId}（首帧锚定图就绪）`
			: `关键帧失败 ⚠️ 镜头 ${shotId}：${entry.error ?? "未知原因"}（该镜将退回纯文生视频）`,
		{ stage: "keyframes", focus: shotId, label: "查看关键帧" },
	);
	await writeJson(run, "keyframes.json", doc);
	return entry;
}

/** 手动重绘某镜关键帧（server 端点用；同步等待出图） */
export async function redesignKeyframe(
	ctx: ServerContext,
	run: RunRecord,
	shotId: string,
	instruction: string,
): Promise<{ ok: boolean; error?: string }> {
	// 同步占位：检查与置位之间无 await，杜绝双提交竞态窗口；结束恢复原状态
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const prevStatus = run.status;
	run.status = "running";
	let result: { ok: boolean; error?: string; keyframeWasFailed?: boolean };
	try {
		result = await redesignKeyframeInner(ctx, run, shotId, instruction);
	} finally {
		run.status = prevStatus;
		persistRun(run);
	}
	// 失败恢复自动推进：重试前关键帧处于 failed 且该镜片段已生成 →
	// 自动补拍该镜（以新关键帧锚定），reshotRun 内部会重装配并复审，无需再手动操作。
	if (
		result.ok &&
		result.keyframeWasFailed &&
		stage(run, "clips").status === "done" &&
		(run.shotAttempts[shotId] ?? 0) < MAX_RESHOT_PER_SHOT
	) {
		pushEvent(
			run,
			"producer",
			"tech",
			"redo",
			`关键帧 ${shotId} 已恢复 ✅。自动补拍该镜（以新关键帧锚定），完成后自动重新装配成片——无需手动操作。`,
		);
		void reshotRun(ctx, run, shotId, "");
	}
	return result;
}

async function redesignKeyframeInner(
	ctx: ServerContext,
	run: RunRecord,
	shotId: string,
	instruction: string,
): Promise<{ ok: boolean; error?: string; keyframeWasFailed?: boolean }> {
	let script: ScriptDoc;
	try {
		script = await readArtifact<ScriptDoc>(run, "script.json");
	} catch {
		return { ok: false, error: "剧本产物缺失" };
	}
	if (!script.shots.some((s) => s.id === shotId)) return { ok: false, error: `镜头 ${shotId} 不存在` };
	const doc = await readKeyframes(run);
	let entry = doc.frames.find((f) => f.shotId === shotId);
	const keyframeWasFailed = entry?.status === "failed";
	if (entry && entry.attempts >= MAX_IMAGE_REDRAW) {
		return {
			ok: false,
			error: `镜头 ${shotId} 关键帧已重绘 ${MAX_IMAGE_REDRAW} 次达上限。建议在分镜提示词阶段微调后整体重跑。`,
		};
	}

	const bible = await readArtifact<VisualBible>(run, "visual-bible.json").catch(
		() => ({ styleKeywords: [], palette: [], lighting: "", grade: "" }) as VisualBible,
	);
	const shotPrompts = await readArtifact<ShotPromptDoc>(run, "prompts.json").catch(() => null);
	const shotPrompt =
		shotPrompts?.prompts.find((p) => p.shotId === shotId)?.prompt ??
		script.shots.find((s) => s.id === shotId)!.visual;

	const queue = new GenerationQueue(ctx.mediaConfig);
	const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
	if (!entry) {
		entry = { shotId, status: "pending", attempts: 0, versions: [] };
		doc.frames.push(entry);
	}
	const oldFile = entry.file;
	const t0 = Date.now();
	entry.attempts += 1;
	pushEvent(
		run,
		"storyboard",
		"client",
		"redo",
		`正在重试镜头 ${shotId} 关键帧（第 ${entry.attempts} 次）${instruction ? `：${instruction.slice(0, 60)}` : "（原样重绘）"}…`,
	);
	try {
		// 先备份旧图、再生成：生成会写入同名主文件，若先生成后备份，
		// 会把新图误挪进版本库并让主文件悬空（UI 404、首帧锚定失效）。
		let backedUpOld = false;
		if (oldFile && fs.existsSync(path.join(run.dir, oldFile))) {
			const vName = `key-${shotId}_v${entry.versions.length + 1}${path.extname(oldFile)}`;
			await fs.promises.rename(path.join(run.dir, oldFile), path.join(run.dir, "assets", vName)).catch(() => {});
			entry.versions.push(path.join("assets", vName));
			backedUpOld = true;
		}
		const file = await generateImage(
			sc,
			keyframePrompt(shotPrompt, bible, await designAnchorsOf(run)) +
				(instruction ? `, adjustment: ${instruction}` : ""),
			`key-${shotId}`,
			imageSizeFor(optionsOf(run).aspectRatio),
		);
		if (!file) {
			// 生成失败：回滚刚备份的旧图，恢复主名
			if (backedUpOld && oldFile && entry.versions.length) {
				const vName = entry.versions[entry.versions.length - 1]!;
				await fs.promises.rename(path.join(run.dir, vName), path.join(run.dir, oldFile)).catch(() => {});
				entry.versions.pop();
			}
			entry.status = oldFile ? "done" : "failed";
			await writeJson(run, "keyframes.json", doc);
			pushEvent(run, "storyboard", "client", "status", `镜头 ${shotId} 关键帧重试未成功 ⚠️，可稍后再次重试。`);
			return { ok: false, error: "关键帧生成失败，请稍后重试" };
		}
		entry.file = file;
		entry.status = "done";
		entry.error = undefined;
		await writeJson(run, "keyframes.json", doc);
		appendSpan(
			run,
			{
				stage: "reshot",
				name: `关键帧 ${shotId} 重绘`,
				kind: "media",
				status: "ok",
				input: (instruction || "原样重绘").slice(0, 120),
				output: path.basename(file),
			},
			t0,
		);
		pushEvent(
			run,
			"storyboard",
			"client",
			"redo",
			`镜头 ${shotId} 关键帧已重绘完成${instruction ? `：${instruction.slice(0, 60)}` : ""}。补拍时将以新关键帧锚定画面。`,
			{ stage: "keyframes", focus: shotId, label: "查看关键帧" },
		);
		return { ok: true, keyframeWasFailed };
	} catch (error) {
		if (sc.signal.aborted) return { ok: false, error: "已中止" };
		entry.status = oldFile ? "done" : "failed";
		entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
		await writeJson(run, "keyframes.json", doc);
		pushEvent(run, "storyboard", "client", "status", `镜头 ${shotId} 关键帧重试出错 ⚠️：${entry.error}`);
		return { ok: false, error: entry.error ?? "重绘失败" };
	}
}

async function stageClips(
	sc: StageCtx,
	script?: ScriptDoc,
): Promise<{ script: ScriptDoc; clipFiles: (string | null)[] }> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	const shotPrompts = await readArtifact<ShotPromptDoc>(run, "prompts.json");
	const bible = await readArtifact<VisualBible>(run, "visual-bible.json").catch(
		() => ({ styleKeywords: [], palette: [], lighting: "", grade: "" }) as VisualBible,
	);
	const keyframes = await readKeyframes(run);
	setStage(run, "clips", "running", 0);
	const { width, height } = pixelDimensions(opts.resolution, opts.aspectRatio);
	const clipFiles: (string | null)[] = [];
	for (const [i, shot] of scriptDoc.shots.entries()) {
		throwIfAborted(signal);
		const prompt = shotPrompts.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual;
		// 关键帧先行：组图预览 + 图生视频首帧锚定（失败自动退回纯文生视频）
		const frame = await ensureKeyframe(sc, shot.id, prompt, bible, keyframes, shot);
		const imageDataUrl = frame.file ? await fileDataUrl(run.dir, frame.file) : null;
		pushEvent(
			run,
			"tech",
			"producer",
			"status",
			`镜头 ${shot.id} 提交生成（${opts.resolution} · ${opts.clipDurationSec}s · ${imageDataUrl ? "关键帧+提示词 图生视频" : "文生视频"}）：${prompt.slice(0, 60)}…`,
		);
		const t0 = Date.now();
		const submitClip = (withImage: boolean) =>
			sc.queue.submit(
				{
					roleName: "video-agent",
					kind: "video",
					prompt,
					// seed 不透传：未知参数可能被供应商 400 拒绝，仅在 options 中保留
					params: videoSubmitParams(sc.ctx, opts, width, height, withImage && imageDataUrl ? imageDataUrl : null),
					outputName: `clip-${shot.id}`,
				},
				run.dir,
			);
		run.metrics.mediaCalls += 1;
		let finished = await sc.queue.awaitJob(submitClip(Boolean(imageDataUrl)).id, undefined, signal);
		// 图生视频整单失败 → 降级为文生视频再试一次
		if (!(finished.status === "done" && finished.filePath) && imageDataUrl) {
			pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 图生视频未成功，降级为文生视频重试。`);
			run.metrics.mediaCalls += 1;
			finished = await sc.queue.awaitJob(submitClip(false).id, undefined, signal);
		}
		const ok = finished.status === "done" && finished.filePath;
		clipFiles.push(ok ? finished.filePath! : null);
		appendSpan(
			run,
			{
				stage: "clips",
				name: `镜头 ${shot.id} 生成`,
				kind: "media",
				status: ok ? "ok" : "error",
				input: `${imageDataUrl ? "[keyframe+i2v] " : ""}${prompt.slice(0, 120)}`,
				output: ok ? path.basename(finished.filePath!) : `队列状态 ${finished.status}`,
			},
			t0,
		);
		if (ok) {
			pushEvent(
				run,
				"tech",
				"editor",
				"status",
				`镜头 ${shot.id} 生成完成 ✅（${i + 1}/${scriptDoc.shots.length}）`,
				{ stage: "generate", focus: shot.id, label: "查看片段" },
			);
		} else {
			pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 生成失败 ⚠️，已跳过并由剪辑师在时间线上补位。`, {
				stage: "generate",
				focus: shot.id,
				label: "查看该镜",
			});
		}
		setStage(run, "clips", "running", Math.round(((i + 1) / scriptDoc.shots.length) * 100));
	}
	const okCount = clipFiles.filter((f) => f !== null).length;
	if (okCount === 0) {
		throw new Error("全部镜头生成失败（详见队列重试记录）");
	}
	setStage(run, "clips", "done", 100);
	pushEvent(
		run,
		"tech",
		"editor",
		"handoff",
		`镜头批次交付：${okCount}/${scriptDoc.shots.length} 镜成功，移交剪辑师归一化与合成。`,
	);
	return { script: scriptDoc, clipFiles };
}

/** 逐镜表演指导表（voice-directions.json） */
interface VoiceDirectionsDoc {
	directions: { shotId: string; instruction: string }[];
	generatedAt?: string;
}

/**
 * 确保每镜有表演指导：优先读盘（refine/续跑复用），缺失时 LLM 一次生成全片指导，
 * 失败按情绪意图兜底。指导同时回写 script.json 的 ttsDirection 字段。
 */
async function ensureVoiceDirections(sc: StageCtx, scriptDoc: ScriptDoc): Promise<Map<string, string>> {
	const { run, ctx, signal } = sc;
	const map = new Map<string, string>();
	try {
		const saved = await readArtifact<VoiceDirectionsDoc>(run, "voice-directions.json");
		for (const d of saved.directions ?? []) {
			if (typeof d.shotId === "string" && typeof d.instruction === "string") map.set(d.shotId, d.instruction);
		}
	} catch {
		// 首次生成
	}
	if (scriptDoc.shots.every((s) => map.has(s.id))) return map;

	const t0 = Date.now();
	try {
		const raw = await chatJson<{ directions?: { shotId?: unknown; instruction?: unknown }[] }>(
			ctx.llm,
			promptsToText(voiceDirectionsMessages(run.brief, scriptDoc, optionsOf(run))),
			signal,
		);
		run.metrics.llmCalls += 1;
		for (const shot of scriptDoc.shots) {
			const found = (raw.directions ?? []).find((d) => String(d?.shotId ?? "") === shot.id);
			const instruction = typeof found?.instruction === "string" ? found.instruction.trim().slice(0, 200) : "";
			map.set(shot.id, instruction || fallbackVoiceDirection(run.brief));
		}
		await writeJson(run, "voice-directions.json", {
			directions: scriptDoc.shots.map((s) => ({
				shotId: s.id,
				instruction: map.get(s.id) ?? fallbackVoiceDirection(run.brief),
			})),
			generatedAt: new Date().toISOString(),
		} satisfies VoiceDirectionsDoc);
		appendSpan(
			run,
			{
				stage: "audio",
				name: "配音导演·表演指导",
				kind: "llm",
				status: "ok",
				input: `${scriptDoc.shots.length} 镜旁白`,
				output: scriptDoc.shots.map((s) => `${s.id}:${(map.get(s.id) ?? "").slice(0, 18)}…`).join(" "),
			},
			t0,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		for (const shot of scriptDoc.shots) {
			if (!map.has(shot.id)) map.set(shot.id, fallbackVoiceDirection(run.brief));
		}
		appendSpan(
			run,
			{
				stage: "audio",
				name: "配音导演·表演指导",
				kind: "llm",
				status: "error",
				output: `${error instanceof Error ? error.message : String(error)}（按情绪意图兜底）`,
			},
			t0,
		);
	}
	// 回写进剧本，供重录时的语境参考
	let dirty = false;
	for (const shot of scriptDoc.shots) {
		const next = map.get(shot.id);
		if (next && shot.ttsDirection !== next) {
			shot.ttsDirection = next;
			dirty = true;
		}
	}
	if (dirty) {
		await fs.promises
			.writeFile(path.join(run.dir, "script.json"), JSON.stringify(scriptDoc, null, "\t"), "utf-8")
			.catch(() => {});
	}
	return map;
}

async function stageAudio(
	sc: StageCtx,
	script?: ScriptDoc,
): Promise<{ script: ScriptDoc; audioFiles: (string | null)[] }> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	setStage(run, "audio", "running", 0);
	pushEvent(
		run,
		"sound",
		"editor",
		"status",
		`声音设计开工：配音导演逐镜撰写表演指导，按 ${opts.promptLanguage === "en" ? "英文" : "中文"}旁白录制有情绪起伏的 TTS。`,
	);
	const directions = await ensureVoiceDirections(sc, scriptDoc);
	const audioFiles: (string | null)[] = [];
	for (const [i, shot] of scriptDoc.shots.entries()) {
		throwIfAborted(signal);
		const text = narrationFor(shot, opts.promptLanguage).trim();
		if (!text) {
			audioFiles.push(null);
			setStage(run, "audio", "running", Math.round(((i + 1) / scriptDoc.shots.length) * 100));
			continue;
		}
		const instruction = directions.get(shot.id) ?? fallbackVoiceDirection(run.brief);
		const t0 = Date.now();
		const job = sc.queue.submit(
			{
				roleName: "video-agent",
				kind: "tts",
				prompt: text,
				params: { instruction },
				outputName: `tts-${shot.id}`,
			},
			run.dir,
		);
		run.metrics.mediaCalls += 1;
		const finished = await sc.queue.awaitJob(job.id, undefined, signal).catch(() => null);
		const ok = finished?.status === "done" && finished.filePath;
		audioFiles.push(ok ? finished!.filePath! : null);
		appendSpan(
			run,
			{
				stage: "audio",
				name: `镜头 ${shot.id} 配音`,
				kind: "media",
				status: ok ? "ok" : "error",
				input: `[指导] ${instruction.slice(0, 60)}｜${text.slice(0, 80)}`,
				output: ok ? path.basename(finished!.filePath!) : "TTS 失败",
			},
			t0,
		);
		if (ok) {
			pushEvent(
				run,
				"sound",
				"editor",
				"status",
				`旁白录制完成 ✅ 镜头 ${shot.id}（指导：${instruction.slice(0, 30)}…）`,
				{ stage: "post", focus: shot.id, label: "试听配音" },
			);
		} else {
			pushEvent(run, "sound", "producer", "status", `旁白录制失败 ⚠️ 镜头 ${shot.id}（该镜将以无声画面进时间线）。`, {
				stage: "post",
				focus: shot.id,
				label: "查看该镜",
			});
		}
		setStage(run, "audio", "running", Math.round(((i + 1) / scriptDoc.shots.length) * 100));
	}
	setStage(run, "audio", "done", 100);
	const ttsOk = audioFiles.filter((f) => f !== null).length;
	pushEvent(
		run,
		"sound",
		"editor",
		"handoff",
		`旁白轨交付：${ttsOk}/${audioFiles.length} 条 TTS 就绪（逐镜带表演指导），音量层级 旁白＞音效＞BGM。`,
	);
	return { script: scriptDoc, audioFiles };
}

async function stageExport(
	sc: StageCtx,
	script?: ScriptDoc,
	clipFiles?: (string | null)[],
	audioFiles?: (string | null)[],
): Promise<void> {
	const { run, ctx, signal } = sc;
	const opts = optionsOf(run);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	setStage(run, "export", "running", 0);
	pushEvent(run, "editor", "reviewer", "status", "剪辑师开工：逐镜归一化 → 拼接 → 烧录字幕。");

	// clips/audio 阶段的产物在 refine/resume 场景下可能来自磁盘，这里统一从 assets 推导
	let clips = clipFiles;
	let audios = audioFiles;
	if (!clips || !audios) {
		clips = scriptDoc.shots.map((s) => {
			const raw = path.join(run.dir, "assets", `clip-${s.id}.mp4`);
			return fs.existsSync(raw) ? raw : null;
		});
		audios = scriptDoc.shots.map((s) => {
			const raw = path.join(run.dir, "assets", `tts-${s.id}.mp3`);
			return fs.existsSync(raw) ? raw : null;
		});
	}

	// ---- 画幅：重新导出时可指定其他画幅（多平台分发），默认生成时主画幅 ----
	const exportAspect: AspectRatio = run.exportAspectRatio ?? opts.aspectRatio;
	const isMainAspect = exportAspect === opts.aspectRatio;
	const finalName = isMainAspect ? "final.mp4" : `final-${exportAspect.replace(":", "x")}.mp4`;
	const { width, height } = pixelDimensions(opts.resolution, exportAspect);
	const normalized: string[] = [];
	const subtitles: SubtitleEntry[] = [];
	const keptShots = scriptDoc.shots.filter((_, i) => clips![i] !== null);
	const totalExportSteps = keptShots.length + 3; // 归一化 + EDL + 合成 + 质检
	let doneSteps = 0;

	// ---- 节奏 trim：按旁白实际时长定每镜时长（旁白 + 尾留白，剪掉空转） ----
	const NARR_TAIL_PAD = 0.7; // 旁白结束后画面留白
	const JCUT_LEAD = 0.35; // J-cut：下一镜旁白较画面切点提前进入
	const shotDur: number[] = [];
	const narrDur: (number | null)[] = [];
	for (const shot of keptShots) {
		const i = scriptDoc.shots.indexOf(shot);
		const audioRel = audios![i] ? path.relative(run.dir, audios![i]!) : null;
		const dur = audioRel ? await probeDuration(audioRel, run.dir) : null;
		narrDur.push(dur);
		shotDur.push(
			dur === null
				? opts.clipDurationSec // 无旁白：保持整段
				: Math.min(opts.clipDurationSec, Math.max(1.4, dur + NARR_TAIL_PAD)), // 上限=单镜时长设置（此前硬编码 5.5 导致选 10s 仍被裁成 ~5s）
		);
	}

	for (const shot of keptShots) {
		throwIfAborted(signal);
		const i = scriptDoc.shots.indexOf(shot);
		const k = keptShots.indexOf(shot);
		const out = `shot-${shot.id}.mp4`;
		const t0 = Date.now();
		try {
			await normalizeShot({
				cwd: run.dir,
				clipPath: path.relative(run.dir, clips![i]!),
				audioPath: audios![i] ? path.relative(run.dir, audios![i]!) : null,
				outPath: path.join("assets", out),
				width,
				height,
				fps: opts.fps,
				durationSec: shotDur[k]!,
				signal,
			});
			appendSpan(
				run,
				{
					stage: "export",
					name: `镜头 ${shot.id} 归一化`,
					kind: "ffmpeg",
					status: "ok",
					output: `${out}（${shotDur[k]!.toFixed(1)}s）`,
				},
				t0,
			);
		} catch (error) {
			appendSpan(
				run,
				{
					stage: "export",
					name: `镜头 ${shot.id} 归一化`,
					kind: "ffmpeg",
					status: "error",
					output: error instanceof Error ? error.message : String(error),
				},
				t0,
			);
			throw error;
		}
		normalized.push(`assets/${out}`);
		doneSteps += 1;
		setStage(run, "export", "running", Math.round((doneSteps / totalExportSteps) * 100));
	}
	// ---- EDL 转场决策：剪辑师 LLM 为每个切点选转场（失败兜底全 cut） ----
	let edl: EdlDoc | null = null;
	const tEdl = Date.now();
	try {
		const edlShots = keptShots.map((s, k) => ({
			id: s.id,
			durationSec: shotDur[k]!,
			narration: narrationFor(s, opts.promptLanguage).trim().slice(0, 40),
			visual: s.visual.slice(0, 80),
		}));
		edl = await chatJson<EdlDoc>(ctx.llm, edlPrompt(edlShots), signal);
		run.metrics.llmCalls += 1;
		appendSpan(
			run,
			{
				stage: "export",
				name: "剪辑决策（转场 EDL）",
				kind: "llm",
				status: "ok",
				input: `${keptShots.length} 镜节奏表`,
				output: (edl.transitions ?? []).map((t) => `${t.after}:${t.type}`).join(" ") || "空（按 cut 处理）",
			},
			tEdl,
		);
	} catch (error) {
		appendSpan(
			run,
			{
				stage: "export",
				name: "剪辑决策（转场 EDL）",
				kind: "llm",
				status: "error",
				input: "镜头节奏表",
				output: `${error instanceof Error ? error.message : String(error)}（降级为全硬切）`,
			},
			tEdl,
		);
	}
	const VALID_TRANSITIONS: TransitionType[] = ["cut", "fade", "dip", "white", "wipeleft", "slideup"];
	const VALID_SFX: SfxType[] = ["whoosh", "impact", "riser"];
	const transitions: TimelineTransition[] = [];
	for (let i = 0; i < keptShots.length - 1; i += 1) {
		const raw = (edl?.transitions ?? []).find((t) => Number(t.after) === i + 1);
		const type = VALID_TRANSITIONS.includes(raw?.type as TransitionType) ? (raw!.type as TransitionType) : "cut";
		const dur = type === "cut" ? 0 : Math.min(0.8, Math.max(0.3, Number(raw?.durationSec) || 0.5));
		// 音效：合法值按 LLM 决策；非 cut 转场缺省兜底 whoosh，cut 缺省无声
		const sfxType = VALID_SFX.includes(raw?.sfx as SfxType)
			? (raw!.sfx as SfxType)
			: type !== "cut"
				? "whoosh"
				: null;
		transitions.push({ afterShotIndex: i, type, durationSec: dur, sfxType });
	}
	await fs.promises
		.writeFile(
			path.join(run.dir, "transitions.json"),
			JSON.stringify({ transitions, shotDur, generatedAt: new Date().toISOString() }, null, "\t"),
			"utf-8",
		)
		.catch(() => {});
	doneSteps += 1;
	setStage(run, "export", "running", Math.round((doneSteps / totalExportSteps) * 100));

	// ---- 时间轴：镜头起点（转场重叠吃时长）+ J-cut 旁白起点 + SFX 起点 + 字幕 ----
	const shotStart: number[] = [];
	const narrStart: number[] = [];
	const sfxTimeline: TimelineSfx[] = [];
	let cursor = 0;
	for (let i = 0; i < keptShots.length; i += 1) {
		shotStart.push(cursor);
		narrStart.push(i > 0 ? Math.max(0, cursor - JCUT_LEAD) : 0);
		const t = i < transitions.length ? transitions[i]! : undefined;
		const overlap = t && t.type !== "cut" ? t.durationSec : 0;
		if (t?.sfxType) {
			// 音效略先于切点入（提前 0.1s），时长对齐转场时长（0.3-0.9s）
			const tStart = cursor + shotDur[i]! - overlap;
			sfxTimeline.push({
				startSec: Math.max(0, tStart - 0.1),
				type: t.sfxType,
				durationSec: Math.min(0.9, Math.max(0.3, t.durationSec || 0.5)),
			});
		}
		cursor += shotDur[i]! - overlap;
	}
	const narrationTexts = keptShots.map((s) => narrationFor(s, opts.promptLanguage).trim());
	for (let i = 0; i < keptShots.length; i += 1) {
		if (!narrationTexts[i]) continue;
		const nextStart = i + 1 < keptShots.length ? narrStart[i + 1] : cursor;
		const dur = Math.max(0.8, Math.min((narrDur[i] ?? 1.5) + 0.3, nextStart - narrStart[i]));
		subtitles.push({ start: narrStart[i]!, duration: dur, text: narrationTexts[i]! });
	}

	// ---- 合成：xfade 转场链 + 旁白 J-cut 定位 + BGM 闪避 + SFX 音效层（失败降级 concat） ----
	const assPath = path.join("assets", "subs.ass");
	await fs.promises.writeFile(path.join(run.dir, assPath), buildAssSubtitles(subtitles, width, height), "utf-8");
	const finalPath = path.join("assets", finalName);
	const BGM_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"];
	const bgmPath =
		BGM_EXTS.map((e) => path.join("assets", `bgm${e}`)).find((p) => fs.existsSync(path.join(run.dir, p))) ?? null;
	const timelineShots: TimelineShot[] = keptShots.map((s, k) => ({
		path: normalized[k]!,
		durationSec: shotDur[k]!,
		narrationPath:
			audios![scriptDoc.shots.indexOf(s)] != null && narrDur[k] !== null
				? path.relative(run.dir, audios![scriptDoc.shots.indexOf(s)]!)
				: null,
		narrationStartSec: narrStart[k]!,
		narrationDurationSec: narrDur[k] ?? 0,
		subtitle: narrationTexts[k] || null,
	}));
	const tConcat = Date.now();
	let totalSec = cursor;
	let usedTransitions = 0;
	let sfxUsed = 0;
	let degraded = false;
	try {
		const info = await assembleTimeline({
			cwd: run.dir,
			shots: timelineShots,
			transitions,
			sfx: sfxTimeline,
			bgmPath,
			assPath,
			outPath: finalPath,
			signal,
		});
		totalSec = info.totalSec;
		usedTransitions = info.usedTransitions;
		sfxUsed = info.sfxUsed;
	} catch (error) {
		// xfade/混音滤镜失败：降级为 concat demuxer（旁白已嵌入各镜，字幕照常烧录，转场/音效/响度处理丢失）
		degraded = true;
		appendSpan(
			run,
			{
				stage: "export",
				name: "时间线合成（转场+混音）",
				kind: "ffmpeg",
				status: "error",
				input: `转场 ${usedTransitions} · SFX ${sfxTimeline.length} · BGM ${bgmPath ? "有" : "无"}`,
				output: `${error instanceof Error ? error.message : String(error)}（降级 concat 硬拼）`,
			},
			tConcat,
		);
		await concatWithSubtitles({ cwd: run.dir, shotPaths: normalized, assPath, outPath: finalPath, signal });
		totalSec = shotDur.reduce((sum, d) => sum + d, 0);
	}
	run.finalFile = finalName;
	const transSummary = transitions
		.filter((t) => t.type !== "cut")
		.map((t) => `${TRANSITION_LABEL[t.type]} ${t.durationSec.toFixed(1)}s`)
		.join("、");
	const sfxSummary = sfxTimeline.map((s) => SFX_LABEL[s.type]).join("、");
	appendSpan(
		run,
		{
			stage: "export",
			name: "时间线合成（转场+混音）",
			kind: "ffmpeg",
			status: "ok",
			input: `${transSummary || "全硬切"}${bgmPath ? " · BGM 铺底闪避" : ""}${sfxSummary ? ` · SFX ${sfxSummary}` : ""} · 响度 -14 LUFS`,
			output: `${finalName}（${keptShots.length} 镜 · ${totalSec.toFixed(1)}s · ${usedTransitions} 处转场 · ${sfxUsed} 处音效${degraded ? " · 已降级" : ""}）`,
		},
		tConcat,
	);
	doneSteps += 1;
	setStage(run, "export", "running", Math.round((doneSteps / totalExportSteps) * 100));
	pushEvent(
		run,
		"editor",
		"reviewer",
		"handoff",
		`粗剪完成（${keptShots.length} 镜 · ${totalSec.toFixed(1)}s · ${opts.resolution} ${exportAspect}${isMainAspect ? "" : " 版"}，转场：${transSummary || "全硬切"}${sfxSummary ? `，音效：${sfxSummary}` : ""}${bgmPath ? "，BGM 铺底" : ""}，响度 -14 LUFS），移交审片员质检。`,
		{ stage: "export", focus: "final", label: "播放成片" },
	);

	// ---- 质检：逐镜抽帧（新时间轴中点） → 视觉模型评分 ----
	const midpoints = keptShots.map((_, k) => shotStart[k]! + shotDur[k]! / 2);
	run.verdict = await runQa(sc, keptShots, opts, finalPath, audios!, midpoints);
	doneSteps += 1;
	setStage(run, "export", "done", 100);
	const v = run.verdict;
	if (v.axes.length > 0) {
		const worst = [...v.axes].sort((a, b) => a.score - b.score)[0];
		const fails = (v.shots ?? []).filter((s) => s.verdict === "fail");
		const failNote =
			fails.length > 0
				? `不合格镜头：${fails.map((s) => `${s.id}（${s.reason}）`).join("；")}。可在质检面板逐镜重做。`
				: "";
		pushEvent(
			run,
			"reviewer",
			"producer",
			"qa",
			`质检结论：${v.overall === "pass" ? "通过 ✅" : v.overall === "warn" ? "有保留通过 ⚠️" : "不通过 ❌"}（综合 ${v.score}）。最短板 ${worst.id} ${worst.score} 分。${failNote}`,
		);
	}
}

/** 阶段调度：按顺序执行给定阶段；上游产物优先用调用方传入（避免重复生成/读盘不一致） */
async function executeStages(
	ctx: ServerContext,
	run: RunRecord,
	ids: StageId[],
	_o: { fromResume: boolean },
): Promise<void> {
	const queue = new GenerationQueue(ctx.mediaConfig);
	const stageCtx: StageCtx = { run, ctx, queue, signal: run.abort.signal };
	try {
		let script: ScriptDoc | undefined;
		let bible: VisualBible | undefined;
		let clips: { script: ScriptDoc; clipFiles: (string | null)[] } | undefined;
		let audio: { script: ScriptDoc; audioFiles: (string | null)[] } | undefined;

		for (const id of ids) {
			throwIfAborted(stageCtx.signal);
			// 确认闸门：美术设计未确认 → 不得绘制关键帧；关键帧未确认 → 不得烧视频生成额度
			if (id === "prompts" && run.gate === "design") {
				holdAtDesignGate(run);
				return;
			}
			if (id === "clips" && run.gate === "keyframes") {
				holdAtKeyframeGate(run);
				return;
			}
			if (id === "script") {
				script = await stageScript(stageCtx);
			} else if (id === "visual") {
				bible = await stageVisual(stageCtx, script);
			} else if (id === "prompts") {
				await stagePrompts(stageCtx, script, bible);
				// 本轮会继续进入视频生成 → 装上关键帧闸门（纯文本 refine 不装，避免双重确认）
				if (ids.includes("clips")) run.gate = "keyframes";
			} else if (id === "clips") {
				clips = await stageClips(stageCtx, script ?? clips?.script);
			} else if (id === "audio") {
				audio = await stageAudio(stageCtx, script ?? clips?.script);
			} else if (id === "export") {
				await stageExport(stageCtx, script ?? clips?.script, clips?.clipFiles, audio?.audioFiles);
			}
		}

		// 队列统计收尾
		const stats = queue.stats();
		run.metrics.retries = stats.retries;
		run.metrics.perAdapter = Object.fromEntries(Object.entries(stats.adapters).map(([id, a]) => [id, a.done]));

		if (run.stages.every((s) => s.status === "done")) {
			run.videoUrl = run.finalFile
				? `/api/runs/${run.id}/files/assets/${encodeURIComponent(run.finalFile)}`
				: `/api/runs/${run.id}/video`;
			run.status = "done";
			pushEvent(run, "producer", "client", "status", "全片交付 🎉 成片与五轴质检报告已就绪。", {
				stage: "export",
				focus: "final",
				label: "查看成片",
			});
		} else {
			// refine(autoResume=false) 停在这里：等待用户确认后 resume
			run.status = "awaiting";
		}
		persistRun(run);
	} catch (error) {
		if (stageCtx.signal.aborted || (error instanceof Error && error.message === "已中止")) {
			run.status = "cancelled";
			persistRun(run);
			return;
		}
		const current = run.stages.find((s) => s.status === "running");
		if (current) current.status = "failed";
		run.status = "failed";
		run.error = error instanceof Error ? error.message : String(error);
		pushEvent(run, "producer", "client", "status", `管线受阻 ⚠️：${run.error}。可在对应阶段微调后重试。`);
		persistRun(run);
	}
}

// ---------------------------------------------------------------------------
// refine / resume / chat
// ---------------------------------------------------------------------------

/** 闸门 A：美术设计（风格+人物/场景概念图）就绪，暂停等用户确认 */
function holdAtDesignGate(run: RunRecord): void {
	run.gate = "design";
	run.status = "awaiting";
	persistRun(run);
	pushEvent(
		run,
		"art",
		"client",
		"status",
		"美术设计已就绪 🎨 风格、人物形象与场景概念图齐备。请在「美术设计」页确认，或对单张设计图提意见重绘；确认后才开始绘制关键帧。",
		{ stage: "bible", label: "查看美术设计" },
	);
}

/** 闸门 B：分镜关键帧全部就绪，暂停等用户确认才进入视频生成 */
function holdAtKeyframeGate(run: RunRecord): void {
	run.gate = "keyframes";
	run.status = "awaiting";
	persistRun(run);
	pushEvent(
		run,
		"storyboard",
		"client",
		"status",
		"关键帧全部就绪 🖼️ 每镜首帧已锚定美术设计。请在「分镜关键帧」页确认或单镜重绘；确认后才开始视频生成（避免未确认就消耗生成额度）。",
		{ stage: "keyframes", label: "查看关键帧" },
	);
}

/** 微调单个文本阶段：带用户指令与原产物重新生成；autoResume=false 时停在 awaiting */
export function refineRun(
	ctx: ServerContext,
	run: RunRecord,
	stageId: StageId,
	instruction: string,
	autoResume: boolean,
): { ok: boolean; error?: string } {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	if (!TEXT_STAGES.includes(stageId))
		return { ok: false, error: `阶段 ${stageLabel(stageId)} 不支持微调（仅剧本/美术设计/分镜提示词）` };
	const target = stage(run, stageId);
	if (target.status !== "done") return { ok: false, error: "该阶段尚未完成，无可微调产物" };

	// 用户指令与导演确认入频道
	pushEvent(run, "producer", "client", "user", `收到调整指令（${stageLabel(stageId)}）：${instruction}`);
	// 确认闸门规则：重跑视觉及上游 → 闸门 A；重跑提示词 → 闸门 B
	if (stageId === "script" || stageId === "visual") run.gate = "design";
	if (stageId === "prompts") run.gate = "keyframes";
	pushEvent(
		run,
		"director",
		"client",
		"director",
		autoResume
			? `明白。${roleOfStage(stageId)}带着你的意见重做「${stageLabel(stageId)}」，随后自动推进到下一道确认闸门，确认后才会继续消耗生成额度。`
			: `明白。${roleOfStage(stageId)}带着你的意见重做「${stageLabel(stageId)}」，完成后暂停等你过目；确认后点「继续推进」再动下游，避免浪费生成额度。`,
	);

	// 目标阶段及下游全部回退 pending，清空下游产物态
	const idx = STAGE_IDS.indexOf(stageId);
	for (let i = idx; i < STAGE_IDS.length; i += 1) {
		setStage(run, STAGE_IDS[i]!, "pending", 0);
	}
	run.verdict = undefined;
	run.videoUrl = undefined;
	run.status = "running";
	persistRun(run);

	const ids = STAGE_IDS.slice(idx).filter((id) => autoResume || TEXT_STAGES.includes(id));
	void (async () => {
		await refineStageWithContext(ctx, run, stageId, instruction, ids);
	})();
	return { ok: true };
}

async function refineStageWithContext(
	ctx: ServerContext,
	run: RunRecord,
	stageId: StageId,
	instruction: string,
	ids: StageId[],
): Promise<void> {
	const queue = new GenerationQueue(ctx.mediaConfig);
	const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
	try {
		// 把用户指令注入 brief（作为对应阶段的 promptFragment 追加），保证后续阶段也继承意图
		applyInstruction(run, stageId, instruction);
		await executeStages(ctx, run, ids, { fromResume: false });
	} catch (error) {
		if (sc.signal.aborted) {
			run.status = "cancelled";
			persistRun(run);
			return;
		}
		const current = run.stages.find((s) => s.status === "running");
		if (current) current.status = "failed";
		run.status = "failed";
		run.error = error instanceof Error ? error.message : String(error);
		persistRun(run);
	}
}

/** 从最早未完成阶段继续推进到导出 */
export function resumeRun(ctx: ServerContext, run: RunRecord): { ok: boolean; error?: string } {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const next = run.stages.find((s) => s.status !== "done");
	if (!next) return { ok: false, error: "所有阶段已完成，无需推进" };
	// 确认闸门通过：清闸门并记录
	if (run.gate === "design") {
		pushEvent(run, "producer", "all", "status", "美术设计已确认 ✅ 开始绘制分镜关键帧。");
		run.gate = undefined;
	} else if (run.gate === "keyframes") {
		pushEvent(run, "producer", "all", "status", "关键帧已确认 ✅ 开始视频生成（片段按队列提交）。");
		run.gate = undefined;
	}
	pushEvent(run, "producer", "all", "status", `确认推进 ▶ 从「${stageLabel(next.id)}」继续，直至成片。`);
	run.status = "running";
	persistRun(run);
	const ids = STAGE_IDS.slice(STAGE_IDS.indexOf(next.id));
	void executeStages(ctx, run, [...ids], { fromResume: true }).catch(() => {});
	return { ok: true };
}

/** 重新导出支持的画幅白名单 */
const REEXPORT_ASPECTS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3"];

/**
 * 重新导出：不重新生成任何镜头/配音，只重跑 export 阶段
 * （归一化 → EDL 转场决策 → xfade 时间线合成 → 质检）。
 * 典型场景：上传/更换 BGM 后重新合成、重新让剪辑师出转场、
 * 多平台分发（指定 aspectRatio 产出 final-9x16.mp4 等多画幅版本）。
 */
export function reexportRun(ctx: ServerContext, run: RunRecord, aspectRatio?: string): { ok: boolean; error?: string } {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const audioDone = stage(run, "audio").status === "done";
	const clipsDone = stage(run, "clips").status === "done";
	if (!clipsDone || !audioDone) return { ok: false, error: "镜头与配音尚未全部完成，无法重新导出" };

	let targetAspect: AspectRatio | undefined;
	if (aspectRatio !== undefined) {
		if (!REEXPORT_ASPECTS.includes(aspectRatio as AspectRatio)) {
			return { ok: false, error: `不支持的画幅 ${aspectRatio}（可选 ${REEXPORT_ASPECTS.join(" / ")}）` };
		}
		targetAspect = aspectRatio as AspectRatio;
	}
	run.exportAspectRatio = targetAspect;

	const aspectNote =
		targetAspect && targetAspect !== optionsOf(run).aspectRatio ? `（目标画幅 ${targetAspect}，多平台分发版）` : "";
	pushEvent(
		run,
		"producer",
		"editor",
		"redo",
		`收到重新导出请求：按现有镜头与配音重跑剪辑（转场决策 + 混音${run.status === "done" ? "（含最新 BGM）" : ""}）${aspectNote}。`,
	);
	setStage(run, "export", "pending", 0);
	run.verdict = undefined;
	run.videoUrl = undefined;
	run.status = "running";
	run.redoActive = {
		kind: "reexport",
		label: aspectNote ? `重出 ${targetAspect} 分发版` : "重新导出成片",
	};
	persistRun(run);
	void executeStages(ctx, run, ["export"], { fromResume: true })
		.catch(() => {})
		.finally(() => {
			run.redoActive = null;
			persistRun(run);
		});
	return { ok: true };
}

/** 读取 run 的 traces.ndjson（服务端端点用；坏行容忍） */
export async function readTraces(run: RunRecord): Promise<TraceSpan[]> {
	try {
		const raw = await fs.promises.readFile(path.join(run.dir, "traces.ndjson"), "utf-8");
		return raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line) as TraceSpan;
				} catch {
					return null;
				}
			})
			.filter((s): s is TraceSpan => s !== null);
	} catch {
		return [];
	}
}

/**
 * 镜头级重做（P1 核心）：
 * 备份旧片段 → 带质检反馈与客户指令重新生成该镜 → 重跑装配与质检。
 * 护栏：每镜上限 MAX_RESHOT_PER_SHOT；生成失败自动回滚旧版本。
 */
export async function reshotRun(
	ctx: ServerContext,
	run: RunRecord,
	shotId: string,
	instruction: string,
): Promise<{ ok: boolean; error?: string }> {
	const prevStatus = run.status;
	if (prevStatus === "running") return { ok: false, error: "管线运行中，请稍候" };
	// 同步占位：在首个 await 前进入运行态，消除双提交竞态窗口；校验失败恢复原状态
	run.status = "running";
	const bail = (error: string): { ok: false; error: string } => {
		run.status = prevStatus;
		return { ok: false, error };
	};
	if (stage(run, "clips").status !== "done") return bail("镜头生成尚未完成，无法逐镜重做");

	let script: ScriptDoc;
	try {
		script = await readArtifact<ScriptDoc>(run, "script.json");
	} catch {
		return bail("剧本产物缺失，无法定位镜头");
	}
	const shot = script.shots.find((s) => s.id === shotId);
	if (!shot) return bail(`镜头 ${shotId} 不存在`);

	const attempts = (run.shotAttempts[shotId] ?? 0) + 1;
	if (attempts > MAX_RESHOT_PER_SHOT) {
		return bail(
			`镜头 ${shotId} 已重做 ${MAX_RESHOT_PER_SHOT} 次达上限。建议在「分镜提示词」阶段微调后整体重跑，或人工确认当前版本。`,
		);
	}
	run.shotAttempts[shotId] = attempts;

	// 提示词 = 原分镜提示词 + 角色锚点 + 质检/一致性反馈回灌 + 客户指令
	const shotPrompts = await readArtifact<ShotPromptDoc>(run, "prompts.json").catch(() => null);
	const basePrompt = shotPrompts?.prompts.find((p) => p.shotId === shotId)?.prompt ?? shot.visual;
	const qaNote = run.verdict?.shots?.find((s) => s.id === shotId)?.reason;
	const consistencyNote = (
		await readArtifact<{ shots?: { shotId: string; issues?: string[] }[] }>(run, "consistency.json").catch(() => null)
	)?.shots
		?.find((s) => s.shotId === shotId)
		?.issues?.join("；");
	const anchors = await designAnchorsOf(run);
	const prompt = [
		basePrompt,
		anchors ? `【角色锚点】人物外观必须严格遵循，不得漂移：${anchors}` : "",
		qaNote && qaNote !== "通过" ? `【质检反馈】上一版本问题：${qaNote}。请规避该问题。` : "",
		consistencyNote ? `【一致性反馈】跨镜不一致：${consistencyNote}。请修正为与其他镜头一致。` : "",
		instruction ? `【客户指令】${instruction}` : "",
	]
		.filter(Boolean)
		.join("\n");

	pushEvent(run, "producer", "client", "user", `请求重做镜头 ${shotId}${instruction ? `：${instruction}` : "。"}`);
	pushEvent(
		run,
		"director",
		"tech",
		"director",
		`安排补拍镜头 ${shotId}（第 ${attempts}/${MAX_RESHOT_PER_SHOT} 轮）。${qaNote && qaNote !== "通过" ? `修复问题：${qaNote}。` : ""}旧片段将备份为历史版本，新片段替换主版本后重新装配。`,
	);

	// 回退导出态，进入运行
	setStage(run, "export", "pending", 0);
	run.verdict = undefined;
	run.videoUrl = undefined;
	run.status = "running";
	run.redoActive = { kind: "reshot", shotId, label: `补拍镜头 ${shotId}` };
	persistRun(run);

	void (async () => {
		const queue = new GenerationQueue(ctx.mediaConfig);
		const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
		const opts = optionsOf(run);
		try {
			// 1. 备份现有片段（版本化：clip-SHxx_v{n}.mp4）
			const mainClip = path.join(run.dir, "assets", `clip-${shotId}.mp4`);
			const versions = run.shotVersions[shotId] ?? [];
			let backedUp = false;
			if (fs.existsSync(mainClip)) {
				const vName = `clip-${shotId}_v${versions.length + 1}.mp4`;
				await fs.promises.rename(mainClip, path.join(run.dir, "assets", vName));
				versions.push(vName);
				run.shotVersions[shotId] = versions;
				backedUp = true;
			}

			// 2. 外观类反馈（客户指令/质检/一致性）→ 先重绘关键帧再图生视频：
			//    视频以首帧锚定时，旧关键帧的外观（如发色年龄）会压过文本指令，
			//    旧实现直接复用旧首帧导致「重做了但画面没变」。
			const { width, height } = pixelDimensions(opts.resolution, opts.aspectRatio);
			const kfDoc = await readKeyframes(run);
			const kf = kfDoc.frames.find((f) => f.shotId === shotId);
			const appearanceFeedback = [instruction, qaNote && qaNote !== "通过" ? qaNote : "", consistencyNote ?? ""]
				.filter(Boolean)
				.join("；");
			if (kf?.status === "done" && kf.file && appearanceFeedback) {
				pushEvent(
					run,
					"storyboard",
					"tech",
					"redo",
					`外观反馈涉及镜头 ${shotId}，先重绘关键帧（${appearanceFeedback.slice(0, 60)}…）再补拍，避免旧首帧锚定导致重做无效。`,
				);
				const bible = await readArtifact<VisualBible>(run, "visual-bible.json").catch(
					() => ({ styleKeywords: [], palette: [], lighting: "", grade: "" }) as VisualBible,
				);
				// 先备份旧图、再生成：生成写入同名主文件，若先生成后备份，
				// 会把新图误挪进版本库并让主文件悬空（UI 404、首帧锚定失效）。
				let backedUpKf = false;
				if (fs.existsSync(path.join(run.dir, kf.file))) {
					const vName = `key-${shotId}_v${(kf.versions?.length ?? 0) + 1}${path.extname(kf.file)}`;
					await fs.promises
						.rename(path.join(run.dir, kf.file), path.join(run.dir, "assets", vName))
						.catch(() => {});
					kf.versions = [...(kf.versions ?? []), path.join("assets", vName)];
					backedUpKf = true;
				}
				const newKf = await generateImage(
					sc,
					`${keyframePrompt(basePrompt, bible, anchors)}, adjustment: ${appearanceFeedback}`,
					`key-${shotId}`,
					imageSizeFor(opts.aspectRatio),
				);
				if (newKf) {
					kf.file = newKf;
					await writeJson(run, "keyframes.json", kfDoc);
				} else if (backedUpKf && kf.versions.length) {
					// 重绘失败：回滚刚备份的旧图，恢复主名，仍按旧首帧补拍
					const vName = kf.versions[kf.versions.length - 1]!;
					await fs.promises.rename(path.join(run.dir, vName), path.join(run.dir, kf.file)).catch(() => {});
					kf.versions.pop();
				}
				if (!newKf) {
					pushEvent(
						run,
						"storyboard",
						"tech",
						"status",
						`镜头 ${shotId} 关键帧重绘未成功 ⚠️，本次仍按旧首帧补拍。`,
					);
				}
			}
			const kfDataUrl = kf?.status === "done" && kf.file ? await fileDataUrl(run.dir, kf.file) : null;
			pushEvent(
				run,
				"tech",
				"producer",
				"status",
				`镜头 ${shotId} 重新提交生成（第 ${attempts} 轮${kfDataUrl ? " · 关键帧锚定" : ""}）。`,
			);
			const t0 = Date.now();
			const job = queue.submit(
				{
					roleName: "video-agent",
					kind: "video",
					prompt,
					params: videoSubmitParams(sc.ctx, opts, width, height, kfDataUrl),
					outputName: `clip-${shotId}`,
				},
				run.dir,
			);
			run.metrics.mediaCalls += 1;
			const finished = await queue.awaitJob(job.id, undefined, sc.signal);
			const ok = finished.status === "done" && finished.filePath;
			appendSpan(
				run,
				{
					stage: "reshot",
					name: `镜头 ${shotId} 重做（第 ${attempts} 轮）`,
					kind: "media",
					status: ok ? "ok" : "error",
					input: prompt.slice(0, 120),
					output: ok ? path.basename(finished.filePath!) : `队列状态 ${finished.status}`,
				},
				t0,
			);
			if (!ok) {
				// 生成失败：回滚旧版本（保证 run 不坏）
				if (backedUp) {
					const vName = versions[versions.length - 1]!;
					await fs.promises.rename(path.join(run.dir, "assets", vName), mainClip).catch(() => {});
					versions.pop();
				}
				pushEvent(run, "tech", "producer", "status", `镜头 ${shotId} 重做失败 ⚠️，已恢复旧版本。可稍后重试。`);
				throw new Error(`镜头 ${shotId} 重做失败（队列状态 ${finished.status}），旧版本已回滚`);
			}

			// 3. 重新装配 + 质检（stageExport 从磁盘读取 assets 内片段）
			pushEvent(
				run,
				"tech",
				"editor",
				"handoff",
				`镜头 ${shotId} 新片段就位 ✅（旧版本备份为 ${versions[versions.length - 1] ?? "无"}）。剪辑师重新装配时间线与字幕，随后复审。`,
				{ stage: "generate", focus: shotId, label: "查看新片段" },
			);
			await executeStages(ctx, run, ["export"], { fromResume: true });
			run.redoActive = null;
			persistRun(run);
		} catch (error) {
			if (sc.signal.aborted) {
				run.status = "cancelled";
				run.redoActive = null;
				persistRun(run);
				return;
			}
			const current = run.stages.find((s) => s.status === "running");
			if (current) current.status = "failed";
			run.status = "failed";
			run.error = error instanceof Error ? error.message : String(error);
			run.redoActive = null;
			pushEvent(run, "producer", "client", "status", `镜头重做受阻 ⚠️：${run.error}`);
			persistRun(run);
		}
	})();
	return { ok: true };
}

/** 音色解析：label（如「清纯少女」）或 id 均可；未知音色回退适配器默认 */
export function resolveVoice(ctx: ServerContext, voice?: string): string | undefined {
	if (!voice) return undefined;
	const tts = ctx.mediaConfig.media.find((a) => a.kind === "tts") as { voices?: Record<string, string> } | undefined;
	const voices = tts?.voices;
	if (!voices || Object.keys(voices).length === 0) return voice;
	if (voices[voice]) return voices[voice];
	if (Object.values(voices).includes(voice)) return voice;
	return undefined;
}

/** 可用音色表（label → id），供审议提案与 UI 选择器使用 */
export function availableVoices(ctx: ServerContext): Record<string, string> {
	const tts = ctx.mediaConfig.media.find((a) => a.kind === "tts") as { voices?: Record<string, string> } | undefined;
	return tts?.voices ?? {};
}

/**
 * 旁白重录（语音级重做）：
 * 可选按指令改写旁白文案（更新 script.json，字幕随新文案）→ 备份旧 TTS →
 * 重新合成该镜语音 → 以新语音重新归一化该镜片段（镜头时长随旁白重排）→ 重装配 + 复审。
 * 护栏：每镜上限 MAX_RETTS_PER_SHOT；合成失败自动回滚旧版本。
 */
export async function rettsRun(
	ctx: ServerContext,
	run: RunRecord,
	shotId: string,
	instruction: string,
	voice?: string,
): Promise<{ ok: boolean; error?: string }> {
	const resolvedVoice = resolveVoice(ctx, voice);
	const prevStatus = run.status;
	if (prevStatus === "running") return { ok: false, error: "管线运行中，请稍候" };
	// 同步占位：在首个 await 前进入运行态，消除双提交竞态窗口；校验失败恢复原状态
	run.status = "running";
	const bail = (error: string): { ok: false; error: string } => {
		run.status = prevStatus;
		return { ok: false, error };
	};
	if (stage(run, "audio").status !== "done") return bail("配音尚未完成，无法重录旁白");

	let script: ScriptDoc;
	try {
		script = await readArtifact<ScriptDoc>(run, "script.json");
	} catch {
		return bail("剧本产物缺失，无法定位镜头");
	}
	const shot = script.shots.find((s) => s.id === shotId);
	if (!shot) return bail(`镜头 ${shotId} 不存在`);
	const narration = narrationFor(shot, optionsOf(run).promptLanguage).trim();
	if (!narration) return bail(`镜头 ${shotId} 无旁白，无需重录`);

	const attempts = (run.ttsAttempts[shotId] ?? 0) + 1;
	if (attempts > MAX_RETTS_PER_SHOT) {
		return bail(`镜头 ${shotId} 旁白已重录 ${MAX_RETTS_PER_SHOT} 次达上限。建议在「剧本」阶段微调后整体重跑。`);
	}
	run.ttsAttempts[shotId] = attempts;

	pushEvent(
		run,
		"producer",
		"sound",
		"user",
		`请求重录镜头 ${shotId} 旁白${instruction ? `：${instruction}` : "（原文重录）"}`,
	);

	// ---- 指令解析：改写文案（copy-edit）或纯表演指导（voice-only，文案逐字不动） ----
	let scriptUpdated = false;
	if (instruction.trim()) {
		const t0 = Date.now();
		try {
			const parsed = await chatJson<{
				mode?: string;
				narrationZh?: string;
				narrationEn?: string;
				instruction?: string;
			}>(ctx.llm, rettsNarrationMessages(shot, instruction.trim(), optionsOf(run)));
			const mode = parsed.mode === "copy-edit" ? "copy-edit" : "voice-only";
			const newInstruction = typeof parsed.instruction === "string" ? parsed.instruction.trim().slice(0, 200) : "";
			if (mode === "copy-edit") {
				const zh = typeof parsed.narrationZh === "string" ? parsed.narrationZh.trim() : "";
				const en = typeof parsed.narrationEn === "string" ? parsed.narrationEn.trim() : "";
				if (zh && zh !== shot.narrationZh) {
					shot.narrationZh = zh.slice(0, 400);
					scriptUpdated = true;
				}
				if (en && en !== shot.narrationEn) {
					shot.narrationEn = en.slice(0, 400);
					scriptUpdated = true;
				}
			}
			if (newInstruction && newInstruction !== shot.ttsDirection) {
				shot.ttsDirection = newInstruction;
				scriptUpdated = true;
			}
			if (scriptUpdated) {
				await fs.promises.writeFile(path.join(run.dir, "script.json"), JSON.stringify(script, null, "\t"), "utf-8");
			}
			appendSpan(
				run,
				{
					stage: "reshot",
					name: `镜头 ${shotId} 重录指令解析`,
					kind: "llm",
					status: "ok",
					input: instruction.slice(0, 120),
					output: `${mode}${newInstruction ? `｜指导 ${newInstruction.slice(0, 60)}` : ""}${mode === "copy-edit" && scriptUpdated ? "｜文案已更新" : ""}`,
				},
				t0,
			);
		} catch {
			appendSpan(
				run,
				{
					stage: "reshot",
					name: `镜头 ${shotId} 重录指令解析`,
					kind: "llm",
					status: "error",
					input: instruction.slice(0, 120),
					output: "解析失败，沿用原文案与指导",
				},
				t0,
			);
		}
	}

	pushEvent(
		run,
		"director",
		"sound",
		"redo",
		`安排重录镜头 ${shotId} 旁白（第 ${attempts}/${MAX_RETTS_PER_SHOT} 轮）${scriptUpdated ? "，文案已按指令调整" : ""}。旧录音备份为历史版本，新语音就位后按新时长重排该镜并重新混音。`,
	);

	// 回退导出态，进入运行
	setStage(run, "export", "pending", 0);
	run.verdict = undefined;
	run.videoUrl = undefined;
	run.status = "running";
	run.redoActive = { kind: "retts", shotId, label: `重录 ${shotId} 旁白` };
	persistRun(run);

	void (async () => {
		const queue = new GenerationQueue(ctx.mediaConfig);
		const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
		const text = narrationFor(
			script.shots.find((s) => s.id === shotId) ?? shot,
			optionsOf(run).promptLanguage,
		).trim();
		try {
			// 1. 备份现有 TTS（版本化：tts-SHxx_v{n}.mp3）
			const mainTts = path.join(run.dir, "assets", `tts-${shotId}.mp3`);
			const versions = run.ttsVersions[shotId] ?? [];
			let backedUp = false;
			if (fs.existsSync(mainTts)) {
				const vName = `tts-${shotId}_v${versions.length + 1}.mp3`;
				await fs.promises.rename(mainTts, path.join(run.dir, "assets", vName));
				versions.push(vName);
				run.ttsVersions[shotId] = versions;
				backedUp = true;
			}

			// 2. 重新合成该镜旁白（带最新表演指导；queue 产物直写 assets/tts-SHxx.mp3）
			const voiceDirection =
				script.shots.find((s) => s.id === shotId)?.ttsDirection ?? fallbackVoiceDirection(run.brief);
			pushEvent(
				run,
				"sound",
				"producer",
				"redo",
				`镜头 ${shotId} 旁白重新进棚录制（第 ${attempts} 轮）${resolvedVoice ? `，音色：${resolvedVoice}。` : "，表演指导："}${resolvedVoice ? "" : voiceDirection.slice(0, 50)}。`,
			);
			const t0 = Date.now();
			const job = queue.submit(
				{
					roleName: "video-agent",
					kind: "tts",
					prompt: text,
					params: { instruction: voiceDirection, ...(resolvedVoice ? { voice: resolvedVoice } : {}) },
					outputName: `tts-${shotId}`,
				},
				run.dir,
			);
			run.metrics.mediaCalls += 1;
			const finished = await queue.awaitJob(job.id, undefined, sc.signal);
			const ok = finished.status === "done" && finished.filePath;
			appendSpan(
				run,
				{
					stage: "reshot",
					name: `镜头 ${shotId} 旁白重录（第 ${attempts} 轮）`,
					kind: "media",
					status: ok ? "ok" : "error",
					input: text.slice(0, 120),
					output: ok ? path.basename(finished.filePath!) : `队列状态 ${finished.status}`,
				},
				t0,
			);
			if (!ok) {
				// 合成失败：回滚旧版本
				if (backedUp) {
					const vName = versions[versions.length - 1]!;
					await fs.promises.rename(path.join(run.dir, "assets", vName), mainTts).catch(() => {});
					versions.pop();
				}
				pushEvent(run, "sound", "producer", "redo", `镜头 ${shotId} 旁白重录失败 ⚠️，已恢复旧录音。可稍后重试。`);
				throw new Error(`镜头 ${shotId} 旁白重录失败（队列状态 ${finished.status}），旧版本已回滚`);
			}

			// 3. 新语音就位：重跑 export（重新归一化该镜 → 时长随旁白重排 → 装配 → 复审）
			pushEvent(
				run,
				"sound",
				"editor",
				"handoff",
				`镜头 ${shotId} 新旁白就位 ✅（旧录音备份为 ${versions[versions.length - 1] ?? "无"}）。剪辑师按新时长重排该镜、重装时间线并重新混音，随后复审。`,
				{ stage: "post", focus: shotId, label: "试听新配音" },
			);
			await executeStages(ctx, run, ["export"], { fromResume: true });
			run.redoActive = null;
			persistRun(run);
		} catch (error) {
			if (sc.signal.aborted) {
				run.status = "cancelled";
				run.redoActive = null;
				persistRun(run);
				return;
			}
			const current = run.stages.find((s) => s.status === "running");
			if (current) current.status = "failed";
			run.status = "failed";
			run.error = error instanceof Error ? error.message : String(error);
			run.redoActive = null;
			pushEvent(run, "producer", "client", "status", `旁白重录受阻 ⚠️：${run.error}`);
			persistRun(run);
		}
	})();
	return { ok: true };
}

/** 导演对话可识别并直接执行的意图（语音/画面重做类诉求免手工操作） */
type DirectorIntent = "none" | "reshot" | "retts" | "reexport";

// ---------------------------------------------------------------------------
// 组合出片：每镜视频/音频版本并列，用户勾选组合后本地装配一条交付版（限次）
// ---------------------------------------------------------------------------

/** 单个 run 组合出片上限（本地 ffmpeg 装配不烧模型额度；限次保持决策克制） */
export const MAX_COMPOSE_PER_RUN = 2;

/** cuts.json：组合出片台账（used 计数持久化，重启不丢） */
export interface CutsDoc {
	used: number;
	renders: {
		file: string;
		at: string;
		selections: Record<string, { video: string | null; audio: string | null }>;
	}[];
}

/** 每镜可用版本清单（最新在前，历史 _v{n} 随后；仅含实际存在的文件） */
export interface ShotVersionInfo {
	shotId: string;
	video: { file: string; url: string; label: string }[];
	audio: { file: string; url: string; label: string }[];
}

const COMPOSE_NARR_TAIL_PAD = 0.7;
const COMPOSE_JCUT_LEAD = 0.35;

async function readCuts(run: RunRecord): Promise<CutsDoc> {
	try {
		const doc = await readArtifact<CutsDoc>(run, "cuts.json");
		if (doc && typeof doc.used === "number" && Array.isArray(doc.renders)) return doc;
	} catch {
		// 尚未组合过
	}
	return { used: 0, renders: [] };
}

/** 汇总每镜可组合的视频/音频版本（供剪辑台选择） */
export async function listShotVersions(run: RunRecord): Promise<ShotVersionInfo[]> {
	let shots: { id: string }[] = [];
	try {
		shots = (await readArtifact<ScriptDoc>(run, "script.json")).shots;
	} catch {
		return [];
	}
	const assetsDir = path.join(run.dir, "assets");
	const urlOf = (file: string): string =>
		`/api/runs/${run.id}/files/assets/${encodeURIComponent(path.basename(file))}`;
	const listOf = (shotId: string, prefix: "clip" | "tts", ext: string): ShotVersionInfo["video"] => {
		const list: ShotVersionInfo["video"] = [];
		const main = `${prefix}-${shotId}${ext}`;
		if (fs.existsSync(path.join(assetsDir, main))) list.push({ file: main, url: urlOf(main), label: "最新" });
		const history = prefix === "clip" ? run.shotVersions[shotId] : run.ttsVersions[shotId];
		for (const v of history ?? []) {
			if (!fs.existsSync(path.join(run.dir, v))) continue;
			const n = /_v(\d+)\./.exec(v)?.[1] ?? String(list.length);
			list.push({ file: path.basename(v), url: urlOf(path.basename(v)), label: `v${n}` });
		}
		return list;
	};
	return shots.map((s) => ({
		shotId: s.id,
		video: listOf(s.id, "clip", ".mp4"),
		audio: listOf(s.id, "tts", ".mp3"),
	}));
}

/**
 * 组合出片：按每镜选定的视频/音频版本装配一条交付版 cut-N.mp4。
 * 不调用任何付费模型、不触碰主成片与阶段状态；转场沿用剪辑师已定的 transitions.json，
 * 时长仍按所选旁白实际时长重排，BGM 与字幕照常进时间线。
 */
export async function composeCut(
	run: RunRecord,
	selections: Record<string, { video?: unknown; audio?: unknown }>,
): Promise<{ ok: boolean; error?: string; remaining?: number }> {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const prevStatus = run.status;
	run.status = "running";
	try {
		return await composeCutInner(run, selections);
	} finally {
		run.status = prevStatus;
		persistRun(run);
	}
}

function pickVersion(want: unknown, list: ShotVersionInfo["video"]): string | null {
	if (want == null || want === "") return list[0]?.file ?? null;
	return list.find((v) => v.file === want)?.file ?? null;
}

async function composeCutInner(
	run: RunRecord,
	selections: Record<string, { video?: unknown; audio?: unknown }>,
): Promise<{ ok: boolean; error?: string; remaining?: number }> {
	if (stage(run, "clips").status !== "done" || stage(run, "audio").status !== "done") {
		return { ok: false, error: "镜头与配音尚未全部完成，无法组合出片" };
	}
	const versions = await listShotVersions(run);
	if (versions.length === 0) return { ok: false, error: "暂无可组合的镜头资产" };

	// ---- 选择校验：缺省取「最新」；显式指定的文件必须在对应镜头的可用清单里 ----
	const chosen = new Map<string, { video: string | null; audio: string | null }>();
	for (const shot of versions) {
		const sel = selections[shot.shotId] ?? {};
		const video = pickVersion(sel.video, shot.video);
		if ((sel.video != null && sel.video !== "" && !video) || (!video && shot.video.length > 0)) {
			return { ok: false, error: `镜头 ${shot.shotId} 的视频版本不可用` };
		}
		const audio = pickVersion(sel.audio, shot.audio);
		if (sel.audio != null && sel.audio !== "" && !audio) {
			return { ok: false, error: `镜头 ${shot.shotId} 的音频版本不可用` };
		}
		chosen.set(shot.shotId, { video, audio });
	}

	const cuts = await readCuts(run);
	if (cuts.used >= MAX_COMPOSE_PER_RUN) {
		return {
			ok: false,
			remaining: 0,
			error: `组合出片已用满 ${MAX_COMPOSE_PER_RUN} 次（单次任务上限）。如需再调整，请在对应阶段微调后重新导出成片。`,
		};
	}
	const seq = cuts.used + 1;

	pushEvent(
		run,
		"producer",
		"editor",
		"user",
		`请求组合出片（第 ${seq}/${MAX_COMPOSE_PER_RUN} 次）：${versions
			.map((s) => {
				const c = chosen.get(s.shotId);
				const vLabel = s.video.find((v) => v.file === c?.video)?.label ?? "无";
				const aLabel = c?.audio ? (s.audio.find((a) => a.file === c.audio)?.label ?? "自定") : "无声";
				return `${s.shotId}(画${vLabel}/音${aLabel})`;
			})
			.join("、")}。`,
	);

	const scriptDoc = await readArtifact<ScriptDoc>(run, "script.json");
	const opts = optionsOf(run);
	const signal = run.abort.signal;
	const keptShots = scriptDoc.shots.filter((s) => chosen.get(s.id)?.video != null);
	if (keptShots.length === 0) return { ok: false, error: "所选组合中没有可装配的镜头" };

	// ---- 转场沿用剪辑师决策表（无则全硬切） ----
	const VALID: TransitionType[] = ["cut", "fade", "dip", "white", "wipeleft", "slideup"];
	let saved: TimelineTransition[] = [];
	try {
		const t = await readArtifact<{ transitions?: TimelineTransition[] }>(run, "transitions.json");
		saved = (t.transitions ?? []).filter((x) => x && VALID.includes(x.type));
	} catch {
		// 旧 run 无转场表
	}
	const transitions: TimelineTransition[] = [];
	for (let i = 0; i < keptShots.length - 1; i += 1) {
		const raw = saved.find((t) => t.afterShotIndex === i);
		const type: TransitionType = raw && VALID.includes(raw.type) ? raw.type : "cut";
		const dur = type === "cut" ? 0 : Math.min(0.8, Math.max(0.3, Number(raw?.durationSec) || 0.5));
		const sfxType: SfxType | null = raw?.sfxType ?? (type !== "cut" ? "whoosh" : null);
		transitions.push({ afterShotIndex: i, type, durationSec: dur, sfxType });
	}

	// ---- 时长按所选旁白实际长度重排（与主成片同一节奏公式） ----
	const shotDur: number[] = [];
	const narrDur: (number | null)[] = [];
	for (const shot of keptShots) {
		const audioRel = chosen.get(shot.id)?.audio ? `assets/${chosen.get(shot.id)!.audio}` : null;
		const dur = audioRel ? await probeDuration(audioRel, run.dir) : null;
		narrDur.push(dur);
		shotDur.push(
			dur === null
				? opts.clipDurationSec
				: Math.min(opts.clipDurationSec, Math.max(1.4, dur + COMPOSE_NARR_TAIL_PAD)),
		);
	}

	const { width, height } = pixelDimensions(opts.resolution, opts.aspectRatio);
	const normalized: string[] = [];
	for (const [k, shot] of keptShots.entries()) {
		throwIfAborted(signal);
		const videoBase = chosen.get(shot.id)?.video;
		if (!videoBase) continue; // keptShots 已过滤，防御性跳过
		const out = `cut${seq}-shot-${shot.id}.mp4`;
		await normalizeShot({
			cwd: run.dir,
			clipPath: `assets/${videoBase}`,
			audioPath: chosen.get(shot.id)?.audio ? `assets/${chosen.get(shot.id)!.audio}` : null,
			outPath: path.join("assets", out),
			width,
			height,
			fps: opts.fps,
			durationSec: shotDur[k]!,
			signal,
		});
		normalized.push(`assets/${out}`);
	}

	// ---- 时间轴定位 + 字幕（旁白文本来自剧本，与所选音频版本内容一致） ----
	const shotStart: number[] = [];
	const narrStart: number[] = [];
	const sfxTimeline: TimelineSfx[] = [];
	let cursor = 0;
	for (let i = 0; i < keptShots.length; i += 1) {
		shotStart.push(cursor);
		narrStart.push(i > 0 ? Math.max(0, cursor - COMPOSE_JCUT_LEAD) : 0);
		const t = i < transitions.length ? transitions[i]! : undefined;
		const overlap = t && t.type !== "cut" ? t.durationSec : 0;
		if (t?.sfxType) {
			const tStart = cursor + shotDur[i]! - overlap;
			sfxTimeline.push({
				startSec: Math.max(0, tStart - 0.1),
				type: t.sfxType,
				durationSec: Math.min(0.9, Math.max(0.3, t.durationSec || 0.5)),
			});
		}
		cursor += shotDur[i]! - overlap;
	}
	const narrationTexts = keptShots.map((s) => narrationFor(s, opts.promptLanguage).trim());
	const subtitles: SubtitleEntry[] = [];
	for (let i = 0; i < keptShots.length; i += 1) {
		if (!narrationTexts[i]) continue;
		const nextStart = i + 1 < keptShots.length ? narrStart[i + 1]! : cursor;
		subtitles.push({
			start: narrStart[i]!,
			duration: Math.max(0.8, Math.min((narrDur[i] ?? 1.5) + 0.3, nextStart - narrStart[i]!)),
			text: narrationTexts[i]!,
		});
	}

	const BGM_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"];
	const bgmPath =
		BGM_EXTS.map((e) => path.join("assets", `bgm${e}`)).find((p) => fs.existsSync(path.join(run.dir, p))) ?? null;
	const finalName = `cut-${seq}.mp4`;
	const finalPath = path.join("assets", finalName);
	const assPath = path.join("assets", `cut${seq}-subs.ass`);
	await fs.promises.writeFile(path.join(run.dir, assPath), buildAssSubtitles(subtitles, width, height), "utf-8");
	const timelineShots: TimelineShot[] = keptShots.map((s, k) => ({
		path: normalized[k]!,
		durationSec: shotDur[k]!,
		narrationPath: chosen.get(s.id)?.audio ? `assets/${chosen.get(s.id)!.audio}` : null,
		narrationStartSec: narrStart[k]!,
		narrationDurationSec: narrDur[k] ?? 0,
		subtitle: narrationTexts[k] || null,
	}));

	const t0 = Date.now();
	try {
		await assembleTimeline({
			cwd: run.dir,
			shots: timelineShots,
			transitions,
			sfx: sfxTimeline,
			bgmPath,
			assPath,
			outPath: finalPath,
			signal,
		});
	} catch (error) {
		appendSpan(
			run,
			{
				stage: "export",
				name: `组合出片 #${seq}（转场混音）`,
				kind: "ffmpeg",
				status: "error",
				input: `${keptShots.length} 镜自选版本`,
				output: `${error instanceof Error ? error.message : String(error)}（降级 concat 硬拼）`,
			},
			t0,
		);
		await concatWithSubtitles({ cwd: run.dir, shotPaths: normalized, assPath, outPath: finalPath, signal });
	}
	appendSpan(
		run,
		{
			stage: "export",
			name: `组合出片 #${seq}`,
			kind: "ffmpeg",
			status: "ok",
			input: versions
				.map((s) => {
					const c = chosen.get(s.shotId);
					return `${s.shotId}:${path.basename(c?.video ?? "")}/${c?.audio ? path.basename(c.audio) : "-"}`;
				})
				.join(" "),
			output: `${finalName}（${keptShots.length} 镜 · ${cursor.toFixed(1)}s）`,
		},
		t0,
	);

	// 清理临时归一化片段与字幕（保留成品 cut）
	for (const tmp of [...normalized, assPath]) {
		await fs.promises.rm(path.join(run.dir, tmp), { force: true }).catch(() => {});
	}

	// ---- 台账落盘 + 频道播报（带快捷链接） ----
	const selectionsSnapshot: CutsDoc["renders"][number]["selections"] = {};
	for (const [shotId, c] of chosen) selectionsSnapshot[shotId] = { video: c.video, audio: c.audio };
	await writeJson(run, "cuts.json", {
		used: seq,
		renders: [...cuts.renders, { file: finalPath, at: new Date().toISOString(), selections: selectionsSnapshot }],
	} satisfies CutsDoc);
	pushEvent(
		run,
		"editor",
		"client",
		"redo",
		`交付版 #${seq} 装配完成 ✅（${keptShots.length} 镜 · ${cursor.toFixed(1)}s）。按你勾选的版本组合合成，主成片不受影响。`,
		{ stage: "export", focus: `cut-${seq}`, label: "播放交付版" },
	);
	persistRun(run);
	return { ok: true, remaining: MAX_COMPOSE_PER_RUN - seq };
}

interface DirectorPlan {
	intent: DirectorIntent;
	shotId?: string;
	instruction?: string;
	reply: string;
}

/** 意图识别：一次结构化调用同时产出「要执行的动作」与「给客户的回复」 */
async function planDirectorReply(ctx: ServerContext, run: RunRecord, text: string): Promise<DirectorPlan> {
	const statusLine = run.stages
		.map(
			(s) =>
				`${stageLabel(s.id)}:${s.status === "done" ? "✅" : s.status === "running" ? "⏳" : s.status === "failed" ? "❌" : "—"}`,
		)
		.join("  ");
	const clipsDone = stage(run, "clips").status === "done";
	const audioDone = stage(run, "audio").status === "done";
	// 一致性预检结果（consistency.json）：跨镜外观/画风问题的镜头级定位，供导演直接引用与处置
	const consistency = await readArtifact<{
		overall?: string;
		shots?: { shotId: string; issues?: string[] }[];
	}>(run, "consistency.json").catch(() => null);
	const shotLines = await readArtifact<ScriptDoc>(run, "script.json")
		.then((s) =>
			s.shots
				.map((shot) => {
					const qa = run.verdict?.shots?.find((v) => v.id === shot.id);
					const cs = consistency?.shots?.find((v) => v.shotId === shot.id)?.issues ?? [];
					const attempt = (run.shotAttempts[shot.id] ?? 0) + (run.ttsAttempts[shot.id] ?? 0);
					return `- ${shot.id}｜旁白:「${shot.narrationZh.slice(0, 40)}」${qa ? `｜质检:${qa.verdict}(${qa.reason.slice(0, 30)})` : ""}${cs.length ? `｜一致性问题:${cs.join("；").slice(0, 60)}` : ""}${attempt > 0 ? `｜已重做${attempt}次` : ""}`;
				})
				.join("\n"),
		)
		.catch(() => "（剧本暂不可读）");
	const user = [
		"你是广告片制作团队的导演 Agent。解析客户消息：判断是否包含可立即执行的调整/重做诉求，并直接给出对客户说的话。",
		"",
		`项目状态：${statusLine}${run.verdict ? `；质检综合 ${run.verdict.score}（${run.verdict.overall}）` : ""}`,
		consistency?.overall ? `跨镜一致性预检：${consistency.overall}` : "",
		`客户需求：${run.brief.creative.logline}`,
		`镜头清单（clipsDone=${clipsDone} audioDone=${audioDone}）：`,
		shotLines,
		"",
		`客户消息：${text}`,
		"",
		"意图（intent）只能取：",
		'- "reshot"：客户对某一镜画面不满（含外观/发型/年龄等跨镜不一致，可参考镜头清单中的「一致性问题」），要求重拍该镜（需 clipsDone；shotId 取清单中的镜头编号；instruction 应整合一致性问题以便修正外观）',
		'- "retts"：客户对某一镜的旁白/配音/语气/文案不满，要求调整或重录语音（需 audioDone；shotId 同上）',
		'- "reexport"：客户想重新合成成片（如换画幅/更新 BGM 后重出）',
		'- "none"：纯咨询/闲聊/方向建议，或当前状态不允许该动作，或客户意图模糊到无法定位镜头',
		"instruction：给执行方的指令（从客户消息提炼，如「语气更兴奋」「画面推近产品」；none 时为空串）",
		"reply：对客户的回复，1-3 句，务实专业，说明你安排了什么；不要编造不存在的进度。",
		"",
		"只输出如下 JSON（不要围栏）:",
		'{"intent": "none", "shotId": "", "instruction": "", "reply": "…"}',
	].join("\n");
	const t0 = Date.now();
	try {
		run.metrics.llmCalls += 1;
		const plan = await chatJson<Partial<DirectorPlan>>(ctx.llm, user);
		const intent = (["reshot", "retts", "reexport", "none"] as const).includes(plan.intent as DirectorIntent)
			? (plan.intent as DirectorIntent)
			: "none";
		const reply = typeof plan.reply === "string" && plan.reply.trim() ? plan.reply.trim() : "";
		appendSpan(
			run,
			{
				stage: "chat",
				name: "导演对话·意图识别",
				kind: "llm",
				status: "ok",
				input: text.slice(0, 120),
				output: `${intent}${plan.shotId ? ` ${plan.shotId}` : ""}${reply ? `｜${reply.slice(0, 80)}` : ""}`,
			},
			t0,
		);
		return {
			intent,
			shotId: typeof plan.shotId === "string" ? plan.shotId.trim() : "",
			instruction: typeof plan.instruction === "string" ? plan.instruction.trim().slice(0, 500) : "",
			reply: reply.slice(0, 600),
		};
	} catch {
		appendSpan(
			run,
			{
				stage: "chat",
				name: "导演对话·意图识别",
				kind: "llm",
				status: "error",
				input: text.slice(0, 120),
				output: "LLM 失败",
			},
			t0,
		);
		return { intent: "none", reply: "" };
	}
}

/**
 * 导演对话：先识别客户消息中的调整/重做意图（镜头补拍 / 旁白重录 / 重新导出），
 * 识别到且状态允许时直接触发对应动作（客户零手工），再以导演回复收尾。
 * LLM 失败降级为固定话术。
 */
export async function directorChat(ctx: ServerContext, run: RunRecord, text: string): Promise<TeamEvent> {
	pushEvent(run, "producer", "client", "user", text);
	const plan = await planDirectorReply(ctx, run, text);
	let reply = plan.reply;
	let actionNote = "";

	if (plan.intent !== "none") {
		if (run.status === "running") {
			actionNote = "（管线正在运行，等这一轮结束我就安排。）";
		} else if (plan.intent === "reshot" && plan.shotId) {
			const r = await reshotRun(ctx, run, plan.shotId, plan.instruction ?? "");
			actionNote = r.ok ? `已安排补拍镜头 ${plan.shotId}。` : `（补拍暂不可行：${r.error}）`;
		} else if (plan.intent === "retts" && plan.shotId) {
			const r = await rettsRun(ctx, run, plan.shotId, plan.instruction ?? "");
			actionNote = r.ok ? `已安排重录镜头 ${plan.shotId} 旁白。` : `（旁白重录暂不可行：${r.error}）`;
		} else if (plan.intent === "reexport") {
			const r = reexportRun(ctx, run);
			actionNote = r.ok ? "已安排重新导出。" : `（重新导出暂不可行：${r.error}）`;
		} else {
			actionNote = "（没定位到具体镜头，稍后告诉我镜头编号即可。）";
		}
	}

	if (!reply) {
		// 识别失败/无回复：降级为原纯对话路径
		const t0 = Date.now();
		try {
			const statusLine = run.stages
				.map(
					(s) =>
						`${stageLabel(s.id)}:${s.status === "done" ? "✅" : s.status === "running" ? "⏳" : s.status === "failed" ? "❌" : "—"}`,
				)
				.join("  ");
			reply = (
				await chat(ctx.llm, [
					{
						role: "system",
						content:
							"你是广告片制作团队的导演 Agent，对客户说话。用中文回复，1-3 句，务实、具体、有专业感。不要编造不存在的进度。",
					},
					{
						role: "user",
						content: `项目状态：${statusLine}${run.verdict ? `；质检综合 ${run.verdict.score}（${run.verdict.overall}）` : ""}\n客户需求：${run.brief.creative.logline}\n客户消息：${text}`,
					},
				])
			)
				.trim()
				.slice(0, 600);
			appendSpan(
				run,
				{
					stage: "chat",
					name: "导演对话",
					kind: "llm",
					status: "ok",
					input: text.slice(0, 120),
					output: reply.slice(0, 120),
				},
				t0,
			);
		} catch {
			appendSpan(
				run,
				{
					stage: "chat",
					name: "导演对话",
					kind: "llm",
					status: "error",
					input: text.slice(0, 120),
					output: "LLM 失败，降级固定话术",
				},
				t0,
			);
			reply = "收到。你的意见我已记录并同步给对应角色；如需立即生效，可在对应阶段面板点「微调」发起重做。";
		}
	}
	const finalReply = [reply, actionNote].filter(Boolean).join(" ");
	const event: TeamEvent = {
		id: `ev-${randomUUID().slice(0, 8)}`,
		at: new Date().toISOString(),
		from: "director",
		to: "client",
		kind: "director",
		text: finalReply,
	};
	run.events.push(event);
	persistRun(run);
	return event;
}

function stageLabel(id: StageId): string {
	return {
		script: "剧本",
		visual: "美术设计",
		prompts: "分镜提示词",
		clips: "镜头生成",
		audio: "音频",
		export: "剪辑导出",
	}[id];
}

function roleOfStage(id: StageId): string {
	return {
		script: "编剧",
		visual: "美术指导",
		prompts: "分镜师",
		clips: "技术导演",
		audio: "声音设计",
		export: "剪辑师",
	}[id];
}

/** 把微调指令写进 brief 的阶段约束（下游阶段继承意图） */
function applyInstruction(run: RunRecord, stageId: StageId, instruction: string): void {
	const directives = run.brief.generationDirectives;
	const key = stageId === "script" ? "script" : stageId === "visual" ? "visual" : "clips";
	const prev = directives[key].promptFragment ?? "";
	const addition = `【客户微调】${instruction}`;
	directives[key].promptFragment = prev.includes(addition) ? prev : `${prev ? `${prev}；` : ""}${addition}`;
	// 剧本级指令同时影响视觉与分镜
	if (stageId === "script") {
		for (const k of ["visual", "clips"] as const) {
			const p = directives[k].promptFragment ?? "";
			if (!p.includes(addition)) directives[k].promptFragment = `${p ? `${p}；` : ""}${addition}`;
		}
	}
}

// ---------------------------------------------------------------------------
// 生成辅助：文本 or 视觉（有参考图时自动升级为多模态）
// ---------------------------------------------------------------------------

async function generateDoc<T>(
	sc: StageCtx,
	messages: { role: string; content: string | { text?: string }[] }[],
	extraNote = "",
	stageId: StageId,
): Promise<T> {
	const { run, ctx, signal } = sc;
	const base = promptsToText(messages);
	const parts = [base];
	if (extraNote) parts.push(extraNote);
	const userPrompt = parts.filter(Boolean).join("\n\n");
	const images = await refImageBase64(run);
	run.metrics.llmCalls += 1;
	const t0 = Date.now();
	try {
		const doc =
			images.length > 0
				? await chatVisionJson<T>(ctx.llm, userPrompt, images, signal)
				: await chatJson<T>(ctx.llm, userPrompt, signal);
		appendSpan(
			run,
			{
				stage: stageId,
				name: `${stageLabel(stageId)}文档生成${images.length > 0 ? "（含参考图）" : ""}`,
				kind: "llm",
				status: "ok",
				input: userPrompt.slice(0, 120),
				output: `JSON 产物（${Object.keys(doc as object).join(",") || "空"}）`,
			},
			t0,
		);
		return doc;
	} catch (error) {
		appendSpan(
			run,
			{
				stage: stageId,
				name: `${stageLabel(stageId)}文档生成`,
				kind: "llm",
				status: "error",
				input: userPrompt.slice(0, 120),
				output: error instanceof Error ? error.message : String(error),
			},
			t0,
		);
		throw error;
	}
}

// ============================================================================
// 质检
// ============================================================================

/** 视觉质检：每镜中点帧（按实际时间轴） → 模型打 4 个视觉维度分 + 逐镜三态标注；audioSync 由 TTS 成功率算 */
async function runQa(
	sc: StageCtx,
	keptShots: ScriptDoc["shots"],
	opts: GenerationOptions,
	finalPath: string,
	audioFiles: (string | null)[],
	midpoints: number[],
): Promise<QaVerdict> {
	const { run, ctx, signal } = sc;
	const frames: string[] = [];
	const t0 = Date.now();
	try {
		for (const [i, shot] of keptShots.entries()) {
			throwIfAborted(signal);
			const atSec = midpoints[i] ?? i * opts.clipDurationSec + opts.clipDurationSec / 2;
			const framePath = path.join("assets", `qa-${shot.id}.jpg`);
			await extractFrame({ cwd: run.dir, videoPath: finalPath, atSec, outPath: framePath, signal });
			frames.push(await fs.promises.readFile(path.join(run.dir, framePath)).then((b) => b.toString("base64")));
		}
		throwIfAborted(signal);
		const shotList = keptShots.map((s) => s.id).join("、");
		const vision = await chatVisionJson<{
			briefFit: number;
			visualConsistency: number;
			pacing: number;
			textQuality: number;
			shots?: { id?: string; verdict?: string; reason?: string }[];
		}>(
			ctx.llm,
			[
				"这是同一条广告片的分镜帧（按顺序）。广告需求：",
				run.brief.creative.logline,
				run.brief.creative.keyMessage ? `关键信息: ${run.brief.creative.keyMessage}` : "",
				`镜头编号依次为：${shotList}。`,
				"",
				"请基于帧内容打分（0-100 整数）：",
				"briefFit: 画面内容与广告需求的贴合度；",
				"visualConsistency: 各帧风格/色调/光线的一致性；",
				"pacing: 镜头推进的节奏感（开场-展开-收尾是否有层次）；",
				"textQuality: 画面中是否出现乱码文字/水印/logo（完全干净=100，出现即大幅扣分）。",
				"",
				"同时逐镜标注：verdict 取 ok（可用）/ warn（勉强）/ fail（明显不合格，如乱码文字、画面崩坏、与需求严重不符），reason 用一句话说明（ok 可写「通过」）。",
				"",
				`只输出 JSON: {"briefFit": 0, "visualConsistency": 0, "pacing": 0, "textQuality": 0, "shots": [{"id": "${keptShots[0]?.id ?? "SH01"}", "verdict": "ok", "reason": "…"}]}`,
			]
				.filter(Boolean)
				.join("\n"),
			frames,
			signal,
		);
		run.metrics.llmCalls += 1;
		const ttsOk = audioFiles.filter((f) => f !== null).length;
		const audioSync = audioFiles.length > 0 ? Math.round((ttsOk / audioFiles.length) * 100) : 100;
		const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
		const axes: QaVerdict["axes"] = [
			{ id: "briefFit", score: clamp(vision.briefFit) },
			{ id: "visualConsistency", score: clamp(vision.visualConsistency) },
			{ id: "pacing", score: clamp(vision.pacing) },
			{ id: "audioSync", score: audioSync },
			{ id: "textQuality", score: clamp(vision.textQuality) },
		];
		const score = Math.round(axes.reduce((sum, a) => sum + a.score, 0) / axes.length);
		const min = Math.min(...axes.map((a) => a.score));
		const overall = min < 70 ? "fail" : score >= 85 ? "pass" : "warn";

		// 逐镜标注（宽容解析：字段缺失/未知 id 都容忍）
		const rawShots = Array.isArray(vision.shots) ? vision.shots : [];
		const byId = new Map(rawShots.map((s) => [String(s?.id ?? ""), s]));
		const shots: QaShotVerdict[] = keptShots.map((shot) => {
			const s = byId.get(shot.id);
			const v = s?.verdict === "ok" || s?.verdict === "warn" || s?.verdict === "fail" ? s.verdict : "ok";
			return { id: shot.id, verdict: v, reason: String(s?.reason ?? "").slice(0, 120) || "通过" };
		});

		// semantic-fail：HTTP 200 但语义不合格 —— AI 管线特有的失败模式，单独入 trace
		const failCount = shots.filter((s) => s.verdict === "fail").length;
		appendSpan(
			run,
			{
				stage: "export",
				name: "审片质检（五轴 + 逐镜标注）",
				kind: "qa",
				status: failCount > 0 || overall === "fail" ? "semantic-fail" : "ok",
				input: `${frames.length} 帧抽检`,
				output: `综合 ${score}（${overall}）；逐镜 ${shots.filter((s) => s.verdict === "ok").length} ok / ${shots.filter((s) => s.verdict === "warn").length} warn / ${failCount} fail`,
			},
			t0,
		);
		return { overall, score, axes, shots };
	} catch (error) {
		if (signal.aborted) throw error;
		appendSpan(
			run,
			{
				stage: "export",
				name: "审片质检",
				kind: "qa",
				status: "error",
				output: error instanceof Error ? error.message : String(error),
			},
			t0,
		);
		// 质检失败不拖垮成片：给保守 warn 结论并记录
		run.error = `质检阶段跳过: ${error instanceof Error ? error.message : String(error)}`;
		return { overall: "warn", score: 0, axes: [] };
	}
}

// ============================================================================
// LLM 输出修正（防字段缺失/越界）
// ============================================================================

function normalizeScript(script: ScriptDoc, opts: GenerationOptions): ScriptDoc {
	const shots = Array.isArray(script.shots) ? script.shots : [];
	return {
		title: typeof script.title === "string" && script.title ? script.title : "Untitled Ad",
		logline: typeof script.logline === "string" ? script.logline : "",
		shots: shots
			.filter((s) => s && typeof s.visual === "string" && s.visual)
			.map((s, i) => ({
				id: typeof s.id === "string" && s.id ? s.id : `SH${String(i + 1).padStart(2, "0")}`,
				narrationZh: typeof s.narrationZh === "string" ? s.narrationZh : "",
				narrationEn: typeof s.narrationEn === "string" ? s.narrationEn : "",
				visual: s.visual,
				durationSec: opts.clipDurationSec,
			}))
			.slice(0, opts.shotCount + 2),
	};
}

function normalizeBible(bible: VisualBible): VisualBible {
	return {
		styleKeywords: Array.isArray(bible.styleKeywords)
			? bible.styleKeywords.filter((k) => typeof k === "string").slice(0, 10)
			: [],
		palette: Array.isArray(bible.palette) ? bible.palette.filter((k) => typeof k === "string").slice(0, 8) : [],
		lighting: typeof bible.lighting === "string" ? bible.lighting : "",
		grade: typeof bible.grade === "string" ? bible.grade : "",
	};
}

function normalizeShotPrompts(doc: ShotPromptDoc, script: ScriptDoc, bible: VisualBible): ShotPromptDoc {
	const fallback = (visual: string) =>
		[bible.styleKeywords.join(", "), visual, bible.lighting, bible.grade].filter(Boolean).join(", ");
	const prompts = script.shots.map((shot, i) => {
		const found = Array.isArray(doc.prompts) ? doc.prompts.find((p) => p && p.shotId === shot.id) : undefined;
		const prompt = typeof found?.prompt === "string" && found.prompt ? found.prompt : fallback(shot.visual);
		return { shotId: shot.id ?? `SH${String(i + 1).padStart(2, "0")}`, prompt };
	});
	return { prompts };
}

export async function writeJson(run: RunRecord, name: string, data: unknown): Promise<void> {
	await fs.promises.writeFile(path.join(run.dir, name), JSON.stringify(data, null, "\t"), "utf-8");
}

/** ChatMessage[] → 纯文本 user prompt（管线提示词均为单 user 消息） */
function promptsToText(messages: { role: string; content: string | { text?: string }[] }[]): string {
	return messages
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((part) => part.text ?? "").join("\n")))
		.join("\n");
}
