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

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { GenerationQueue } from "../../coding-agent/examples/extensions/studio/media/queue.ts";
import { registerActiveQueue, unregisterActiveQueue } from "./kitchen.ts";
import { producerObserve } from "./producer.ts";
import type { QueueJob } from "../../coding-agent/examples/extensions/studio/media/queue.ts";
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
	estimateRunCost as pricingEstimateRun,
	trackLlmCost,
	trackMediaCost,
} from "./pricing.ts";
import {
	assembleTimeline,
	buildAssSubtitles,
	concatWithSubtitles,
	extractFrame,
	FfmpegError,
	normalizeShot,
	probeDuration,
	runFfmpeg,
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
import { checkConsistency } from "./consistency.ts";
import type { SubtitleAudit } from "./qa/subtitles.ts";
import { shouldGateAudioDrive } from "./audio-mode.ts";
import { reviewDesignBible, reviewKeyframes } from "./design-review.ts";
import {
	type AudioMode,
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
	pickKeyframeReferences,
	rettsNarrationMessages,
	sanitizeDialogue,
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

export type StageId = "script" | "visual" | "prompts" | "keyframes" | "clips" | "audio" | "export";
// 声音设计在视频生成**之前**（2026-08-30 用户定案）：配音/台词链是"表演设计"，
// 应先于画面生产定稿——顺序 script → visual → prompts → keyframes → audio → clips → export。
const STAGE_IDS: readonly StageId[] = [
	"script",
	"visual",
	"prompts",
	"keyframes",
	"audio",
	"clips",
	"export",
];
/** 文本阶段（可单独 refine 重塑） */
const TEXT_STAGES: readonly StageId[] = ["script", "visual", "prompts"];

export type AxisId =
	| "briefFit"
	| "visualConsistency"
	| "pacing"
	| "physicalAccuracy"
	| "characterConsistency"
	| "audioSync"
	| "textQuality";

export interface RunStage {
	id: StageId;
	status: "pending" | "running" | "done" | "failed";
	progress: number;
}

/** P1 兼容迁移：旧 6 阶段 run 的 keyframes.json 仍可用，恢复时补挂独立阶段 */
function migrateLegacyRunStages(runDir: string, stages: RunStage[]): RunStage[] {
	if (stages.some((stage) => stage.id === "keyframes")) return stages;
	const promptIdx = stages.findIndex((stage) => stage.id === "prompts");
	if (promptIdx < 0) return STAGE_IDS.map((id) => stages.find((s) => s.id === id) ?? { id, status: "pending", progress: 0 });

	let keyframeStatus: RunStage["status"] = "pending";
	let keyframeProgress = 0;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(runDir, "keyframes.json"), "utf-8")) as KeyframesDoc;
		if (Array.isArray(raw.frames) && raw.frames.length > 0 && raw.frames.every((f) => f.status === "done")) {
			keyframeStatus = "done";
			keyframeProgress = 100;
		} else if (raw.frames.some((f) => f.status === "failed")) {
			keyframeStatus = "failed";
		}
	} catch {
		// 没有 keyframes.json 就是尚未开始绘制
	}
	const next = [...stages];
	next.splice(promptIdx + 1, 0, { id: "keyframes", status: keyframeStatus, progress: keyframeProgress });
	return next;
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
	/** 字幕结构审核（qa/subtitles.ts；旧 run / 旧提示词路径无此字段） */
	subtitles?: SubtitleAudit;
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
/** P2+质量门：自动重绘独立上限（autoReviewKeyframes/autoReviewDesign 专用）。
 *  与手动 MAX_IMAGE_REDRAW 分离计数——手动重绘吃重机会，auto 不动用户配额。
 *  上限 5：给审核多轮收敦的机会（框架告警 + 重绘 + 复审 → 仍 fail）。
 */
export const MAX_IMAGE_AUTO_REDRAW = 5;

export interface RunMetrics {
	llmCalls: number;
	mediaCalls: number;
	retries: number;
	perAdapter: Record<string, number>;
	/** 累计成本（P2：价格跟踪；运行结束时落盘） */
	cost: { spent: number; currency: "CNY" | "USD" };
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

/** 导演 agent 最近派发的执行类动作（reshot / retts / reexport / compose），按时间倒序。
 *  用途：审议 system prompt 注入，让 agent 避免重复提议；3 分钟去重防双击。
 *  与 RedoActive 区别：RedoActive 是"正在跑"，lastActions 是"最近跑完的历史账本"。 */
export interface ActionRecord {
	kind: "reshot" | "retts" | "reexport" | "compose";
	shotId?: string;
	label: string;
	at: string;
}

/** P2+审查保护：动作去重窗口。同一 (kind, shotId, label) 在该窗口内只记一次。 */
export const LAST_ACTION_DEDUP_MS = 3 * 60 * 1000;

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
	/** 挂起的确认闸门（design=美术设计 / keyframes=关键帧）。runView 运行时一直返回
	 *  此字段（`...(run.gate ? {gate} : {})`），此前 interface 漏声明导致前端类型绕行、测试报错 */
	gate?: "design" | "keyframes";
	/** P2+审查保护：最近完成的动作账本（reshot/retts/reexport/compose）。
	 *  审议 agent 拿这个避免重复提议；UI 拿这个显示"刚才做了什么"。 */
	lastActions?: ActionRecord[];
	/** 最近一次导出的目标画幅（未设置 = 生成时主画幅） */
	exportAspectRatio?: AspectRatio;
	/** 最近一次导出的成片文件名（assets 下） */
	finalFile?: string;
	/** P2：预估成本（pre-flight，run 启动时算一次） */
	costEstimate?: CostEstimateView;
}

/** 预估成本视图（不携带单价细节，只保留总额 + 阶段明给 UI 显示） */
export interface CostEstimateView {
	total: number;
	currency: "CNY" | "USD";
	lines: { label: string; amount: number; note?: string }[];
}

/** 项目列表用轻量视图：不携带 events/images/options，首页历史卡只关心“能不能继续/看片” */
export interface RunSummary {
	id: string;
	status: RunStatus;
	gate?: "design" | "keyframes";
	logline: string;
	keyMessage?: string;
	error?: string;
	videoUrl?: string;
	/** 当前已完成阶段数（0-6） */
	doneStages: number;
	totalStages: number;
	updatedAt?: string;
}

