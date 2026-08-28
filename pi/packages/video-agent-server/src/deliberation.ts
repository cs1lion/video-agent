/**
 * 审议优化（Deliberate）：用户发起的成片对比审议 + 导演自主 ReAct 归因循环。
 *
 * 数据模型（全部落盘在 run 目录，服务重启可恢复）：
 *   cut-variants.json   候选成片台账（compose 产物 + L1 节奏变体）
 *   deliberations.json  审议轮次（含导演 DeliberationDoc）
 *   preferences.jsonl   用户偏好记录（成对选择，追加写；DPO 数据集原料）
 *
 * 边界与护栏：
 *   - 循环内工具全部只读（看数据/看帧），唯一有写语义的是 propose（终结工具）；
 *     一切花钱的动作（reshot/retts/重剪辑）都在循环外由用户批准后走既有端点。
 *   - 轮次上限 MAX_DELIB_PER_RUN=3；候选上限 MAX_CUT_VARIANTS=4；
 *     看帧预算每轮 4 次；LLM 轮次上限 DELIB_MAX_TURNS=12。
 *   - LLM 429/5xx 自动退避重试（streamWithRetry）。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentContext,
	type AgentTool,
	type AgentToolResult,
	runAgentLoop,
	runAgentLoopContinue,
} from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import * as piai from "@earendil-works/pi-ai/compat";
import type { LlmConfig } from "./config.ts";
import { getConsistency } from "./consistency.ts";
import { probeDuration, runFfmpeg } from "./ffmpeg.ts";
import { estimateProposalCost } from "./pricing.ts";
import {
	type ActionRecord,
	type QaVerdict,
	type RunRecord,
	LAST_ACTION_DEDUP_MS,
	readArtifact,
	writeJson,
} from "./pipeline.ts";
import type { ShotPromptDoc } from "./prompts.ts";

// ---- 常量 ----

export const MAX_DELIB_PER_RUN = 3;
export const MAX_CUT_VARIANTS = 4;
const DELIB_MAX_TURNS = 12;
const FRAME_BUDGET_PER_ROUND = 4;

/** L1 节奏变体预设（对整条 cut 等比变速；镜头素材与转场不变） */
export const PACE_PRESETS = [
	{ id: "fast", label: "快节奏", speed: 1.18 },
	{ id: "slow", label: "慢节奏", speed: 0.92 },
] as const;

export type AttributionLayer = "edit" | "asset" | "prompt" | "audio";

export const LAYER_LABEL: Record<AttributionLayer, string> = {
	edit: "剪辑",
	asset: "素材",
	prompt: "提示词",
	audio: "音频",
};

export type ProposalAction = "reedit" | "reshot" | "retts" | "rescript";

// ---- 数据结构 ----

/** 候选成片（compose 产物或其 L1 节奏变体） */
export interface CutVariant {
	id: string;
	label: string;
	/** run 内相对路径（assets/...） */
	file: string;
	durationSec: number;
	origin: "compose" | "explore";
	/** 派生变体的基准候选 id */
	baseId?: string;
	/** 派生变体的播放速度倍率（1 = 原速） */
	speed?: number;
	createdAt: string;
}

export interface CutVariantsDoc {
	variants: CutVariant[];
}

export interface DeliberationFinding {
	claim: string;
	layer: AttributionLayer;
	/** 引用工具返回的具体事实（数值 / 帧内容描述） */
	evidence: string;
}

export interface DeliberationProposal {
	action: ProposalAction;
	/** 动作对象：镜头 id（reshot/retts）或范围描述（reedit/rescript） */
	target: string;
	/** reshot/retts 时的目标镜头（可执行的关键） */
	shotId?: string;
	reason: string;
	/** LLM 给出的成本说明（自然语言，如「仅剪辑渲染」）
	 *  本字段与下面结构化的 cost 并存，前者补充语义，后者可供 UI 直接展示金额。 */
	estimatedCost: string;
	/** P2：结构化成本（服务端从 action + run options  推导，供 UI  直接展示金额） */
	cost?: { amount: number; currency: "CNY" | "USD"; note: string };
	/** reedit 专用：整片播放速度倍率（0.9-1.3，1 = 不变速） */
	speed?: number;
	/** P2+阅门 2：导演 agent 自我评估的置信度。供 UI 透明化决策可信度。
	 *  high: 证据直接 + 修复方案明确（如 reedit 调速 + 仅剪辑师）
	 *  medium: 证据间接 或修复成本较高
	 *  low: 证据弱、修复路径不确定、或本身为推断 */
	confidence: "high" | "medium" | "low";
}

