/**
 * API 契约 —— UI 与服务端之间唯一的边界。
 *
 * 与 video-agent-server 的 Express 端点一一对应：
 *   访谈 clarify/start|next|answer|skip · 上传 uploads · 生成 generate
 *   轮询 runs/:id · 产物 runs/:id/artifacts · 文件 runs/:id/files/*
 *   实时 runs/:id/events（SSE） · 断线由 store 自动退回轮询兜底
 *   导演对话 chat · 微调 refine · 续跑 resume · 取消 cancel · 成片 video/download
 */

import type { GenerationOptions } from "@earendil-works/pi-video-agent";

// ---- 运行状态 ----

export type StageId = "script" | "visual" | "prompts" | "keyframes" | "clips" | "audio" | "export";

/** 视频制作团队角色（与后端 pipeline ROLE_LABEL 对齐） */
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

export interface RunStage {
	id: StageId;
	status: "pending" | "running" | "done" | "failed";
	/** 0-100，阶段内进度 */
	progress: number;
}

export type AxisId = "briefFit" | "visualConsistency" | "pacing" | "audioSync" | "textQuality";

/** 审片员对单镜头的三态标注（镜头级重做依据） */
export interface QaShotVerdict {
	id: string;
	verdict: "ok" | "warn" | "fail";
	reason: string;
}

export interface QaVerdict {
	overall: "pass" | "warn" | "fail";
	score: number;
	axes: { id: AxisId; score: number }[];
	/** 逐镜标注（旧 run 可能缺失） */
	shots?: QaShotVerdict[];
}

/** 运行追踪 span（Run 即 Trace） */
export interface TraceSpan {
	spanId: string;
	stage: StageId | "reshot" | "chat";
	name: string;
	kind: "llm" | "media" | "ffmpeg" | "qa";
	startAt: string;
	durationMs: number;
	status: "ok" | "error" | "semantic-fail";
	input?: string;
	output?: string;
}

/** 每镜重做上限（与服务端 MAX_RESHOT_PER_SHOT 一致） */
export const MAX_RESHOT_PER_SHOT = 3;

/** 每镜旁白重录上限（与服务端 MAX_RETTS_PER_SHOT 一致） */
export const MAX_RETTS_PER_SHOT = 3;

export interface RunMetrics {
	llmCalls: number;
	mediaCalls: number;
	retries: number;
	perAdapter: Record<string, number>;
	/** P2：累计成本（目前为 0；下一步接入每调用计费时填实） */
	cost?: { spent: number; currency: "CNY" | "USD" };
}

/** P2：pre-flight 预估成本（run 启动时一次性计算） */
export interface CostEstimateView {
	total: number;
	currency: "CNY" | "USD";
	lines: { label: string; amount: number; note?: string }[];
}

/** 事件关联产物的跳转（团队频道快捷链接；stage 为 UI 阶段 id，focus 为卡片定位键） */
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

/** 进行中的重做（进度栏「重做中」态；无重做时缺省） */
export interface RedoActive {
	kind: "reshot" | "retts" | "reexport";
	shotId?: string;
	label: string;
}

/** 用户上传的参考图（run 内 assets/ref） */
export interface RunImage {
	id: string;
	name: string;
	url: string;
}

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
	images: RunImage[];
	events: TeamEvent[];
	/** refine 后存在未推进的下游阶段时为 true，UI 展示「继续推进」 */
	awaitingResume: boolean;
	/** 当前待确认闸门（undefined = 无） */
	gate?: "design" | "keyframes";
	/** 每镜重做次数（镜头级重做护栏） */
	shotAttempts: Record<string, number>;
	/** 每镜历史版本文件名（当前版本恒占主名 clip-SHxx.mp4） */
	shotVersions: Record<string, string[]>;
	/** 每镜旁白重录次数（语音重做护栏） */
	ttsAttempts: Record<string, number>;
	/** 每镜旁白历史版本文件名（当前版本恒占主名 tts-SHxx.mp3） */
	ttsVersions: Record<string, string[]>;
	/** 进行中的重做（进度栏「重做中」态；无重做时缺省） */
	redoActive?: RedoActive;
	/** P2+审查保护：最近完成的动作账本（reshot/retts/reexport/compose）。 */
	lastActions?: Array<{
		kind: "reshot" | "retts" | "reexport" | "compose";
		shotId?: string;
		label: string;
		at: string;
	}>;
	/** 最近一次导出的目标画幅（未设置 = 生成时主画幅） */
	exportAspectRatio?: string;
	/** 最近一次导出的成片文件名（assets 下，多画幅分发版存在） */
	finalFile?: string;
	/** P2：pre-flight 预估成本（run 启动时算一次） */
	costEstimate?: CostEstimateView;
}