/** 订阅某个 run 的内存视图变化；SSE 层把它转成 run 快照事件 */
export type RunUpdateListener = (run: RunView) => void;

const runListeners = new Map<string, Set<RunUpdateListener>>();

function emitRunUpdate(run: RunRecord): void {
	const listeners = runListeners.get(run.id);
	if (!listeners?.size) return;
	const view = runView(run);
	for (const listener of listeners) {
		try {
			listener(view);
		} catch {
			// 单个订阅者异常不能打断管线；断线由 HTTP 连接关闭清理兜底
		}
	}
}

/** 事件级增量订阅：pushEvent 只推单条事件，不再随每条事件重发完整 RunView */
export type EventAppendListener = (event: TeamEvent) => void;

const eventListeners = new Map<string, Set<EventAppendListener>>();

function emitEventAppend(run: RunRecord, event: TeamEvent): void {
	const listeners = eventListeners.get(run.id);
	if (!listeners?.size) return;
	for (const listener of listeners) {
		try {
			listener(event);
		} catch {
			// 同 emitRunUpdate：单订阅者异常不打断管线
		}
	}
}

/** 订阅某 run 的新增事件（SSE 增量通道）。返回取消订阅函数。 */
export const subscribeRunEvents = (runId: string, listener: EventAppendListener): (() => void) => {
	const listeners = eventListeners.get(runId) ?? new Set<EventAppendListener>();
	listeners.add(listener);
	eventListeners.set(runId, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) eventListeners.delete(runId);
	};
};

export function runSummary(run: RunRecord, updatedAt?: string): RunSummary {
	return structuredClone({
		id: run.id,
		status: run.status,
		...(run.gate ? { gate: run.gate } : {}),
		logline: run.brief.creative.logline,
		...(run.brief.creative.keyMessage ? { keyMessage: run.brief.creative.keyMessage } : {}),
		...(run.error ? { error: run.error } : {}),
		...(run.videoUrl ? { videoUrl: run.videoUrl } : {}),
		doneStages: run.stages.filter((stage) => stage.status === "done").length,
		totalStages: STAGE_IDS.length,
		...(updatedAt ? { updatedAt } : {}),
	});
}

/** 管线状态变化 → SSE。返回取消订阅函数。 */
export const subscribeRun = (runId: string, listener: RunUpdateListener): (() => void) => {
	const listeners = runListeners.get(runId) ?? new Set<RunUpdateListener>();
	listeners.add(listener);
	runListeners.set(runId, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) runListeners.delete(runId);
	};
};

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
	/** P2+审查保护：最近完成的动作账本。3 分钟内同 (kind, shotId, label) 只记一次，
	 *  用于审议 agent 避免重复提议被采纳， 以及 UI 查看"刚才做了什么"。
	 *  旧 run 迁移时默认 []。 */
	lastActions: ActionRecord[];
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
	/** P2：预估成本（pre-flight，run 启动时计算；类型同 RunView 的 CostEstimateView） */
	costEstimate?: CostEstimateView;
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
		...(run.lastActions.length > 0 ? { lastActions: run.lastActions } : {}),
		...(run.gate ? { gate: run.gate } : {}),
		...(run.exportAspectRatio ? { exportAspectRatio: run.exportAspectRatio } : {}),
		...(run.finalFile ? { finalFile: run.finalFile } : {}),
		...(run.costEstimate ? { costEstimate: run.costEstimate } : {}),
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
			metrics: { llmCalls: 0, mediaCalls: 0, retries: 0, perAdapter: {}, cost: { spent: 0, currency: "CNY" } },
			images: images.map((img) => ({
				id: img.id,
				name: img.name,
				file: path.join("assets", "ref", `${img.id}.${img.ext}`),
				url: `/api/runs/${id}/files/assets/ref/${img.id}.${img.ext}`,
			})),
			events: [],
			lastActions: [],
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

	/** 内存快照；排序与裁剪由 HTTP 层按磁盘更新时间决定 */
	list(): RunRecord[] {
		return [...this.runs.values()];
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
				// 事件从 events.ndjson 读取（ndjson 化后不再内嵌 run-state.json）；
				// 旧 run 首次加载时把内嵌 events 迁移出去，之后 persistRun 不再回写 events 字段。
				let events = readEventsNdjson(raw.dir);
				if (events === null) {
					const legacy = Array.isArray(raw.events) ? raw.events : [];
					events = legacy.slice(-EVENT_CAP);
					if (legacy.length > 0) {
						try {
							fs.writeFileSync(
								path.join(raw.dir, EVENTS_NDJSON),
								`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
								"utf-8",
							);
						} catch {
							// 迁移失败不阻塞恢复：下次重启会再试
						}
					}
				}
				const record: RunRecord = {
					...raw,
					images: Array.isArray(raw.images) ? raw.images : [],
					stages: migrateLegacyRunStages(raw.dir, raw.stages as RunStage[]),
					events,
					shotAttempts: raw.shotAttempts && typeof raw.shotAttempts === "object" ? raw.shotAttempts : {},
					lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
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

/** 把 run 状态落盘（run-state.json，临时文件 + rename 原子替换），服务重启后可恢复查询/播放。
 *  事件流已迁出本文件：pushEvent 逐条追加 events.ndjson（ndjson 化），
 *  本函数只在状态级变化时被调用（setStage/verdict/重做记账等），频率远低于事件。 */
export function persistRun(run: RunRecord): void {
	emitRunUpdate(run);
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

/** 团队频道事件上限：内存与视图保持同一上限（此前内存 500 / 落盘 400，
 *  重启恢复后事件凭空变少）。 */
const EVENT_CAP = 400;

// ---- 事件流 ndjson 落盘：每行一条、append-only（O(1)），替代"每条事件全量重写 run-state.json" ----

const EVENTS_NDJSON = "events.ndjson";
/** 单文件超此大小时压缩为最近 EVENT_CAP 条，防止长期追加无限增长 */
const EVENTS_NDJSON_COMPACT_AT = 512 * 1024;

function appendEventLine(run: RunRecord, event: TeamEvent): void {
	try {
		fs.mkdirSync(run.dir, { recursive: true });
		const file = path.join(run.dir, EVENTS_NDJSON);
		fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
		if (fs.statSync(file).size > EVENTS_NDJSON_COMPACT_AT) {
			fs.writeFileSync(
				file,
				`${run.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
				"utf-8",
			);
		}
	} catch {
		// 事件落盘失败不影响管线（与 persistRun 同策略）
	}
}

/** 启动恢复：读 events.ndjson 最近 EVENT_CAP 条；文件缺失返回 null（走迁移路径）。
 *  单行损坏只丢那一行——append 中途崩溃不会拖垮整个 run 的恢复。
 *  导出供行为测试锁定上述两条语义（test/event-ndjson.test.ts）。 */
export function readEventsNdjson(dir: string): TeamEvent[] | null {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, EVENTS_NDJSON), "utf-8");
	} catch {
		return null;
	}
	const events: TeamEvent[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t) as TeamEvent;
			if (typeof e?.id === "string" && typeof e?.text === "string") events.push(e);
		} catch {
			// 半行损坏跳过
		}
	}
	return events.slice(-EVENT_CAP);
}