export interface DeliberationDoc {
	rootCause: string;
	findings: DeliberationFinding[];
	proposals: DeliberationProposal[];
}

/** 一轮审议 = 一次用户发起的对比 + 导演归因 */
export interface DeliberationRound {
	id: string;
	at: string;
	baseVariantId: string;
	/** 对比候选（单版诊断模式无此字段） */
	challengerVariantId?: string;
	/** 用户对比后的选择：base=保留 A，challenger=换成 B，neither=都不满意 */
	verdict: "base" | "challenger" | "neither";
	/** 用户反馈预设标签（节奏/画面/旁白/整体） */
	tags: string[];
	/** 用户补充说明（可空） */
	note?: string;
	/** 导演归因（循环未产出时为 null） */
	doc: DeliberationDoc | null;
	/** 归因失败原因（doc 为 null 时存在） */
	error?: string;
	/** 用户采纳的提案（执行后回写；下一轮审议据此避免重复建议） */
	adopted?: { action: string; target: string; at: string };
}

export interface DeliberationsDoc {
	rounds: DeliberationRound[];
}

/** 用户偏好记录（preferences.jsonl 每行一条；成对选择的完整上下文快照） */
export interface PreferenceRecord {
	at: string;
	runId: string;
	roundId: string;
	baseVariantId: string;
	/** 对比候选（单版诊断模式无此字段） */
	challengerVariantId?: string;
	chosen: "base" | "challenger" | "neither";
	tags: string[];
	note?: string;
	/** 选择时的差异上下文（时长/速度等，供日后归因） */
	deltaContext: Record<string, unknown>;
}

// ---- 候选成片台账 ----

const FALLBACK_DURATION = 0;

/** 读取候选台账；首次调用时把 cuts.json 的历史 compose 产物登记进来 */
export async function listCutVariants(run: RunRecord): Promise<CutVariant[]> {
	let doc: CutVariantsDoc | null = null;
	try {
		const raw = await readArtifact<CutVariantsDoc>(run, "cut-variants.json");
		if (raw && Array.isArray(raw.variants)) doc = { variants: raw.variants };
	} catch {
		// 尚未登记
	}
	const variants = doc?.variants ?? [];
	const dirty = variants.length === 0;
	if (dirty) {
		try {
			const cuts = await readArtifact<{ renders: { file: string }[] }>(run, "cuts.json");
			for (const render of cuts.renders ?? []) {
				const duration = (await probeDuration(render.file, run.dir)) ?? FALLBACK_DURATION;
				variants.push({
					id: `cv-${randomUUID().slice(0, 8)}`,
					label: `交付版 ${path.basename(render.file)}`,
					file: render.file,
					durationSec: duration,
					origin: "compose",
					createdAt: new Date().toISOString(),
				});
			}
		} catch {
			// 无 compose 产物
		}
	}
	// 主成片兜底（旧 run 无 cuts.json 也能审议）
	if (
		!variants.some((v) => path.basename(v.file) === "final.mp4") &&
		fs.existsSync(path.join(run.dir, "assets", "final.mp4"))
	) {
		const duration = (await probeDuration("assets/final.mp4", run.dir)) ?? FALLBACK_DURATION;
		variants.unshift({
			id: `cv-${randomUUID().slice(0, 8)}`,
			label: "主成片 final",
			file: "assets/final.mp4",
			durationSec: duration,
			origin: "compose",
			createdAt: new Date().toISOString(),
		});
	}
	if (dirty && variants.length > 0) {
		await writeJson(run, "cut-variants.json", { variants } satisfies CutVariantsDoc);
	}
	return variants;
}

async function saveVariants(run: RunRecord, variants: CutVariant[]): Promise<void> {
	await writeJson(run, "cut-variants.json", { variants } satisfies CutVariantsDoc);
}

export function variantById(variants: CutVariant[], id: string): CutVariant | undefined {
	return variants.find((v) => v.id === id);
}

/**
 * L1 节奏变体：对基准候选整片等比变速（画面 setpts + 音频 atempo）。
 * 不调用任何付费模型；镜头素材、顺序、转场类型均不变。
 */