/** 首页项目列表用轻量视图（与 server runSummary 对齐） */
export interface RunSummary {
	id: string;
	status: RunStatus;
	gate?: "design" | "keyframes";
	logline: string;
	keyMessage?: string;
	error?: string;
	videoUrl?: string;
	doneStages: number;
	totalStages: number;
	updatedAt?: string;
}

/** SSE 处理器；浏览器 EventSource 会自动重连，错误只表示当前暂时退回轮询。
 *  onRun = 完整快照（状态级变化）；onEvent = 单条团队事件增量（ndjson 化后的高频通道）。 */
export interface RunStreamHandlers {
	onRun: (run: RunView) => void;
	onEvent?: (event: TeamEvent) => void;
	onOpen?: () => void;
	onError?: () => void;
}

export interface BriefInput {
	logline: string;
	keyMessage?: string;
}

// ---- 中间产物文档 ----

/** 每镜声音模式（A1/A7；与服务端 ScriptShot 对齐；缺省 = narration 向后兼容） */
export type AudioMode = "narration" | "dialogue" | "silent";

/** 台词镜子结构（仅 audioMode === "dialogue"；audioDurationSec/audioUrl 由生成链路回写） */
export interface ShotDialogue {
	characterId: string;
	voiceId?: string;
	lines: { zh: string; en: string };
	emotion?: string;
	pace?: "slow" | "normal" | "fast";
	/** 台词内停顿（秒）——2.5-flash 按音频包络对口型，停顿即闭嘴 */
	pausesSec?: number[];
	/** TTS 后 ffprobe 实测时长 */
	audioDurationSec?: number;
	/** COS 托管公开 URL（可 <audio> 直接预览） */
	audioUrl?: string;
}

export interface ScriptShot {
	id: string;
	narrationZh: string;
	narrationEn: string;
	visual: string;
	durationSec: number;
	ttsDirection?: string;
	audioMode?: AudioMode;
	dialogue?: ShotDialogue;
}

export interface ScriptDoc {
	title: string;
	logline: string;
	shots: ScriptShot[];
}

export interface VisualBible {
	styleKeywords: string[];
	palette: string[];
	lighting: string;
	grade: string;
}

export interface ShotPromptDoc {
	prompts: { shotId: string; prompt: string }[];
}

/** 设计卡审核结论（视觉模型对照 design 要点审查出图） */
export interface DesignReview {
	verdict: "ok" | "warn" | "fail";
	issues: string[];
	checkedAt: string;
}

/** 美术设计：人物/道具/场景概念图（design-bible.json；旧 run 可能缺失） */
export interface DesignEntity {
	id: string;
	category: "character" | "prop" | "scene";
	name: string;
	design: string;
	file?: string;
	url?: string;
	status: "pending" | "done" | "failed";
	error?: string;
	attempts: number;
	versions: string[];
	/** 最近一次出图审核结论（未审核/旧 run 缺省） */
	review?: DesignReview;
}

export interface DesignBibleDoc {
	characters: DesignEntity[];
	props: DesignEntity[];
	scenes: DesignEntity[];
	generatedAt?: string;
}