export function pushEvent(
	run: RunRecord,
	from: RoleId,
	to: TeamEvent["to"],
	kind: TeamEvent["kind"],
	text: string,
	link?: EventLink,
): void {
	const event: TeamEvent = {
		id: `ev-${randomUUID().slice(0, 8)}`,
		at: new Date().toISOString(),
		from,
		to,
		kind,
		text,
		...(link ? { link } : {}),
	};
	run.events.push(event);
	if (run.events.length > EVENT_CAP) run.events.splice(0, run.events.length - EVENT_CAP);
	appendEventLine(run, event);
	// 只走事件级增量通道（SSE "ev"）；完整快照由状态级 persistRun 触发，
	// 不再为每条聊天/进度事件重新序列化整个 RunView。
	emitEventAppend(run, event);
}

// ============================================================================
// 运行追踪（Run 即 Trace：一次 run 一棵 span 树，落盘 traces.ndjson）
// ============================================================================

/** 追加一个 span：ndjson 落盘 + 可选 OTLP 导出（P3：设 VIDEO_AGENT_OTLP_URL 后激活） */
export function appendSpan(
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

export interface StageCtx {
	run: RunRecord;
	ctx: ServerContext;
	queue: GenerationQueue;
	signal: AbortSignal;
}

export function stage(run: RunRecord, id: StageId): RunStage {
	return run.stages.find((s) => s.id === id)!;
}

/** P2：累计本次 LLM 调用的成本（含多模态输入图粗估）。
 *  实现在 pricing.ts（trackLlmCost / trackMediaCost），此处仅保留类型说明：
 *  trackLlmCost(run, ctx, promptText, completionText, images?) / trackMediaCost(run, ctx, adapter, params, outputSeconds?) */

/** P2+审查保护：推送一条最近动作。3 分钟内同 (kind, shotId, label) 去重，
 *  超 L20 丢弃最旧。该函数只 push + persistRun，不动其他状态。 */
export function pushLastAction(run: RunRecord, action: ActionRecord): void {
	const cutoff = Date.now() - LAST_ACTION_DEDUP_MS;
	const dup = run.lastActions.some(
		(a) =>
			a.kind === action.kind &&
			(a.shotId ?? "") === (action.shotId ?? "") &&
			a.label === action.label &&
			new Date(a.at).getTime() >= cutoff,
	);
	if (dup) return;
	run.lastActions.unshift(action);
	if (run.lastActions.length > 20) run.lastActions.length = 20;
	persistRun(run);
}

/** P2+派发后回灌：快照当前 QA verdict 中指定镜头的裁决 + 五轴分数。
 *  传给 reshotRun / rettsRun 在动作前快照，动作完成后与新 verdict 对比。 */
export function snapshotShotVerdict(
	run: RunRecord,
	shotId: string,
): { axes: Record<string, number>; shot?: QaShotVerdict } | null {
	if (!run.verdict) return null;
	const axes = Object.fromEntries(run.verdict.axes.map((a) => [a.id, a.score]));
	const shot = run.verdict.shots?.find((s) => s.id === shotId);
	return { axes, ...(shot ? { shot: structuredClone(shot) } : {}) };
}

/** P2+派发后回灌：对比新旧 QA 快照，生成 pushEvent 文案。
 *  返回 null 表示无变化，不推事件。有变化时返回中英文混合短句。 */
export function computeQaDeltas(
	shotId: string,
	before: ReturnType<typeof snapshotShotVerdict>,
	after: ReturnType<typeof snapshotShotVerdict>,
): string | null {
	if (!before || !after) return null;
	const verdictChange = before.shot?.verdict !== after.shot?.verdict
		? `${before.shot?.verdict ?? "?"}→${after.shot?.verdict ?? "?"}`
		: null;
	const allAxisIds = new Set([...Object.keys(before.axes), ...Object.keys(after.axes)]);
	const improved: string[] = [];
	const regressed: string[] = [];
	for (const id of allAxisIds) {
		const b = before.axes[id];
		const a = after.axes[id];
		if (b === undefined || a === undefined) continue;
		const delta = a - b;
		if (delta > 0) improved.push(`${id} ${b}→${a} ✅`);
		else if (delta < 0) regressed.push(`${id} ${b}→${a} ⚠️`);
	}
	if (!verdictChange && improved.length === 0 && regressed.length === 0) return null;
	const parts: string[] = [];
	if (verdictChange) parts.push(`镜头裁决 ${verdictChange}`);
	if (improved.length) parts.push(improved.join(" / "));
	if (regressed.length) parts.push(regressed.join(" / "));
	return `重做 ${shotId} 后 QA 评分：${parts.join("；")}`;
}

/** 派发后回灌的“安静版”文案：只在**退步或裁决变化**时返回文本。
 *  纯改善场景返 null（调用方不推事件，避免“每次重做都被告知改善了”造成报警疲劳）。
 *  与 computeQaDeltas 是平等关系，不是子集：调用方按场景二选一。 */
export function computeQaRegressionText(
	shotId: string,
	before: ReturnType<typeof snapshotShotVerdict>,
	after: ReturnType<typeof snapshotShotVerdict>,
): string | null {
	if (!before || !after) return null;
	const verdictChange = before.shot?.verdict !== after.shot?.verdict
		? `${before.shot?.verdict ?? "?"}→${after.shot?.verdict ?? "?"}`
		: null;
	const regressed: string[] = [];
	for (const id of Object.keys(after.axes)) {
		const b = before.axes[id];
		const a = after.axes[id];
		if (b === undefined) continue;
		const delta = a - b;
		if (delta < 0) regressed.push(`${id} ${b}→${a} ⚠️`);
	}
	if (!verdictChange && regressed.length === 0) return null; // 纯改善不报
	const parts: string[] = [];
	if (verdictChange) parts.push(`镜头裁决 ${verdictChange}`);
	if (regressed.length) parts.push(regressed.join(" / "));
	return `重做 ${shotId} 后 QA 评分：${parts.join("；")}`;
}

export function setStage(run: RunRecord, id: StageId, status: RunStage["status"], progress: number): void {
	const s = stage(run, id);
	s.status = status;
	s.progress = progress;
	persistRun(run);
}

export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("已中止");
}