export async function createPaceVariant(
	run: RunRecord,
	base: CutVariant,
	speed: number,
): Promise<{ ok: true; variant: CutVariant } | { ok: false; error: string }> {
	if (!Number.isFinite(speed) || speed < 0.85 || speed > 1.35 || Math.abs(speed - 1) < 0.03) {
		return { ok: false, error: "速度倍率需在 0.85-1.35 且不等于 1" };
	}
	const variants = await listCutVariants(run);
	if (variants.length >= MAX_CUT_VARIANTS) {
		return { ok: false, error: `候选上限 ${MAX_CUT_VARIANTS} 个，请先清理旧候选` };
	}
	if (!fs.existsSync(path.join(run.dir, base.file))) {
		return { ok: false, error: `基准候选文件不存在: ${base.file}` };
	}
	const seq = variants.length + 1;
	const outRel = path.join("assets", `cutvar-${seq}.mp4`);
	const preset = PACE_PRESETS.find((p) => Math.abs(p.speed - speed) < 0.001);
	const label = preset ? `${preset.label} ${speed.toFixed(2)}x` : `${speed.toFixed(2)}x 节奏`;
	await runFfmpeg(
		[
			"-y",
			"-i",
			base.file,
			"-filter_complex",
			`[0:v]setpts=PTS/${speed}[v];[0:a]atempo=${speed}[a]`,
			"-map",
			"[v]",
			"-map",
			"[a]",
			outRel,
		],
		run.dir,
		run.abort.signal,
	);
	const duration = (await probeDuration(outRel, run.dir)) ?? FALLBACK_DURATION;
	const variant: CutVariant = {
		id: `cv-${randomUUID().slice(0, 8)}`,
		label: `${label}（基于 ${base.label}）`,
		file: outRel,
		durationSec: duration,
		origin: "explore",
		baseId: base.id,
		speed,
		createdAt: new Date().toISOString(),
	};
	await saveVariants(run, [...variants, variant]);
	return { ok: true, variant };
}

// ---- 审议循环 ----

interface DeliberateInput {
	baseId: string;
	/** 对比候选（可空 = 单版诊断模式：用户直接对当前成片提绝对意见，不做 A/B 比较） */
	challengerId?: string;
	verdict: "base" | "challenger" | "neither";
	tags: string[];
	note?: string;
}

function stepfunModel(llm: LlmConfig): Model<"openai-completions"> {
	return {
		id: llm.model,
		name: `${llm.model} (video-agent deliberation)`,
		api: "openai-completions",
		provider: "video-agent",
		baseUrl: llm.url.replace(/\/chat\/completions\/?$/, ""),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 8192,
	};
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("已中止"));
			},
			{ once: true },
		);
	});

/** AgentTool 的参数类型推断助手（AgentTool 默认泛型会把 execute 参数退化成 unknown） */
function defineTool<T extends TSchema>(
	def: { name: string; label: string; description: string; parameters: T },
	execute: (toolCallId: string, params: Static<T>) => Promise<AgentToolResult<unknown>>,
): AgentTool<T> {
	return { ...def, execute };
}

/** LLM 流式调用 + 429/5xx 退避重试（缓冲重放：错误在流消费期才暴露） */
function streamWithRetry(
	model: Model<"openai-completions">,
	context: piai.Context,
	options?: piai.SimpleStreamOptions,
): Promise<piai.AssistantMessageEventStream> {
	return (async () => {
		for (let attempt = 0; ; attempt++) {
			const stream = piai.streamSimple(model, context, options);
			const events: piai.AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const message = await stream.result();
			if (message.stopReason === "error") {
				console.warn(`[deliberation] LLM error: ${message.errorMessage}`);
			}
			const retryable = message.stopReason === "error" && /429|rate|500|502|503/i.test(message.errorMessage ?? "");
			if (retryable && attempt < 3) {
				// 退避必须可中止：否则用户取消审议后进程还会在 sleep 里干等最长 60s
				await sleep(20_000 * (attempt + 1), options?.signal ?? undefined);
				continue;
			}
			const out = piai.createAssistantMessageEventStream();
			for (const event of events) out.push(event);
			return out;
		}
	})();
}

function deltaContextOf(base: CutVariant, challenger: CutVariant | null): Record<string, unknown> {
	return {
		baseDurationSec: base.durationSec,
		challengerDurationSec: challenger?.durationSec ?? null,
		speedRatio:
			challenger && base.durationSec > 0 ? Number((challenger.durationSec / base.durationSec).toFixed(3)) : null,
		baseOrigin: base.origin,
		challengerOrigin: challenger?.origin ?? null,
		challengerSpeed: challenger?.speed ?? 1,
	};
}