/** 分镜关键帧（keyframes.json；片段生成阶段逐镜产出） */
export interface KeyframeEntry {
	shotId: string;
	file?: string;
	url?: string;
	status: "pending" | "done" | "failed";
	error?: string;
	/** 本帧参考板包含的设计实体 id；也是设计源更新的精确级联依据 */
	refs?: string[];
	/** 服务端合成的多实体参考板文件；缺省表示无视觉参考或旧版单图 run */
	refSheet?: string;
	/** 这些实体的设计定稿在出图后又更新过：当前画面相对新设定已过期 */
	staleRefs?: string[];
	/** 本轮用户确认时放行该镜；未勾选镜头不会进入视频生成 */
	confirmed?: boolean;
	attempts: number;
	versions: string[];
}

export interface KeyframesDoc {
	frames: KeyframeEntry[];
	/** 部分确认后的视频制作集；undefined = 未记录（旧 run 兜底全量） */
	confirmedShotIds?: string[];
	generatedAt?: string;
}

export interface AssetFile {
	name: string;
	url: string;
	type: "video" | "audio" | "image" | "other";
}

export interface ArtifactsView {
	script: ScriptDoc | null;
	bible: VisualBible | null;
	prompts: ShotPromptDoc | null;
	design?: DesignBibleDoc;
	keyframes?: KeyframesDoc;
	cuts?: CutsView;
	assets: AssetFile[];
}

export interface UploadedImage {
	id: string;
	name: string;
	url: string;
}

// ---- BGM / 转场 ----

/** run 内当前 BGM（assets/bgm.<ext>；null = 未上传） */
export interface BgmInfo {
	name: string;
	url: string;
}

export type TransitionType = "cut" | "fade" | "dip" | "white" | "wipeleft" | "slideup";

export const TRANSITION_LABEL: Record<TransitionType, string> = {
	cut: "硬切",
	fade: "叠化",
	dip: "黑场过渡",
	white: "白闪",
	wipeleft: "左擦除",
	slideup: "上滑",
};

export type SfxType = "whoosh" | "impact" | "riser";

export const SFX_LABEL: Record<SfxType, string> = {
	whoosh: "嗖声",
	impact: "低频冲击",
	riser: "上升音",
};

/** 重新导出支持的画幅 */
export type ExportAspectRatio = "16:9" | "9:16" | "1:1" | "4:3";

/** 剪辑师的转场决策表（transitions.json；旧 run 可能缺失） */
export interface TransitionsView {
	transitions: { afterShotIndex: number; type: TransitionType; durationSec: number; sfxType?: SfxType | null }[];
	/** 各镜头成片时长（秒），用于时间轴按比例可视化 */
	shotDur: number[];
	generatedAt: string;
}

// ---- 组合出片（版本并列 + 勾选装配交付版） ----

export interface ShotVersionItem {
	file: string;
	url: string;
	label: string;
}

export interface ShotVersionInfo {
	shotId: string;
	video: ShotVersionItem[];
	audio: ShotVersionItem[];
}

export interface VersionsView {
	shots: ShotVersionInfo[];
	/** 剩余组合出片次数 */
	remaining: number;
}

/** cuts.json：组合出片台账 */
export interface CutsView {
	used: number;
	renders: {
		file: string;
		at: string;
		selections: Record<string, { video: string | null; audio: string | null }>;
	}[];
}

// ---- 审议优化（候选对比 + 导演归因循环） ----

/** 候选成片（compose 产物或其 L1 节奏变体） */
export interface CutVariant {
	id: string;
	label: string;
	/** run 内相对路径（assets/...） */
	file: string;
	/** 播放 URL（服务端组装；旧 run / 老接口可能缺失，UI 需兜底） */
	url?: string;
	durationSec: number;
	origin: "compose" | "explore";
	baseId?: string;
	speed?: number;
	createdAt: string;
}

/** L1 节奏变体预设（与服务端 PACE_PRESETS 对齐） */
export interface PacePreset {
	id: string;
	label: string;
	speed: number;
}

export interface CutVariantsView {
	variants: CutVariant[];
	presets: PacePreset[];
}

export type DeliberationLayer = "edit" | "asset" | "prompt" | "audio";

export const DELIBERATION_LAYER_LABEL: Record<DeliberationLayer, string> = {
	edit: "剪辑",
	asset: "素材",
	prompt: "提示词",
	audio: "音频",
};

export type DeliberationAction = "reedit" | "reshot" | "retts" | "rescript";