/**
 * 重做路径的"备份→生成→回滚"统一抽象。resbot/retts/重绘设计稿/重绘关键帧均复用。
 * 重要不变量：先备份再生成，顺序反了会把新图误挪进版本库、令主名悬空（原代码注释里反复强调）。
 *  失败：把刚备份的文件还原为主名、从 versions 弹出一项。
 *  返回：成功返 { file: 新主名 }，失败返 { file: null, backupRestored: true }。
 */
/** 重做路径公共抽象（backup→generate→rollback）。已迁到 ./asset-version.ts 独立维护 */
import { withVersionedAsset, fileDataUrl } from "./asset-version.ts";
export { withVersionedAsset, fileDataUrl };

/** 媒体适配器查找 + 视频请求参数（亚尼斯 2.5 vs 2.0 区别）。已迁到 ./redo-adapters.ts */
import { isAgnesVideo25, ttsAdapterOf, videoAdapterOf, videoSubmitParams } from "./redo-adapters.ts";


export function optionsOf(run: RunRecord): GenerationOptions {
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
	// A1 闸门（服务端兜底）：台词模式只对共创来源开放——UI 藏开关不够，直接打 API
	// 仍能传 dialogue；这里是"闸门优先于派发"的落点。触发必须可审计（见下方事件）。
	const audioDriveGated = shouldGateAudioDrive(options.audioDrive, input.coSpace);
	if (audioDriveGated) options.audioDrive = "off";
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
	// P2：pre-flight 预估成本（启动时算一次）
	const pre = pricingEstimateRun({
		catalog: ctx.priceCatalog,
		shotCount: options.shotCount,
		clipDurationSec: options.clipDurationSec,
	});
	run.costEstimate = { total: pre.total, currency: pre.currency, lines: pre.lines };
	persistRun(run);
	if (audioDriveGated) {
		pushEvent(
			run,
			"producer",
			"all",
			"status",
			"音频驱动（台词模式）当前只对共创空间开放，本条需求非共创来源，已自动回落为旁白方案。",
		);
	}
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

export function refImageNote(run: RunRecord): string {
	if (run.images.length === 0) return "";
	return `参考素材: 用户上传了 ${run.images.length} 张图片。画面主体、产品外观与氛围请以参考图为准，在剧本与视觉规范中主动呼应图中的风格元素。`;
}

// stageScript 已迁到 ./stages/script.ts
import { stageScript } from "./stages/script.ts";
export { stageScript };

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
	// deriveDesignBible 已迁到 ./stages/visual-derive.ts
	const { deriveDesignBible } = await import("./stages/visual-derive.js");
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
export async function generateImage(
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
	const imageAdapter = sc.ctx.mediaConfig.media.find((m) => m.kind === "image");
	if (imageAdapter) {
		trackMediaCost(run, sc.ctx, { id: imageAdapter.id, kind: "image", model: imageAdapter.model }, {});
	}
	return path.relative(run.dir, finished.filePath!);
}

export async function readDesignBible(run: RunRecord): Promise<DesignBibleDoc | null> {
	try {
		return await readArtifact<DesignBibleDoc>(run, "design-bible.json");
	} catch {
		return null;
	}
}

export async function writeDesignBible(run: RunRecord, doc: DesignBibleDoc): Promise<void> {
	await writeJson(run, "design-bible.json", doc);
}

// deriveDesignBible 已迁到 ./stages/visual-derive.ts
//   （含原 deriveDesignBible + autoReviewDesign 两函数）

/** 设计出图自审：审核 → fail 卡带审核意见重绘（1 轮）→ 复审；结果写回实体 review 字段 */

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

// redesignEntityInner 已迁到 ./redo/entity.ts（单卡设计图重绘）
import { redesignEntityInner } from "./redo/entity.ts";

// stagePrompts 已迁到 ./stages/prompts.ts
import { stagePrompts } from "./stages/prompts.ts";
export { stagePrompts };
/** @deprecated 旧内联定义位置标记（实际已迁出） */

/** 独立关键帧阶段：分镜文本定稿后逐镜绘制首帧锚定图，完成后挂关键帧确认闸门 */

// ---------------------------------------------------------------------------
// stageKeyframes 已迁到 ./stages/keyframes.ts
import { stageKeyframes } from "./stages/keyframes.js";
export { stageKeyframes };
// stageAudio 已迁到 ./stages/audio.ts
import { stageAudio } from "./stages/audio.ts";
export { stageAudio };
// 分镜关键帧：每镜一张首帧锚定图（组图预览 + 图生视频输入）
// ---------------------------------------------------------------------------

export async function readKeyframes(run: RunRecord): Promise<KeyframesDoc> {
	try {
		const doc = await readArtifact<KeyframesDoc>(run, "keyframes.json");
		if (Array.isArray(doc.frames)) return doc;
	} catch {
		// 首次生成
	}
	return { frames: [] };
}

/** 同步写确认清单：resume 在启动下游前必须保证制作集已落盘 */
function persistKeyframeConfirmations(run: RunRecord, doc: KeyframesDoc, confirmedShotIds: string[]): void {
	const next: KeyframesDoc = {
		...doc,
		frames: doc.frames.map((frame) => ({
			...frame,
			...(confirmedShotIds.includes(frame.shotId) ? { confirmed: true } : { confirmed: false }),
		})),
		confirmedShotIds,
	};
	const tmp = path.join(run.dir, `keyframes-confirm.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(next, null, "\t"), "utf-8");
	fs.renameSync(tmp, path.join(run.dir, "keyframes.json"));
}

/** fileDataUrl 已迁到 ./asset-version.ts（与 withVersionedAsset 同源） */

/** 分镜提示词签名：上游 refine 后签名变化 → 关键帧可据此判定过期（B8 级联依据） */
export function promptSigOf(prompt: string): string {
	return createHash("sha1").update(prompt).digest("hex").slice(0, 12);
}

/**
 * 设计素材锚点（来自美术设计）：关键帧/重做提示词强制注入。
 * 分镜提示词由 LLM 转写时会 cherry-pick（实测只复述了服装、丢掉年龄/发色/场景），
 * 锚点必须在出图前程序性拼接，不能依赖 LLM 自觉复述。
 */
export async function designAnchorsOf(run: RunRecord): Promise<string> {
	const doc = await readArtifact<DesignBibleDoc>(run, "design-bible.json").catch(() => null);
	const chars = (doc?.characters ?? []).filter((c) => c.design.trim().length > 0);
	const scenes = (doc?.scenes ?? []).filter((s) => s.design.trim().length > 0);
	const parts: string[] = [];
	if (chars.length) parts.push(chars.map((c) => `${c.name}(${c.design})`).join("; "));
	if (scenes.length) parts.push(scenes.map((s) => `${s.name}(${s.design})`).join("; "));
	return parts.join(" | ");
}

/** 把多张设计定稿纵向拼成一张参考板：适配器仍收单图，但画面包含全部视觉原料 */
export async function buildReferenceSheet(run: RunRecord, shotId: string, sources: string[]): Promise<string | null> {
	if (sources.length === 0) return null;
	if (sources.length === 1) return sources[0]!;
	const outRel = path.join(".refs", `key-${shotId}-sheet.png`);
	const outAbs = path.join(run.dir, outRel);
	await fs.promises.mkdir(path.dirname(outAbs), { recursive: true });
	const normalized = sources
		.map(
			(_, i) =>
				`[${i}:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1[t${i}]`,
		)
		.join(";");
	const stack = `[${sources.map((_, i) => `t${i}`).join("][")}]hstack=inputs=${sources.length}[out]`;
	try {
		await runFfmpeg(
			[
				"-y",
				"-loglevel",
				"error",
				...sources.flatMap((source) => ["-i", source.replace(/\\/g, "/")]),
				"-filter_complex",
				`${normalized};${stack}`,
				"-map",
				"[out]",
				"-frames:v",
				"1",
				outRel.replace(/\\/g, "/"),
			],
			run.dir,
			run.abort.signal,
		);
		const stat = await fs.promises.stat(outAbs).catch(() => null);
		if (!stat || stat.size === 0) throw new FfmpegError("参考板输出为空");
		return outRel;
	} catch (error) {
		if (run.abort.signal.aborted) throw error;
		pushEvent(run, "tech", "producer", "status", `镜头 ${shotId} 多实体参考板合成失败 ⚠️，已降级最高优先参考图。`);
		return sources[0]!;
	}
}

interface KeyframeReferenceBundle {
	entities: DesignEntity[];
	file: string | null;
	dataUrl: string | null;
	anchors: string;
}

/** 该镜多实体依赖解析：返回 ID 矩阵 + 合成参考板（无匹配定稿 → null，走纯文本锚点） */
export async function keyframeReferencesOf(
	shotId: string,
	run: RunRecord,
	shotPrompt: string,
	shotVisual?: string,
): Promise<KeyframeReferenceBundle> {
	const doc = await readDesignBible(run);
	const entities = pickKeyframeReferences(doc, `${shotVisual ?? ""}\n${shotPrompt}`);
	if (entities.length === 0) return { entities: [], file: null, dataUrl: null, anchors: "" };
	// 锚点全英文拼接（category 标签也用英文）：文生图模型对英文锚点的遵循显著更稳
	const anchors = entities.map((entity) => `${entity.category} "${entity.name}": ${entity.design}`).join(" | ");
	const file = await buildReferenceSheet(run, shotId, entities.map((entity) => entity.file!).filter(Boolean));
	const dataUrl = file ? await fileDataUrl(run.dir, file) : null;
	pushEvent(
		run,
		"tech",
		"producer",
		"status",
		`镜头画面将锚定 ${entities.length} 个设计定稿：${entities.map((e) => `${e.name}(${e.id})`).join("、")}。`,
	);
	return { entities, file, dataUrl, anchors };
}

/**
 * 失效级联：某设计定稿更新后，把曾以它为参考图的关键帧标记为相对新设定过期。
 * 纯文本锚点出图的帧没有视觉漂移来源，只提示可选的整体对齐路径，不打扰确认节奏。
 */
export async function propagateEntityUpdate(run: RunRecord, entity: DesignEntity): Promise<void> {
	const frames = await readKeyframes(run);
	const affected = frames.frames.filter((f) => (f.refs ?? []).includes(entity.id));
	if (affected.length === 0) {
		pushEvent(
			run,
			"art",
			"producer",
			"status",
			`设计定稿「${entity.name}」已更新。现有关键帧未直接引用它（文本锚点出图），无需强制重绘；如需严格全量对齐，可微调分镜提示词后整体重跑。`,
		);
		return;
	}
	for (const f of affected) {
		f.staleRefs = [...new Set([...(f.staleRefs ?? []), entity.id])];
		delete f.confirmed;
	}
	// 设计源更新会取消对应帧的放行资格；已记录的制作集同步移除该镜
	if (Array.isArray(frames.confirmedShotIds))
		frames.confirmedShotIds = frames.confirmedShotIds.filter((id) => !affected.some((f) => f.shotId === id));
	await writeJson(run, "keyframes.json", frames);
	pushEvent(
		run,
		"art",
		"producer",
		"redo",
		`设计定稿「${entity.name}」已更新 ⚠️ ${affected.length} 镜关键帧基于旧形象（已标过期）：${affected
			.map((f) => f.shotId)
			.join("、")}。请逐镜重绘后重新确认。`,
		{ stage: "keyframes", label: "去处理" },
	);
}

/** 确保该镜有关键帧；缺失则按分镜提示词生成一张（版本化备份由调用方重绘路径负责） */
export async function ensureKeyframe(
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
	const references = await keyframeReferencesOf(shotId, run, shotPrompt, shot?.visual);
	const referenceImage = references.dataUrl;
	// 记录本帧依赖的设计定稿：该实体重绘时可精确级联标过期；新出图即视为同步了最新设定
	entry.refs = references.entities.map((entity) => entity.id);
	if (references.file) entry.refSheet = references.file;
	else delete entry.refSheet;
	delete entry.staleRefs;
	pushEvent(
		run,
		"tech",
		"producer",
		"status",
		`镜头 ${shotId} 先出关键帧（首帧锚定图${referenceImage ? ` · ${references.entities.length} 实体参考板` : ""}）…`,
	);
	try {
		const file = await generateImage(
			sc,
			keyframePrompt(shotPrompt, bible, references.anchors),
			`key-${shotId}`,
			imageSizeFor(optionsOf(run).aspectRatio),
			{ referenceImage },
		);
		if (file) {
			entry.file = file;
			entry.status = "done";
			entry.error = undefined;
			// 签名必须随出图落盘：stageKeyframes 的 stale 级联靠它检测上游 refine（缺写=级联死代码）
			entry.promptSig = promptSigOf(shotPrompt);
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
			stage: "keyframes",
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
	opts?: { auto?: boolean },
): Promise<{ ok: boolean; error?: string }> {
	// 同步占位：检查与置位之间无 await，杜绝双提交竞态窗口；结束恢复原状态
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const prevStatus = run.status;
	run.status = "running";
	let result: { ok: boolean; error?: string; keyframeWasFailed?: boolean };
	try {
		result = await redesignKeyframeInner(ctx, run, shotId, instruction, opts);
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

/** 显式运行时导出别名：实验性 module mocks 下函数声明绑定偶发不可见。 */
export const redrawKeyframe = redesignKeyframe;

// redesignKeyframeInner 已迁到 ./redo/keyframe.ts（单镜关键帧重绘）
import { redesignKeyframeInner } from "./redo/keyframe.ts";

/** 关键帧自审：审核 → fail 帧带审核意见自动重绘（auto 轮，不占手动配额）→ 定向复审 */
async function autoReviewKeyframes(sc: StageCtx): Promise<void> {
	const { run, ctx, signal } = sc;
	const t0 = Date.now();
	let flagged: KeyframeEntry[];
	try {
		pushEvent(run, "reviewer", "storyboard", "status", "审校员核对关键帧：逐帧比对画面与设计定稿…");
		const { reviewed } = await reviewKeyframes(ctx, run, signal);
		flagged = reviewed.filter((f) => f.review?.verdict === "fail");
		const warnCount = reviewed.filter((f) => f.review?.verdict === "warn").length;
		appendSpan(
			run,
			{
				stage: "keyframes",
				name: "关键帧·出图自审",
				kind: "qa",
				status: flagged.length > 0 ? "semantic-fail" : "ok",
				input: `${reviewed.length} 帧送审`,
				output: `${reviewed.length - flagged.length - warnCount} ok / ${warnCount} warn / ${flagged.length} fail`,
			},
			t0,
		);
		pushEvent(
			run,
			"reviewer",
			"storyboard",
			flagged.length > 0 ? "redo" : "status",
			flagged.length > 0
				? `关键帧自审发现问题 ⚠️：${flagged.map((f) => `镜头 ${f.shotId}（${f.review!.issues.join("、")}）`).join("；")}。安排技术导演带意见重绘。`
				: `关键帧自审通过 ✅ ${reviewed.length} 帧与设计定稿相符${warnCount > 0 ? `（另有 ${warnCount} 帧小偏差，可人工复核）` : ""}。`,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		appendSpan(
			run,
			{
				stage: "keyframes",
				name: "关键帧·出图自审",
				kind: "qa",
				status: "error",
				output: error instanceof Error ? error.message : String(error),
			},
			t0,
		);
		pushEvent(run, "reviewer", "producer", "status", "关键帧自审未成功 ⚠️（不影响管线），可在关键帧面板手动发起审核。");
		return;
	}
	if (flagged.length === 0) return;

	// fail 帧自动重绘一轮：审核意见即调整指令，重绘走自参考+设计定稿矩阵（不占手动配额）
	const redrawnShotIds: string[] = [];
	for (const frame of flagged) {
		throwIfAborted(signal);
		const issues = frame.review?.issues.join("；") ?? "";
		const result = await redesignKeyframeInner(ctx, run, frame.shotId, issues, { auto: true });
		if (result.ok) {
			redrawnShotIds.push(frame.shotId);
		} else {
			pushEvent(run, "reviewer", "storyboard", "status", `镜头 ${frame.shotId} 按审核意见重绘未成功 ⚠️：${result.error ?? "未知原因"}`);
			// auto 路径达独立上限：跳出本轮重绘循环（不要死循环 burn 预算）。
			if (result.error?.includes("自动重绘") && result.error?.includes("仍未通过")) break;
		}
	}
	if (redrawnShotIds.length === 0) return;

	// 复审重绘帧：确认修复效果；仍不合格的标注在帧上交人工（确认闸门仍可拦）
	try {
		const { reviewed } = await reviewKeyframes(ctx, run, signal, redrawnShotIds);
		const fixed = reviewed.filter((f) => f.review?.verdict !== "fail");
		const still = reviewed.filter((f) => f.review?.verdict === "fail");
		appendSpan(
			run,
			{
				stage: "keyframes",
				name: "关键帧·重绘复审",
				kind: "qa",
				status: still.length > 0 ? "semantic-fail" : "ok",
				input: `${redrawnShotIds.length} 帧重绘复审`,
				output: `${fixed.length} 修复 / ${still.length} 仍不合格`,
			},
			Date.now(),
		);
		pushEvent(
			run,
			"reviewer",
			"client",
			"status",
			still.length > 0
				? `关键帧重绘后仍有问题 ⚠️：${still.map((f) => `镜头 ${f.shotId}（${f.review!.issues.join("、")}）`).join("；")}。已在帧上标注，确认前请人工定夺（可手动重绘或确认放行）。`
				: `关键帧审核问题已全部修复 ✅ 镜头 ${fixed.map((f) => f.shotId).join("、")} 复审通过。`,
			{ stage: "keyframes", label: "查看关键帧" },
		);
	} catch (error) {
		if (signal.aborted) throw error;
	}
}



// stageExport 已迁到 ./stages/export.ts（视频合成 + 一致性预检 + QA + 旁白回灌）
import { stageExport } from "./stages/export.ts";
export { stageExport };

/** 阶段调度：按顺序执行给定阶段；上游产物优先用调用方传入（避免重复生成/读盘不一致） */
export async function executeStages(
	ctx: ServerContext,
	run: RunRecord,
	ids: StageId[],
	_o: { fromResume: boolean },
): Promise<void> {
	const queue = new GenerationQueue(ctx.mediaConfig);
	// B2 观察层：活跃队列注册（制片主任 observe_kitchen 要看到炉内/排队任务）
	registerActiveQueue(run.id, queue);
	// B1② 事件驱动触发（最小集）：首次任务失败自动唤起制片主任观察一次
	// （LLM 调用 fire-and-forget，不阻塞管线；同 run 只触发一次，防费用失控）。
	// onJobUpdate 用可选调用：测试桩队列 / 旧队列实例没有该方法时静默跳过。
	// 配额阈值越线触发需要配额结算事件流，随 L2 执行闭环一起补。
	let autoObservedFailure = false;
	const offJobUpdate =
		queue.onJobUpdate?.((job: QueueJob) => {
			if (autoObservedFailure || job.status !== "failed" || run.abort.signal.aborted) return;
			autoObservedFailure = true;
			void producerObserve(run, ctx, { trigger: "auto:任务失败" }).catch(() => {
				// 自动观察失败不影响管线
			});
		}) ?? (() => {});
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
			if ((id === "audio" || id === "clips") && run.gate === "keyframes") {
				holdAtKeyframeGate(run);
				return;
			}
			if (id === "script") {
				script = await stageScript(stageCtx);
			} else if (id === "visual") {
				bible = await stageVisual(stageCtx, script);
			} else if (id === "prompts") {
				await stagePrompts(stageCtx, script, bible);
			} else if (id === "keyframes") {
				await stageKeyframes(stageCtx, script, bible);
				// 本轮绘制了新的画面原料 → 必须重新过确认闸门
				run.gate = "keyframes";
			} else if (id === "audio") {
				audio = await stageAudio(stageCtx, script ?? clips?.script);
			} else if (id === "clips") {
				clips = await stageClips(stageCtx, script ?? clips?.script);
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
			pushEvent(run, "producer", "client", "status", "全片交付 🎉 成片与七轴质检报告已就绪。", {
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
	} finally {
		// B2 观察层：run 结束（含失败/取消）后注销活跃队列
		offJobUpdate();
		unregisterActiveQueue(run.id);
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

	// 纯提示词重塑也要立刻重绘关键帧：否则旧画面会顶着新分镜进入下一个确认闸门。
	const ids = STAGE_IDS.slice(idx).filter(
		(id) => autoResume || TEXT_STAGES.includes(id) || (stageId === "prompts" && id === "keyframes"),
	);
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
export function resumeRun(
	ctx: ServerContext,
	run: RunRecord,
	confirmedShotIds?: string[],
): { ok: boolean; error?: string } {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const next = run.stages.find((s) => s.status !== "done");
	if (!next) return { ok: false, error: "所有阶段已完成，无需推进" };

	// 关键帧闸门允许部分确认：请求中显式给出的 ID 清单就是本次视频制作集。
	// 这里同步校验并落盘，保证下游 clips/audio/export 看到同一份不可变清单。
	if (run.gate === "keyframes") {
		try {
			const scriptDoc = JSON.parse(fs.readFileSync(path.join(run.dir, "script.json"), "utf-8")) as ScriptDoc;
			const keyframesDoc = JSON.parse(
				fs.readFileSync(path.join(run.dir, "keyframes.json"), "utf-8"),
			) as KeyframesDoc;
			const readyIds = scriptDoc.shots
				.filter((shot) => keyframesDoc.frames.some((f) => f.shotId === shot.id && f.status === "done"))
				.map((shot) => shot.id);
			const staleIds = scriptDoc.shots.flatMap((shot) => {
				const frame = keyframesDoc.frames.find((f) => f.shotId === shot.id);
				return frame?.status === "done" && (frame.staleRefs ?? []).length > 0 ? [shot.id] : [];
			});
			// 兼容旧客户端/内部续跑：未传清单 = 显式全量确认；空数组 = 拒绝（至少放行一镜）。
			const requested = confirmedShotIds ?? readyIds;
			if (requested.length === 0) return { ok: false, error: "至少勾选 1 张关键帧才能进入视频生成" };
			const seen = new Set<string>();
			for (const id of requested) {
				if (seen.has(id)) return { ok: false, error: `关键帧确认清单重复：${id}` };
				seen.add(id);
			}
			const unknown = requested.find((id) => !readyIds.includes(id));
			if (unknown) return { ok: false, error: `关键帧 ${unknown} 不存在或尚未生成完成` };
			const staleRequested = requested.find((id) => staleIds.includes(id));
			if (staleRequested) {
				return {
					ok: false,
					error: `关键帧 ${staleRequested} 已落后于最新美术设计，请先重绘同步后再进入视频生成`,
				};
			}
			const selection = scriptDoc.shots.map((s) => s.id).filter((id) => seen.has(id));
			persistKeyframeConfirmations(run, keyframesDoc, selection);
			if (selection.length < scriptDoc.shots.length) {
				pushEvent(
					run,
					"producer",
					"all",
					"status",
					`关键帧部分确认 ✅ ${selection.length}/${scriptDoc.shots.length} 镜进入视频生成；未勾选镜头不会提交额度。`,
					{ stage: "keyframes", label: "查看确认结果" },
				);
			}
		} catch (error) {
			return {
				ok: false,
				error: `无法读取关键帧确认产物：${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	// 确认闸门通过：清闸门并记录
	if (run.gate === "design") {
		pushEvent(run, "producer", "all", "status", "美术设计已确认 ✅ 开始绘制分镜关键帧。");
		run.gate = undefined;
	} else if (run.gate === "keyframes") {
		if (confirmedShotIds === undefined)
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

/** 重新导出点：reexportRun  同步入口、异步执行。看准入口点 push 即可（失败也记成本
 *  已发生，去重保护后续误点）。 */
function pushReexportAction(run: RunRecord, aspectLabel: string): void {
	pushLastAction(run, {
		kind: "reexport",
		label: aspectLabel,
		at: new Date().toISOString(),
	});
}

/** 重新导出支持的画幅白名单 */
const REEXPORT_ASPECTS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3"];

/**
 * 重新导出：不重新生成任何镜头/配音，只重跑 export 阶段
 * （归一化 → EDL 转场决策 → xfade 时间线合成 → 质检）。
 * 典型场景：上传/更换 BGM 后重新合成、重新让剪辑师出转场、
 * 多平台分发（指定 aspectRatio 产出 final-9x16.mp4 等多画幅版本）。
 */
// reexportRun 已迁到 ./redo/reexport.ts 独立维护
import { reexportRun } from "./redo/reexport.ts";
export { reexportRun };

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
// reshotRun 已迁到 ./redo/reshot.ts 独立维护
import { reshotRun } from "./redo/reshot.ts";
export { reshotRun };

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
// rettsRun 已迁到 ./redo/retts.ts 独立维护
import { rettsRun } from "./redo/retts.ts";
export { rettsRun };
// composeCut 已迁到 ./redo/compose.ts 独立维护
import { composeCut, listShotVersions } from "./redo/compose.ts";
export { composeCut, listShotVersions };
/** @deprecated 旧内联定义位置标记（实际已迁出） */

/** 导演对话可识别并直接执行的意图（语音/画面重做类诉求免手工操作） */
type DirectorIntent = "none" | "reshot" | "retts" | "reexport";

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
		trackLlmCost(run, ctx, user, JSON.stringify(plan));
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
			// 不承诺会自动执行：当前没有 pending 队列，说"稍后安排"是食言。
			// 诚实话术 + 让用户本轮结束后再发一次即可立即派发。
			actionNote = "（管线正在运行，现在改不了；这一轮结束后请再发一次指令，我立即安排。）";
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
		keyframes: "分镜关键帧",
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
		keyframes: "技术导演",
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

export async function generateDoc<T>(
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
		// images 参与计费：参考图走多模态输入，按张数粗估 token（B3）
		trackLlmCost(run, ctx, userPrompt, JSON.stringify(doc), images.length);
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

// runQa 已迁到 ./qa/review.ts（视觉质检：5 轴 + 逐镜三态 + audioSync 确定性）
import { runQa } from "./qa/review.ts";
export { runQa };

// ============================================================================
// LLM 输出修正（防字段缺失/越界）
// ============================================================================

export function normalizeScript(script: ScriptDoc, opts: GenerationOptions): ScriptDoc {
	const shots = Array.isArray(script.shots) ? script.shots : [];
	return {
		title: typeof script.title === "string" && script.title ? script.title : "Untitled Ad",
		logline: typeof script.logline === "string" ? script.logline : "",
		shots: shots
			.filter((s) => s && typeof s.visual === "string" && s.visual)
			.map((s, i) => {
				// audioMode 清洗：白名单外一律回落 narration（既有作品无此字段，语义不变）
				const rawMode = (s as { audioMode?: unknown }).audioMode;
				const baseMode: AudioMode =
					rawMode === "dialogue" ? "dialogue" : rawMode === "silent" ? "silent" : "narration";
				// 台词子结构清洗失败 → 整镜回落旁白语义，不留"台词态却无台词"的悬空状态
				const dialogue = baseMode === "dialogue" ? sanitizeDialogue(s.dialogue) : null;
				const audioMode: AudioMode = baseMode === "dialogue" && dialogue === null ? "narration" : baseMode;
				return {
					id: typeof s.id === "string" && s.id ? s.id : `SH${String(i + 1).padStart(2, "0")}`,
					narrationZh: typeof s.narrationZh === "string" ? s.narrationZh : "",
					narrationEn: typeof s.narrationEn === "string" ? s.narrationEn : "",
					visual: s.visual,
					durationSec: opts.clipDurationSec,
					audioMode,
					...(dialogue ? { dialogue } : {}),
				};
			})
			.slice(0, opts.shotCount + 2),
	};
}

export function normalizeBible(bible: VisualBible): VisualBible {
	return {
		styleKeywords: Array.isArray(bible.styleKeywords)
			? bible.styleKeywords.filter((k) => typeof k === "string").slice(0, 10)
			: [],
		palette: Array.isArray(bible.palette) ? bible.palette.filter((k) => typeof k === "string").slice(0, 8) : [],
		lighting: typeof bible.lighting === "string" ? bible.lighting : "",
		grade: typeof bible.grade === "string" ? bible.grade : "",
	};
}

export function normalizeShotPrompts(doc: ShotPromptDoc, script: ScriptDoc, bible: VisualBible): ShotPromptDoc {
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
export function promptsToText(messages: { role: string; content: string | { text?: string }[] }[]): string {
	return messages
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((part) => part.text ?? "").join("\n")))
		.join("\n");
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
export async function ensureVoiceDirections(sc: StageCtx, scriptDoc: ScriptDoc): Promise<Map<string, string>> {
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
		const voiceDirectionsPrompt = promptsToText(voiceDirectionsMessages(run.brief, scriptDoc, optionsOf(run)));
		const raw = await chatJson<{ directions?: { shotId?: unknown; instruction?: unknown }[] }>(
			ctx.llm,
			voiceDirectionsPrompt,
			signal,
		);
		run.metrics.llmCalls += 1;
		trackLlmCost(run, ctx, voiceDirectionsPrompt, JSON.stringify(raw));
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

// stageClips 已迁到 ./stages/clips.ts
import { stageClips } from "./stages/clips.ts";
export { stageClips };