/** 用户偏好落盘（preferences.jsonl 追加一行；写坏不阻塞审议） */
async function appendPreference(run: RunRecord, record: PreferenceRecord): Promise<void> {
	try {
		await fs.promises.appendFile(path.join(run.dir, "preferences.jsonl"), `${JSON.stringify(record)}\n`, "utf-8");
	} catch {
		// 偏好落盘失败不阻塞审议主流程
	}
}

/** 审议循环工具集（全部只读，propose 为唯一终结出口）；getProposal 供循环结束后取回结论 */
function buildTools(
	run: RunRecord,
	base: CutVariant,
	challenger: CutVariant | null,
	priceCatalog: import("./pricing.ts").PriceCatalog,
): { tools: AgentTool[]; getProposal: () => DeliberationDoc | null } {
	const comparisonTool = defineTool(
		{
			name: "get_cut_comparison",
			label: "获取成片信息与差异",
			description: "获取候选 A（用户选中版）与候选 B（若有）的信息与差异清单。必须最先调用此工具建立事实基础。",
			parameters: Type.Object({}),
		},
		async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							candidateA: {
								id: base.id,
								label: base.label,
								file: path.basename(base.file),
								durationSec: base.durationSec,
							},
							...(challenger
								? {
										candidateB: {
											id: challenger.id,
											label: challenger.label,
											file: path.basename(challenger.file),
											durationSec: challenger.durationSec,
										},
										deltas: [
											{
												layer: "edit",
												field: "total_duration",
												a: `${base.durationSec.toFixed(1)}s`,
												b: `${challenger.durationSec.toFixed(1)}s`,
											},
											{
												layer: "edit",
												field: "playback_speed",
												a: "1.0x",
												b: `${(challenger.speed ?? 1).toFixed(2)}x`,
											},
											{ layer: "asset", field: "shot_materials", a: "same clips", b: "same clips" },
										],
									}
								: {
										note: "本次审议无对比候选（单版诊断模式）：用户直接对当前成片提出修改意见，请围绕用户反馈取证",
									}),
						},
						null,
						1,
					),
				},
			],
			details: {},
		}),
	);

	const evidenceTool = defineTool(
		{
			name: "get_shot_evidence",
			label: "获取镜头证据",
			description: "获取指定镜头的 QA 裁决、全片五轴分数与该镜头的生成 prompt 摘要。",
			parameters: Type.Object({ shotId: Type.String({ description: "镜头 ID，如 SH01" }) }),
		},
		async (_id, params) => {
			let verdict: QaVerdict | undefined;
			let prompt = "";
			try {
				verdict = (await readArtifact<{ verdict?: QaVerdict }>(run, "run-state.json")).verdict;
			} catch {
				// 旧 run 无 verdict
			}
			try {
				const prompts = await readArtifact<ShotPromptDoc>(run, "prompts.json");
				prompt = prompts.prompts.find((p) => p.shotId === params.shotId)?.prompt ?? "";
			} catch {
				// 无 prompts 产物
			}
			if (!verdict) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ shotId: params.shotId, note: "本 run 无 QA 数据（旧 run）" }),
						},
					],
					details: {},
				};
			}
			const shot = verdict.shots?.find((s) => s.id === params.shotId);
			const consistency = await getConsistency(run);
			const consistencyIssue = consistency?.shots.find((s) => s.shotId === params.shotId) ?? null;
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								shotId: params.shotId,
								shotVerdict: shot ?? null,
								overallAxes: verdict.axes,
								overallScore: verdict.score,
								promptPreview: prompt.slice(0, 300),
								keyframeFile: `assets/key-${params.shotId}.png`,
								qaFrameFile: `assets/qa-${params.shotId}.jpg`,
								...(consistencyIssue
									? {
											consistency: {
												appearance: consistencyIssue.appearance,
												issues: consistencyIssue.issues,
												overall: consistency?.overall ?? "",
											},
										}
									: {}),
							},
							null,
							1,
						),
					},
				],
				details: {},
			};
		},
	);

	let frameBudget = FRAME_BUDGET_PER_ROUND;
	const frameTool = defineTool(
		{
			name: "view_shot_frames",
			label: "查看镜头帧",
			description: `查看指定镜头的关键帧与 QA 抽检帧（视觉输入）。每轮审议最多 ${FRAME_BUDGET_PER_ROUND} 次。`,
			parameters: Type.Object({ shotId: Type.String({ description: "镜头 ID" }) }),
		},
		async (_id, params) => {
			if (frameBudget <= 0) {
				return {
					content: [
						{
							type: "text",
							text: `错误: 看帧预算已用尽（每轮 ${FRAME_BUDGET_PER_ROUND} 次）。请基于已有证据得出结论。`,
						},
					],
					details: {},
				};
			}
			frameBudget -= 1;
			const images: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
				{ type: "text", text: `镜头 ${params.shotId} 的关键帧与 QA 抽检帧:` },
			];
			for (const [file, mime] of [
				[`assets/key-${params.shotId}.png`, "image/png"],
				[`assets/qa-${params.shotId}.jpg`, "image/jpeg"],
			] as const) {
				if (!fs.existsSync(path.join(run.dir, file))) continue;
				images.push({
					type: "image",
					data: fs.readFileSync(path.join(run.dir, file)).toString("base64"),
					mimeType: mime,
				});
			}
			if (images.length === 1) {
				return { content: [{ type: "text", text: `镜头 ${params.shotId} 无可用帧文件` }], details: {} };
			}
			return { content: images, details: { remainingFrameBudget: frameBudget } };
		},
	);

	const historyTool = defineTool(
		{
			name: "get_preferences",
			label: "获取历史审议记录",
			description: "获取本 run 的历史审议轮次（含被用户否决的方案）。首次审议时为空。",
			parameters: Type.Object({}),
		},
		async () => {
			try {
				const doc = await readArtifact<DeliberationsDoc>(run, "deliberations.json");
				const rounds = (doc.rounds ?? []).map((r) => ({
					round: r.id,
					verdict: r.verdict,
					tags: r.tags,
					note: r.note ?? "",
					rootCause: r.doc?.rootCause ?? "",
					proposals: r.doc?.proposals.map((p) => `${p.action} ${p.target}`) ?? [],
					...(r.adopted ? { adopted: `${r.adopted.action} ${r.adopted.target}` } : {}),
				}));
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ rounds, note: rounds.length > 0 ? "以上方案均未被采纳" : "首次审议" }),
						},
					],
					details: {},
				};
			} catch {
				return { content: [{ type: "text", text: JSON.stringify({ rounds: [], note: "首次审议" }) }], details: {} };
			}
		},
	);

	let proposal: DeliberationDoc | null = null;
	const proposeTool = defineTool(
		{
			name: "propose",
			label: "提交审议结论",
			description:
				"提交最终审议结论并结束审议。findings 每条必须带 evidence 引用工具返回的具体事实（数值或帧内容）。" +
				"proposals 最多 2 个，action 取值: reedit（改剪辑，成本最低，可带 speed 0.9-1.3）| reshot（重做某镜，需 shotId）| " +
				"retts（重录某镜旁白，需 shotId）| rescript（脚本级重跑，需用户二次确认）。" +
				"为每个提案评估 confidence（high/medium/low）：high=证据直接+修复明确（如 reedit 调速），medium=证据间接 或 成本高，low=证据弱 或 路径不确定。",
			parameters: Type.Object({
				rootCause: Type.String({ description: "一句话主因判断" }),
				findings: Type.Array(
					Type.Object({
						claim: Type.String(),
						layer: Type.Enum({ edit: "edit", asset: "asset", prompt: "prompt", audio: "audio" }),
						evidence: Type.String({ description: "工具返回的具体数据或帧内容" }),
					}),
				),
				proposals: Type.Array(
					Type.Object({
						action: Type.String(),
						target: Type.String(),
						shotId: Type.Optional(Type.String({ description: "reshot/retts 时的镜头 ID" })),
						reason: Type.String(),
						estimatedCost: Type.String(),
						speed: Type.Optional(Type.Number({ description: "reedit 专用: 0.9-1.3 播放速度倍率" })),
						confidence: Type.Enum({ high: "high", medium: "medium", low: "low" }),
					}),
					{ maxItems: 2 },
				),
			}),
		},
		async (_id, params) => {
			const actions = new Set<ProposalAction>(["reedit", "reshot", "retts", "rescript"]);
			const layers = new Set<AttributionLayer>(["edit", "asset", "prompt", "audio"]);
			// 合法镜头集合：以 script.json 为准。闸门 1 此前是 fail-open（find 不到就放行），
			// QA 降级（verdict.shots 缺失）或 LLM 幻觉出不存在的镜头号时护栏静默失效——
			// 未知即拒绝，而不是未知即放行。
			let validShotIds: Set<string> | null = null;
			try {
				const script = await readArtifact<{ shots: { id: string }[] }>(run, "script.json");
				validShotIds = new Set(script.shots.map((s) => s.id));
			} catch {
				// script 缺失（异常 run）：跳过存在性校验，仅保留下方 QA 底线检查
			}
			proposal = {
				rootCause: params.rootCause.slice(0, 300),
				findings: params.findings.slice(0, 6).map((f) => ({
					claim: f.claim.slice(0, 300),
					layer: layers.has(f.layer as AttributionLayer) ? (f.layer as AttributionLayer) : "edit",
					evidence: f.evidence.slice(0, 400),
				})),
				proposals: params.proposals.slice(0, 2).map((p) => {
					const action = actions.has(p.action as ProposalAction) ? (p.action as ProposalAction) : "reedit";
					// 闸门 1 质量底线：reshot/retts 必须指向真实存在的镜头，且 QA 评分为 ok 的镜头禁止重做
					if (action === "reshot" || action === "retts") {
						if (!p.shotId) {
							throw new Error(`${action} 提案缺少 shotId。请指定具体镜头（如 SH03）后重新提交。`);
						}
						if (validShotIds && !validShotIds.has(p.shotId)) {
							throw new Error(
								`镜头 ${p.shotId} 不存在（本片镜头：${[...validShotIds].join("、")}）。请核对镜头编号后重新提交。`,
							);
						}
						const target = run.verdict?.shots?.find((s) => s.id === p.shotId);
						if (target?.verdict === "ok") {
							throw new Error(
								`镜头 ${p.shotId} 质检评分 ok（${target.reason || "通过"}），无需重做。请寻找真正有问题（warn/fail）的镜头。`,
							);
						}
					}
					// 闸门 3：lastActions 去重保护。3 分钟内同镜头刚做过同类动作 → 直接拒。
					// （此前条件里残留 `action.replace("retts","retts")` 这类 no-op，纯靠 kind 与 action
					//  同名侥幸生效；现在显式映射，kind 重命名也不会静默失效。）
					if ((action === "reshot" || action === "retts") && p.shotId) {
						const actionKind: ActionRecord["kind"] = action; // reshot|retts → 同名
						const duplicate = run.lastActions.find(
							(a) =>
								a.kind === actionKind &&
								a.shotId === p.shotId &&
								Date.now() - new Date(a.at).getTime() < LAST_ACTION_DEDUP_MS,
						);
						if (duplicate) {
							throw new Error(
								`镜头 ${p.shotId} 最近 3 分钟内已 ${duplicate.label}（去重护栏）。如需再次重做，请提供不同意见。`,
							);
						}
					}
					// P2：按 action + run options 算出金额（不依赖 LLM 文案）
					const costEst = estimateProposalCost({
						catalog: priceCatalog,
						action,
						clipDurationSec: run.brief.generationOptions?.clipDurationSec ?? 5,
					});
					return {
						action,
						target: p.target.slice(0, 120),
						...(typeof p.shotId === "string" && /^SH\d{1,3}$/.test(p.shotId) ? { shotId: p.shotId } : {}),
						reason: p.reason.slice(0, 400),
						estimatedCost: p.estimatedCost.slice(0, 120),
						cost: { amount: costEst.amount, currency: priceCatalog.fallback.currency, note: costEst.note },
						...(typeof p.speed === "number" && p.speed >= 0.85 && p.speed <= 1.35 ? { speed: p.speed } : {}),
						// P2+阅门 2：宽容解析 confidence（缺失/非法值 → "medium"默认）
						confidence:
							p.confidence === "high" || p.confidence === "medium" || p.confidence === "low"
								? p.confidence
								: "medium",
					};
				}),
			};
			return { content: [{ type: "text", text: "提案已记录，审议结束。" }], details: {}, terminate: true };
		},
	);

	return { tools: [comparisonTool, evidenceTool, frameTool, historyTool, proposeTool], getProposal: () => proposal };
}