export const DELIBERATION_ACTION_LABEL: Record<DeliberationAction, string> = {
	reedit: "重剪辑",
	reshot: "重做镜头",
	retts: "重录旁白",
	rescript: "脚本级重跑",
};

export interface DeliberationFinding {
	claim: string;
	layer: DeliberationLayer;
	evidence: string;
}

export interface DeliberationProposal {
	action: DeliberationAction;
	target: string;
	shotId?: string;
	reason: string;
	estimatedCost: string;
	/** P2：结构化成本（金额 + 货币 + 注解） */
	cost?: { amount: number; currency: "CNY" | "USD"; note: string };
	speed?: number;
	/** retts 专用：目标音色 id */
	voice?: string;
	/** P2+闸门 2：导演 agent 自我评估的置信度。
	 *  high = 证据直接+修复明确；medium = 证据间接或成本较高；low = 证据弱或路径不确定 */
	confidence: "high" | "medium" | "low";
}

export interface DeliberationDoc {
	rootCause: string;
	findings: DeliberationFinding[];
	proposals: DeliberationProposal[];
}

export interface DeliberationRound {
	id: string;
	at: string;
	baseVariantId: string;
	/** 对比候选（单版诊断模式无此字段） */
	challengerVariantId?: string;
	verdict: "base" | "challenger" | "neither";
	tags: string[];
	note?: string;
	doc: DeliberationDoc | null;
	error?: string;
	/** 用户采纳的提案（执行后回写） */
	adopted?: { action: string; target: string; at: string };
}

/** 跨镜一致性预检结果（与 server consistency.ts 的 ConsistencyDoc 对齐） */
export interface ConsistencyIssue {
	shotId: string;
	/** 该镜角色外观/画风摘要（服装颜色与类型、发型、色调质感） */
	appearance: string;
	/** 与前后镜的具体差异（无问题则为空数组） */
	issues: string[];
}

export interface ConsistencyDoc {
	checkedAt: string;
	model: string;
	/** 一句话总体一致性评价 */
	overall: string;
	shots: ConsistencyIssue[];
}

/** 用户反馈预设标签（审议发起时引导点选） */
export const DELIBERATION_TAGS = ["节奏", "画面", "旁白", "整体感觉"] as const;

// ---- 访谈题目视图（中文文案已展开） ----

export interface QuestionView {
	id: string;
	category: string;
	text: string;
	options: { id: string; label: string; hint: string }[];
	weight: "core" | "refinement" | "tailored";
}

// ---- 共创模式 ----

export interface CoCharacter {
	name: string;
	description: string;
	/** 台词模式音色绑定（StepFun voice id）：角色音色跨镜头稳定，重录后不漂移 */
	voiceId?: string;
}

export interface CoScene {
	name: string;
	description: string;
}

/** 共创空间（客户端持有，启动制作时随简报提交） */
export interface CoSpaceDraft {
	characters: CoCharacter[];
	scenes: CoScene[];
	ideas: string[];
	musicBrief?: string;
}

// ---- B2 只读制片主任（observe_kitchen → 建议；B2 阶段绝不自动执行） ----

export type SuggestionType = "submit" | "defer" | "downgrade" | "escalate" | "signal" | "wait";

/** 烤炉（配额池投影；字段与服务端 kitchen.ts KitchenOven 对齐） */
export interface KitchenOven {
	id: string;
	keyType: "free" | "enterprise" | "tokenplan" | string;
	/** 绑定的媒体适配器 ID（多 key：池↔key 对应关系；未绑定的单池缺省） */
	adapterId?: string;
	/** 当前可用 RPM 令牌 */
	tokens: number;
	/** 令牌桶容量（= 每分钟最大提交数；令牌点渲染的分母） */
	rpmCap: number;
	/** 距下一个令牌可用的毫秒数（0 = 现在就能提交） */
	rpmWaitMs: number;
	/** 今日剩余秒数（null = 限时免费/无明确配额，只受 RPM 约束） */
	remainingQuotaSec: number | null;
	/** 在途预留总秒数 */
	reservedSec: number;
	/** 在途预留条数（在烤） */
	inFlight: number;
	/** 累计超支秒数 */
	overrunSec: number;
}