const DIRECTOR_SYSTEM_PROMPT = [
	"你是广告片导演，负责对比两版成片、归因差异并给出调整提案。",
	"",
	"规则:",
	"1. 所有结论必须基于工具返回的事实；引用证据时给出具体数值或帧内容描述。",
	"2. 归因层优先级: 剪辑层 > 素材层 > prompt 层。能用剪辑解决就不要建议重做镜头。",
	"3. 提案最多 2 个动作，优先成本低的方案；每个提案给出诚实的成本说明。",
	"4. 用户反馈的预设标签是重要信号，但不取代你自己的判断。",
	"5. 历史审议中被否决的方案不要原样重提；连续多轮不收敛时优先考虑结构性/素材层原因。",
	"6. 完成思考后必须调用 propose 工具结束审议。",
	"7. 为每个提案评估 confidence（high/medium/low）：high=证据直接+修复明确（如 reedit 调速），medium=证据间接或成本较高，low=证据弱或修复路径不确定。系统会根据 confidence 决定采纳路径。",
].join("\n");

/**
 * 发起一轮审议：记录用户偏好 → 跑导演归因循环 → 落盘轮次。
 * 同步等待（循环约 1-3 分钟）；循环失败不阻塞偏好落盘。
 */
export async function runDeliberation(
	ctx: { llm: LlmConfig; priceCatalog: import("./pricing.ts").PriceCatalog },
	run: RunRecord,
	input: DeliberateInput,
): Promise<{ ok: true; round: DeliberationRound } | { ok: false; error: string }> {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const variants = await listCutVariants(run);
	const base = variantById(variants, input.baseId);
	const challenger = input.challengerId ? variantById(variants, input.challengerId) : null;
	if (!base) return { ok: false, error: "基准候选不存在，请刷新候选列表" };
	if (input.challengerId && !challenger) return { ok: false, error: "对比候选不存在，请刷新候选列表" };
	if (challenger && challenger.id === base.id) return { ok: false, error: "两列候选不能相同" };
	const rival = challenger ?? null;
	const tags = input.tags
		.filter((t) => typeof t === "string")
		.map((t) => t.slice(0, 12))
		.slice(0, 4);
	const note = input.note?.trim().slice(0, 300) || undefined;

	try {
		const doc = await readArtifact<DeliberationsDoc>(run, "deliberations.json");
		if ((doc.rounds?.length ?? 0) >= MAX_DELIB_PER_RUN) {
			return { ok: false, error: `审议轮次已达上限 ${MAX_DELIB_PER_RUN} 轮` };
		}
	} catch {
		// 首轮
	}

	const round: DeliberationRound = {
		id: `dlb-${randomUUID().slice(0, 8)}`,
		at: new Date().toISOString(),
		baseVariantId: base.id,
		...(challenger ? { challengerVariantId: challenger.id } : {}),
		verdict: challenger ? input.verdict : "neither",
		tags,
		...(note ? { note } : {}),
		doc: null,
	};

	await appendPreference(run, {
		at: round.at,
		runId: run.id,
		roundId: round.id,
		baseVariantId: base.id,
		...(challenger ? { challengerVariantId: challenger.id } : {}),
		chosen: challenger ? input.verdict : "neither",
		tags,
		...(note ? { note } : {}),
		deltaContext: deltaContextOf(base, rival),
	});

	// 导演归因循环（ReAct：observe → think → propose；循环内无写工具，执行全部在用户批准后）
	const { tools, getProposal } = buildTools(run, base, rival, ctx.priceCatalog);
	// 只注入去重窗口内（LAST_ACTION_DEDUP_MS=3 分钟）的动作——此前写"最近 3 分钟"
	// 却取最近 8 条不过滤时间，几小时前的旧账会误导模型放弃本就合理的建议。
	const cutoff = Date.now() - LAST_ACTION_DEDUP_MS;
	const recentActions = run.lastActions.filter((a) => new Date(a.at).getTime() >= cutoff);
	const recentActionsHint = recentActions.length > 0
		? `\n\n【最近几分钟已执行的动作 — 避免重复提议】\n${
				recentActions
					.map(
						(a) =>
							`- ${a.kind}${a.shotId ? ` ${a.shotId}` : ""}: ${a.label}（${new Date(a.at).toLocaleTimeString("zh-CN")}）`,
					)
					.join("\n")
			}\n如果某个镜头刚刚做过重做，不要再提同类动作。`
		: "";
	const context: AgentContext = {
		systemPrompt: DIRECTOR_SYSTEM_PROMPT + recentActionsHint,
		messages: [],
		tools,
	};
	const prompt: Message = {
		role: "user",
		content: [
			challenger
				? `候选 A = ${base.label}（用户当前选中版本），候选 B = ${challenger.label}（落选版本）。`
				: `审议对象 = ${base.label}（单版诊断模式，无对比候选）。`,
			challenger
				? `用户对比后的选择: ${input.verdict === "base" ? "保留 A" : input.verdict === "challenger" ? "换成 B" : "两版都不满意"}。`
				: "用户未做对比，直接对当前成片提出修改意见。",
			`用户反馈标签: [${tags.join("、") || "无"}]。${note ? `补充说明: 「${note}」` : ""}`,
			`请审议: 归因用户的反馈${challenger ? "与选择" : ""}，评估当前选中版本的改进空间，给出提案。` +
				`注意: 轮次有限（${DELIB_MAX_TURNS} 轮），取证尽量并行批量调用，思考成熟后立即调用 propose 提交结论，不要以纯文本作答。`,
		].join(" "),
		timestamp: Date.now(),
	};

	const loopConfig = {
		model: stepfunModel(ctx.llm),
		apiKey: ctx.llm.apiKey,
		convertToLlm: (messages: AgentContext["messages"]) =>
			messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
		shouldStopAfterTurn: () => {
			turns += 1;
			return turns >= DELIB_MAX_TURNS;
		},
	};
	let turns = 0;
	const dbg = (msg: string) => console.log(`[deliberation:${round.id}] ${msg}`);
	try {
		await runAgentLoop(
			[prompt],
			context,
			loopConfig,
			(event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const m = event.message;
					const calls = m.content
						.filter((c) => c.type === "toolCall")
						.map((c) => (c.type === "toolCall" ? c.name : ""));
					const text = m.content.find((c) => c.type === "text");
					dbg(
						`assistant stop=${m.stopReason} tools=[${calls.join(",")}] text=${
							text && text.type === "text" ? text.text.slice(0, 120) : "-"
						}${m.errorMessage ? ` ERR=${m.errorMessage}` : ""}`,
					);
				}
			},
			run.abort.signal,
			(model, llmContext, options) => streamWithRetry(model as Model<"openai-completions">, llmContext, options),
		);

		// 模型若以纯文本收尾而未调 propose：补一次催交续跑（不新增证据轮次）
		dbg(`loop ended, proposal=${getProposal() ? "yes" : "no"}, turns=${turns}`);
		if (!getProposal()) {
			context.messages.push({
				role: "user",
				content:
					"你还没有提交结论。请立即调用 propose 工具，基于已获取的证据给出 rootCause / findings / proposals。",
				timestamp: Date.now(),
			} as Message);
			await runAgentLoopContinue(
				context,
				loopConfig,
				async () => {},
				run.abort.signal,
				(model, llmContext, options) => streamWithRetry(model as Model<"openai-completions">, llmContext, options),
			);
		}
	} catch (error) {
		round.error = error instanceof Error ? error.message : String(error);
	}

	const proposal = getProposal();
	if (proposal) {
		round.doc = proposal;
	} else if (!round.error) {
		round.error = "导演未在轮次上限内给出结论";
	}

	// 落盘轮次（并发写风险低：审议由用户逐轮发起）
	let rounds: DeliberationRound[] = [];
	try {
		rounds = (await readArtifact<DeliberationsDoc>(run, "deliberations.json")).rounds ?? [];
	} catch {
		// 首轮
	}
	await writeJson(run, "deliberations.json", { rounds: [...rounds, round] } satisfies DeliberationsDoc);
	return { ok: true, round };
}

/** 审议历史（旧 run 无文件时为空数组） */
export async function listDeliberations(run: RunRecord): Promise<DeliberationRound[]> {
	try {
		const doc = await readArtifact<DeliberationsDoc>(run, "deliberations.json");
		return doc.rounds ?? [];
	} catch {
		return [];
	}
}

/** 回写提案采纳记录（下一轮审议的 get_preferences 会带上，避免导演重复建议） */
export async function markAdopted(run: RunRecord, roundId: string, action: string, target: string): Promise<boolean> {
	const rounds = await listDeliberations(run);
	const round = rounds.find((r) => r.id === roundId);
	if (!round) return false;
	round.adopted = { action: action.slice(0, 24), target: target.slice(0, 120), at: new Date().toISOString() };
	await writeJson(run, "deliberations.json", { rounds } satisfies DeliberationsDoc);
	return true;
}