export interface ProducerSuggestion {
	id: string;
	type: SuggestionType;
	taskId?: string;
	ovenId?: string;
	/** downgrade 目标秒数 */
	targetSeconds?: number;
	/** defer 推迟毫秒 */
	deferMs?: number;
	message: string;
	reason: string;
}

export interface KitchenObservation {
	id: string;
	runId: string;
	at: string;
	snapshot: {
		generatedAt: number;
		ovens: KitchenOven[];
		readyTasks: { id: string; outputName: string; seconds: number | null; retryCount: number }[];
		inFlightTasks: { id: string; outputName: string }[];
		recentFailures: { id: string; outputName: string; reason: string }[];
		budget: { remainingSec: number | null; reservedSec: number; overrunSec: number; day: string };
	};
	suggestions: ProducerSuggestion[];
	reasoning: string;
	feedback?: Array<{ id: string; decision: "adopted" | "dismissed"; at: string }>;
	/** B3：经 L2 守卫的执行留痕 */
	executions?: Array<{ id: string; type: SuggestionType; taskId?: string; status: "applied" | "rejected"; detail: string; at: string }>;
}

export interface KitchenSummary {
	observations: KitchenObservation[];
	stats: {
		total: number;
		adopted: number;
		dismissed: number;
		adoptionRate: number | null;
		applied: number;
		rejected: number;
		rejectionRate: number | null;
	};
}

// ---- B4 导演契约：优先级指令 ↔ 预算告警双向闭环 ----

export interface BudgetAlert {
	type: "budget_alert";
	message: string;
	suggestion: string;
	remainingSec: number;
	requiredSec: number;
	shortfallSec: number;
	affectedShots: string[];
	at: number;
}

export interface PriorityInstruction {
	shotId: string;
	priority: "P0" | "P1" | "P2";
	qualityBar: "must_keep" | "nice_to_have" | "sacrificable";
	maxRetries: number;
}

// ---- B5 A/B 度量 ----

export interface RunMetrics {
	quotaUtilization: number | null;
	effectiveThroughput: number | null;
	p0LatencyP95: number | null;
	wasteRate: number | null;
	rejectionRate: number | null;
	consumedSec: number;
	effectiveSec: number;
	wastedSec: number;
	completedClips: number;
	failedClips: number;
}

// ---- HTTP 助手 ----

async function postJson<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		let detail = `HTTP ${response.status}`;
		try {
			const data = (await response.json()) as { error?: string };
			if (data?.error) detail = data.error;
		} catch {
			// 保留默认错误文案
		}
		throw new Error(detail);
	}
	return (await response.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) {
		let detail = `HTTP ${response.status}`;
		try {
			const data = (await response.json()) as { error?: string };
			if (data?.error) detail = data.error;
		} catch {
			// 保留默认错误文案
		}
		throw new Error(detail);
	}
	return (await response.json()) as T;
}

async function deleteJson(path: string): Promise<void> {
	const response = await fetch(path, { method: "DELETE" });
	if (!response.ok) {
		let detail = `HTTP ${response.status}`;
		try {
			const data = (await response.json()) as { error?: string };
			if (data?.error) detail = data.error;
		} catch {
			// 保留默认错误文案
		}
		throw new Error(detail);
	}
}

/** live 实现：所有请求走 Vite 代理到 :8788 */
export const api = {
	async startInterview(brief: BriefInput): Promise<void> {
		await postJson("/api/clarify/start", { brief });
	},
	async currentQuestion(): Promise<{ question: QuestionView | null; pending: boolean }> {
		return postJson<{ question: QuestionView | null; pending: boolean }>("/api/clarify/next", { locale: "zh" });
	},
	async answerQuestion(answerId: string): Promise<{
		done: boolean;
		pending?: boolean;
		question: QuestionView | null;
		answeredCount: number;
		askedCount: number;
		total: number;
	}> {
		return postJson("/api/clarify/answer", { answerId, locale: "zh" });
	},
	/** 跳过当前这一题（不记录答案，访谈继续） */
	async skipQuestion(): Promise<{
		done: boolean;
		pending?: boolean;
		question: QuestionView | null;
		answeredCount: number;
		askedCount: number;
		total: number;
	}> {
		return postJson("/api/clarify/skip-question", { locale: "zh" });
	},
	async skipInterview(): Promise<void> {
		await postJson("/api/clarify/skip", {});
	},
	async uploadImage(name: string, dataUrl: string): Promise<UploadedImage> {
		return postJson("/api/uploads", { name, dataUrl });
	},
	async generate(
		brief: BriefInput,
		options: GenerationOptions,
		imageIds: string[],
		coSpace?: CoSpaceDraft,
	): Promise<{ runId: string }> {
		return postJson("/api/generate", { brief, options, imageIds, ...(coSpace ? { coSpace } : {}) });
	},
	/** P2：调用前的成本预估（不创建 run）。*/
	async estimateCost(
		options: GenerationOptions,
		coSpace?: CoSpaceDraft,
	): Promise<CostEstimateView> {
		return postJson("/api/pricing/estimate", {
			options,
			...(coSpace ? { coSpace } : {}),
		});
	},
	async pollRun(runId: string): Promise<RunView> {
		return getJson(`/api/runs/${encodeURIComponent(runId)}`);
	},
	streamRun(runId: string, handlers: RunStreamHandlers): () => void {
		if (typeof EventSource === "undefined") {
			handlers.onError?.();
			return () => {};
		}
		const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
		source.addEventListener("open", () => handlers.onOpen?.());
		source.addEventListener("error", () => handlers.onError?.());
		source.addEventListener("run", (event) => {
			try {
				handlers.onRun(JSON.parse((event as MessageEvent<string>).data) as RunView);
			} catch {
				handlers.onError?.();
			}
		});
		// 事件级增量通道（ndjson 化后团队事件只走这条，不再为每条消息重发完整快照）
		source.addEventListener("ev", (event) => {
			try {
				handlers.onEvent?.(JSON.parse((event as MessageEvent<string>).data) as TeamEvent);
			} catch {
				// 单条事件解析失败不影响快照通道
			}
		});
		return () => source.close();
	},
	async listRuns(limit = 50): Promise<RunSummary[]> {
		const data = await getJson<{ runs: RunSummary[] }>(`/api/runs?limit=${limit}`);
		return data.runs;
	},
	async fetchArtifacts(runId: string): Promise<ArtifactsView> {
		return getJson(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
	},
	async chat(runId: string, text: string): Promise<TeamEvent> {
		const data = await postJson<{ event: TeamEvent }>(`/api/runs/${encodeURIComponent(runId)}/chat`, { text });
		return data.event;
	},
	async refine(runId: string, stageId: StageId, instruction: string, autoResume = false): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/refine`, { stageId, instruction, autoResume });
	},
	async resume(runId: string, confirmedShotIds?: string[]): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/resume`, {
			...(confirmedShotIds ? { confirmedShotIds } : {}),
		});
	},
	async reshot(runId: string, shotId: string, instruction: string): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/reshot`, { shotId, instruction });
	},
	async retts(runId: string, shotId: string, instruction: string, voice?: string): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/retts`, {
			shotId,
			instruction,
			...(voice ? { voice } : {}),
		});
	},
	/** 设计图单卡调整重绘（美术设计） */
	async designAdjust(runId: string, entityId: string, instruction: string): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/design/adjust`, { entityId, instruction });
	},
	/** 设计出图审核（同步，约 10-30s；结论写回 design-bible.json，随 artifacts 透出） */
	async designReview(
		runId: string,
		entityIds?: string[],
	): Promise<{ ok: true; reviewed: (DesignReview & { id: string; name: string })[] }> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/design/review`, { entityIds });
	},
	/** 分镜关键帧单镜重绘 */
	async keyframeAdjust(runId: string, shotId: string, instruction: string): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/keyframes/adjust`, { shotId, instruction });
	},
	/** 每镜视频/音频版本清单（组合出片剪辑台用） */
	async fetchShotVersions(runId: string): Promise<VersionsView> {
		return getJson(`/api/runs/${encodeURIComponent(runId)}/versions`);
	},
	/** 按勾选版本装配交付版（限次；400 = 配额用尽或选择非法） */
	async composeCut(
		runId: string,
		selections: Record<string, { video?: string; audio?: string }>,
	): Promise<{ ok: true; remaining: number }> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/compose`, { selections });
	},
	// ---- 审议优化 ----
	/** 候选清单（首次调用会登记历史 compose 产物与主成片） */
	async fetchCutVariants(runId: string): Promise<CutVariantsView> {
		return getJson(`/api/runs/${encodeURIComponent(runId)}/cutvariants`);
	},
	/** 生成 L1 节奏变体（本地 ffmpeg，零模型成本） */
	async createPaceVariant(runId: string, baseId: string, speed: number): Promise<{ ok: true }> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/cutvariants`, { baseId, speed });
	},
	/** 审议历史 */
	async fetchDeliberations(runId: string): Promise<{ rounds: DeliberationRound[] }> {
		return getJson(`/api/runs/${encodeURIComponent(runId)}/deliberations`);
	},
	/** 发起一轮审议（challengerId 可空 = 单版诊断模式；同步等待导演归因循环，约 1-3 分钟） */
	async startDeliberation(
		runId: string,
		input: {
			baseId: string;
			challengerId?: string;
			verdict: "base" | "challenger" | "neither";
			tags: string[];
			note?: string;
		},
	): Promise<{ ok: true; round: DeliberationRound }> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/deliberations`, input);
	},
	/** 回写提案采纳记录（下一轮审议据此避免重复建议） */
	async markAdopted(runId: string, roundId: string, action: string, target: string): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/deliberations/${encodeURIComponent(roundId)}/adopt`, {
			action,
			target,
		});
	},
	/** 跨镜一致性预检（同步，约 15-40s） */
	async checkConsistency(runId: string): Promise<ConsistencyDoc> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/consistency`, {});
	},
	/** 跨镜一致性结果（未检查过为 null） */
	async fetchConsistency(runId: string): Promise<ConsistencyDoc | null> {
		return getJson<ConsistencyDoc | null>(`/api/runs/${encodeURIComponent(runId)}/consistency`);
	},
	/** 可用旁白音色表（label → voice-id） */
	async fetchVoices(): Promise<Record<string, string>> {
		const data = await getJson<{ voices: Record<string, string> }>("/api/voices");
		return data.voices;
	},
	/** B2：制片主任观察一轮厨房（observe → 建议，不自动执行） */
	async kitchenObserve(runId: string): Promise<KitchenObservation> {
		const data = await postJson<{ observation: KitchenObservation }>(`/api/runs/${encodeURIComponent(runId)}/kitchen/observe`, {});
		return data.observation;
	},
	/** B2：厨房观察列表 + 采纳率 */
	async kitchenFetch(runId: string): Promise<KitchenSummary> {
		return getJson<KitchenSummary>(`/api/runs/${encodeURIComponent(runId)}/kitchen`);
	},
	/** 轻量厨房快照（无 LLM/无落盘）：烤炉条 5s 轮询令牌呼吸用 */
	async kitchenSnapshot(runId: string): Promise<{ generatedAt: number; ovens: KitchenOven[] }> {
		return getJson<{ generatedAt: number; ovens: KitchenOven[] }>(`/api/runs/${encodeURIComponent(runId)}/kitchen/snapshot`);
	},
	/** B2：对建议表态（B2 只记录，不触发执行） */
	async kitchenFeedback(runId: string, obsId: string, suggestionId: string, decision: "adopted" | "dismissed"): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/kitchen/feedback`, { obsId, suggestionId, decision });
	},
	/** B3：应用建议（L2 守卫校验后执行 defer/downgrade/播报；被拒也留痕） */
	async kitchenApply(runId: string, obsId: string, suggestionId: string): Promise<{ ok: true; verdict: { ok: boolean; reason?: string; detail?: string } }> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/kitchen/apply`, { obsId, suggestionId });
	},
	// ---- B4 导演契约 ----
	/** B4：制片主任 → 导演的预算告警列表 */
	async fetchBudgetAlerts(runId: string): Promise<BudgetAlert[]> {
		const data = await getJson<{ alerts: BudgetAlert[] }>(`/api/runs/${encodeURIComponent(runId)}/budget-alerts`);
		return data.alerts;
	},
	/** B4：导演 → 制片主任的优先级指令（P0/P1/P2 + 质量底线） */
	async submitPriorityInstruction(runId: string, instruction: { shotId: string; priority: string; qualityBar: string; maxRetries?: number }): Promise<{ ok: boolean; detail: string }> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/director/priority`, instruction);
	},
	/** B4 读路径：每镜最新一条优先级指令（ndjson 追加式，同镜取最后） */
	async fetchPriorityInstructions(runId: string): Promise<PriorityInstruction[]> {
		const data = await getJson<{
			instructions: Array<{ shotId: string; priority: string; qualityBar: string; maxRetries: number }>;
		}>(`/api/runs/${encodeURIComponent(runId)}/director/priority`);
		const latest = new Map<string, PriorityInstruction>();
		for (const inst of data.instructions) {
			if (inst.priority === "P0" || inst.priority === "P1" || inst.priority === "P2") {
				latest.set(inst.shotId, {
					shotId: inst.shotId,
					priority: inst.priority,
					qualityBar:
						inst.qualityBar === "must_keep" || inst.qualityBar === "nice_to_have" || inst.qualityBar === "sacrificable"
							? inst.qualityBar
							: "nice_to_have",
					maxRetries: inst.maxRetries,
				});
			}
		}
		return [...latest.values()];
	},
	// ---- B5 A/B 度量 ----
	/** B5：运行度量（配额利用率/有效吞吐/P0延迟P95/浪费率/被拒率） */
	async fetchRunMetrics(runId: string): Promise<RunMetrics> {
		return getJson<RunMetrics>(`/api/runs/${encodeURIComponent(runId)}/metrics`);
	},
	/** 共创模式：创意合伙人一轮对话（context 为从首页带入的创作基底，并入 system prompt） */
	async cocreateChat(messages: { role: "user" | "assistant"; content: string }[], context?: string): Promise<string> {
		const data = await postJson<{ reply: string }>("/api/cocreate/chat", {
			messages,
			...(context ? { context } : {}),
		});
		return data.reply;
	},
	/** 共创模式：从对话提炼共创空间条目 */
	async cocreateExtract(transcript: string): Promise<CoSpaceDraft | null> {
		const data = await postJson<{ space: CoSpaceDraft | null }>("/api/cocreate/extract", { transcript });
		return data.space;
	},
	async fetchTraces(runId: string): Promise<TraceSpan[]> {
		const data = await getJson<{ spans: TraceSpan[] }>(`/api/runs/${encodeURIComponent(runId)}/traces`);
		return data.spans;
	},
	async fetchBgm(runId: string): Promise<BgmInfo | null> {
		return getJson<BgmInfo | null>(`/api/runs/${encodeURIComponent(runId)}/bgm`);
	},
	async uploadBgm(runId: string, name: string, dataUrl: string): Promise<BgmInfo> {
		return postJson(`/api/runs/${encodeURIComponent(runId)}/bgm`, { name, dataUrl });
	},
	async deleteBgm(runId: string): Promise<void> {
		await deleteJson(`/api/runs/${encodeURIComponent(runId)}/bgm`);
	},
	async reexport(runId: string, aspectRatio?: ExportAspectRatio): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/reexport`, aspectRatio ? { aspectRatio } : {});
	},
	async fetchTransitions(runId: string): Promise<TransitionsView | null> {
		return getJson<TransitionsView | null>(`/api/runs/${encodeURIComponent(runId)}/transitions`);
	},
	async cancelRun(runId: string): Promise<void> {
		await postJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
	},
	downloadUrl(runId: string): string {
		return `/api/runs/${encodeURIComponent(runId)}/download`;
	},
	videoUrl(runId: string): string {
		return `/api/runs/${encodeURIComponent(runId)}/video`;
	},
};
