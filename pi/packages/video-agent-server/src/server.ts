/**
 * Colocated Express 服务（:8787，PORT 可覆盖）—— UI 与真实管线的边界。
 *
 * 契约与 video-agent-ui 的 client.ts 一一对应：
 *   POST /api/clarify/start|next|answer|skip   访谈（cookie 会话）
 *   POST /api/uploads                          上传参考图（dataUrl，≤10MB）
 *   GET  /api/uploads/:id                      预览上传图
 *   POST /api/generate                         启动管线（可携带 imageIds）→ runId
 *   GET  /api/runs                             项目列表（轻量 summary，按状态文件更新时间倒序）
 *   GET  /api/runs/:id                         轮询状态（stages/events/verdict）
 *   GET  /api/runs/:id/events                  SSE 实时快照；断线时前端自动退回轮询
 *   GET  /api/runs/:id/artifacts               文本产物 + 资产清单
 *   GET  /api/runs/:id/files/*                 run 内任意产物文件（安全路径校验）
 *   POST /api/runs/:id/chat                    与导演对话（真实 LLM）
 *   POST /api/runs/:id/refine                  微调文本阶段（剧本/美术设计/分镜提示词）
 *   POST /api/runs/:id/resume                  确认推进；可选 confirmedShotIds 表示关键帧部分确认
 *   POST /api/runs/:id/reshot                  镜头级重做（版本化备份 + 质检反馈回灌）
 *   POST /api/runs/:id/retts                   旁白重录（改写文案或纯表演指导，语音级重做）
 *   POST /api/runs/:id/design/adjust           设计图单卡调整重绘（美术设计）
 *   POST /api/runs/:id/design/review           设计出图审核（视觉模型逐卡比对设计要点）
 *   POST /api/runs/:id/keyframes/review        关键帧出图审核（帧 vs 锚定的设计定稿）
 *   POST /api/runs/:id/keyframes/adjust        分镜关键帧单镜重绘
 *   GET  /api/runs/:id/versions                每镜视频/音频版本清单（组合出片用）
 *   POST /api/runs/:id/compose                 按勾选版本装配交付版 cut{N}.mp4（限 2 次）
 *   GET  /api/runs/:id/cutvariants             审议候选清单（compose 产物 + 节奏变体）
 *   POST /api/runs/:id/cutvariants             L1 节奏变体（整片等比变速，本地 ffmpeg）
 *   GET  /api/runs/:id/deliberations           审议历史
 *   POST /api/runs/:id/deliberations           发起审议（导演 ReAct 归因循环，同步 1-3 分钟）
 *   POST /api/cocreate/chat                    共创模式·创意合伙人对话
 *   POST /api/cocreate/extract                 共创对话 → 共创空间结构化提炼
 *   GET  /api/runs/:id/traces                  运行追踪 spans（traces.ndjson）
 *   POST /api/runs/:id/cancel                  取消
 *   GET  /api/runs/:id/video                   成片播放
 *   GET  /api/runs/:id/download                成片下载
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import {
	Clarifier,
	type CoCreationSpace,
	FIXED_QUESTION_COUNT,
	type Locale,
	QUESTIONS,
	type Question,
	resolveGenerationOptions,
} from "../../video-agent/src/index.ts";
import { loadServerContext, type ServerContext } from "./config.ts";
import { checkConsistency, getConsistency } from "./consistency.ts";
import { reviewDesignBible, reviewKeyframes } from "./design-review.ts";
import {
	createPaceVariant,
	listCutVariants,
	listDeliberations,
	markAdopted,
	PACE_PRESETS,
	runDeliberation,
} from "./deliberation.ts";
import { chat, chatJson } from "./llm.ts";
import { estimateRunCost as pricingEstimateRun } from "./pricing.ts";
import { kitchenFeedback, kitchenSummary, producerObserve, applySuggestion, readBudgetAlerts, applyPriorityInstruction, readPriorityInstructions } from "./producer.ts";
import { activeQueueOf, buildKitchenSnapshot } from "./kitchen.ts";
import { computeRunMetrics, shotSeconds, type MetricsInput } from "./metrics.ts";
import {
	availableVoices,
	composeCut,
	directorChat,
	listShotVersions,
	RunStore,
	readTraces,
	redesignEntity,
	redesignKeyframe,
	reexportRun,
	refineRun,
	reshotRun,
	resumeRun,
	rettsRun,
	runSummary,
	runView,
	readArtifact,
	type StageId,
	startRun,
	subscribeRun,
	subscribeRunEvents,
	type TeamEvent,
} from "./pipeline.ts";
import { type CutsDoc, type CutsView, MAX_COMPOSE_PER_RUN } from "./redo/compose.ts";
import {
	type DesignBibleDoc,
	type KeyframesDoc,
	type ScriptDoc,
	type ShotPromptDoc,
	tailoredQuestionsMessages,
	type VisualBible,
} from "./prompts.ts";

const COOKIE_NAME = "va_sid";
/** 访谈会话：带最后活跃时间，超 SESSION_TTL 未访问即回收（cookie Max-Age 同为 24h） */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const sessions = new Map<string, { session: Clarifier; at: number }>();
let lastSweepAt = Date.now();
function sessionSweep(): void {
	const now = Date.now();
	if (now - lastSweepAt < SESSION_SWEEP_INTERVAL_MS) return;
	lastSweepAt = now;
	for (const [sid, entry] of sessions) {
		if (now - entry.at > SESSION_TTL_MS) sessions.delete(sid);
	}
}
const runStore = new RunStore();

// ---- 上传素材登记 ----

interface UploadMeta {
	id: string;
	name: string;
	ext: string;
	file: string;
}

/** id → 元数据（服务重启后由 scanUpload 按目录前缀兜底恢复） */
const uploads = new Map<string, UploadMeta>();

const IMAGE_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

/** BGM 支持的音频格式（dataUrl MIME → 扩展名） */
const AUDIO_EXT: Record<string, string> = {
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/mp4": "m4a",
	"audio/x-m4a": "m4a",
	"audio/aac": "m4a",
	"audio/ogg": "ogg",
	"audio/flac": "flac",
};

const BGM_FILES = ["bgm.mp3", "bgm.wav", "bgm.m4a", "bgm.ogg", "bgm.flac"];

/** run 内 BGM 文件名（存在才返回） */
function bgmFileOf(runDir: string): string | null {
	return BGM_FILES.find((f) => fs.existsSync(path.join(runDir, "assets", f))) ?? null;
}

const MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
	".json": "application/json",
	".ass": "text/plain; charset=utf-8",
};

function uploadsDir(ctx: ServerContext): string {
	return path.join(ctx.studioRoot, ".pi-studio", "video-agent-uploads");
}

function scanUpload(dir: string, id: string): UploadMeta | undefined {
	if (!fs.existsSync(dir)) return undefined;
	const found = fs.readdirSync(dir).find((f) => f.startsWith(`${id}.`));
	if (!found) return undefined;
	const ext = path.extname(found).slice(1);
	return { id, name: found, ext, file: path.join(dir, found) };
}

// ---- 视图展开（locale） ----

interface QuestionView {
	id: string;
	category: string;
	text: string;
	options: { id: string; label: string; hint: string }[];
	weight: "core" | "refinement" | "tailored";
}

function toView(question: Question, locale: Locale): QuestionView {
	return {
		id: question.id,
		category: question.category[locale],
		text: question.text[locale],
		weight: question.weight,
		options: question.options.map((o) => ({ id: o.id, label: o.label[locale], hint: o.hint[locale] })),
	};
}

// ---- 定制访谈题（固定 10 题答完后，LLM 按需求现场出 5 题） ----

/** 定制题归一化：宽容解析 LLM 输出，缺字段/非法选项的题丢弃 */
function normalizeTailoredQuestions(raw: unknown): Question[] {
	const list = (raw as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(list)) return [];
	const stages = ["script", "visual", "clips", "audio", "export"];
	const out: Question[] = [];
	for (const item of list.slice(0, 8)) {
		const q = item as {
			category?: unknown;
			text?: unknown;
			stage?: unknown;
			options?: { label?: unknown; hint?: unknown; promptTags?: unknown }[];
		};
		if (typeof q.text !== "string" || !q.text.trim()) continue;
		const options = (Array.isArray(q.options) ? q.options : [])
			.map((o) => ({
				id: "",
				label: {
					zh: typeof o.label === "string" ? o.label.trim() : "",
					en: typeof o.label === "string" ? o.label.trim() : "",
				},
				hint: { zh: typeof o.hint === "string" ? o.hint : "", en: typeof o.hint === "string" ? o.hint : "" },
				promptTags: Array.isArray(o.promptTags)
					? o.promptTags.filter((t): t is string => typeof t === "string").slice(0, 6)
					: [],
			}))
			.filter((o) => o.label.zh.length > 0);
		if (options.length < 2) continue;
		out.push({
			id: "",
			category: {
				zh: typeof q.category === "string" && q.category.trim() ? q.category.trim().slice(0, 12) : "定制",
				en: "Tailored",
			},
			text: { zh: q.text.trim().slice(0, 200), en: q.text.trim().slice(0, 200) },
			options,
			weight: "tailored",
			source: "generated",
			...(typeof q.stage === "string" && stages.includes(q.stage) ? { stage: q.stage as "script" } : {}),
		});
		if (out.length >= 5) break;
	}
	return out;
}

/** 固定题答完且定制题未注入时：调 LLM 出 5 道贴合需求的题；失败注入内置降级题 */
const tailoredJobs = new WeakMap<Clarifier, Promise<void>>();

/** 实际生成并注入定制题（幂等：已注入则跳过） */
async function generateTailored(ctx: ServerContext, session: Clarifier): Promise<void> {
	if (session.snapshot.tailored.length > 0) return;
	const summary = session.snapshot.answers
		.map((entry) => {
			const question = QUESTIONS.find((q) => q.id === entry.questionId);
			const option = question?.options.find((o) => o.id === entry.answerId);
			return question && option ? `${question.category.zh}:${option.label.zh}` : null;
		})
		.filter((s): s is string => s !== null)
		.join("；");
	try {
		const messages = tailoredQuestionsMessages(session.sourceBrief, summary);
		const promptText = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
		const raw = await chatJson<unknown>(ctx.llm, promptText);
		const questions = normalizeTailoredQuestions(raw);
		session.installTailored(questions.length > 0 ? questions : null);
	} catch {
		session.installTailored(null);
	}
}

/** 需要定制题时等待生成完成（复用进行中的后台任务）；最多等 budgetMs，超时交给前端轮询 */
async function settleTailored(ctx: ServerContext, session: Clarifier, budgetMs = 2000): Promise<void> {
	if (!session.needsTailored()) return;
	let job = tailoredJobs.get(session);
	if (!job) {
		job = generateTailored(ctx, session);
		tailoredJobs.set(session, job);
	}
	await Promise.race([
		job,
		new Promise((resolve) => {
			setTimeout(resolve, budgetMs);
		}),
	]);
}

/** 定制题是否仍在生成中（固定题已答完但尚未注入） */
function tailoredPending(session: Clarifier): boolean {
	return session.needsTailored();
}

/**
 * 预取：答到第 8 题（或单题跳过推进到同位置）就后台开始生成，
 * 用人答剩余两题的时间掩盖 LLM 延迟 —— 到第 11 题时基本零等待。
 */
function prefetchTailored(ctx: ServerContext, session: Clarifier): void {
	if (session.snapshot.skipped || session.snapshot.tailored.length > 0) return;
	if (session.snapshot.askedCount < FIXED_QUESTION_COUNT - 1) return;
	if (tailoredJobs.has(session)) return;
	const job = generateTailored(ctx, session).catch(() => {});
	tailoredJobs.set(session, job);
}

// ---- 会话 cookie ----

function sessionOf(req: Request): Clarifier | undefined {
	const raw = req.headers.cookie ?? "";
	for (const part of raw.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === COOKIE_NAME) return touchSession(decodeURIComponent(rest.join("=")));
	}
	return undefined;
}

/** 取会话并续期；顺带做一次惰性清理，避免长时间运行的进程里 Map 只增不减（review B10） */
function touchSession(sid: string): Clarifier | undefined {
	const entry = sessions.get(sid);
	if (entry) entry.at = Date.now();
	else sessionSweep();
	return entry?.session;
}

function requireSession(req: Request, res: Response): Clarifier | undefined {
	const session = sessionOf(req);
	if (!session) {
		res.status(400).json({ error: "访谈会话不存在，请先开始访谈（/api/clarify/start）" });
		return undefined;
	}
	return session;
}

// ---- 请求体解析 ----

interface BriefInput {
	logline?: unknown;
	keyMessage?: unknown;
}

function briefFromBody(body: { brief?: BriefInput }): { logline: string; keyMessage?: string } | null {
	const brief = body.brief;
	if (!brief || typeof brief.logline !== "string" || !brief.logline.trim()) return null;
	const keyMessage = typeof brief.keyMessage === "string" && brief.keyMessage.trim() ? brief.keyMessage : undefined;
	return { logline: brief.logline.trim(), ...(keyMessage ? { keyMessage } : {}) };
}

function notFoundRun(res: Response, id: string): void {
	res.status(404).json({ error: `未知 runId: ${id}` });
}

/** 共创空间宽容校验：字段截断、空数组归零，非法输入直接丢弃 */
function coSpaceFromBody(raw: unknown): CoCreationSpace | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const src = raw as {
		characters?: { name?: unknown; description?: unknown }[];
		scenes?: { name?: unknown; description?: unknown }[];
		ideas?: unknown[];
		musicBrief?: unknown;
	};
	const text = (v: unknown, cap: number): string => (typeof v === "string" ? v.trim().slice(0, cap) : "");
	const pair = (list: unknown): { name: string; description: string }[] =>
		(Array.isArray(list) ? list : [])
			.map((item) => ({
				name: text((item as { name?: unknown })?.name, 40),
				description: text((item as { description?: unknown })?.description, 600),
			}))
			.filter((p) => p.name.length > 0)
			.slice(0, 8);
	const characters = pair(src.characters);
	const scenes = pair(src.scenes);
	const ideas = (Array.isArray(src.ideas) ? src.ideas : [])
		.filter((i): i is string => typeof i === "string" && i.trim().length > 0)
		.map((i) => i.trim().slice(0, 240))
		.slice(0, 12);
	const musicBrief = text(src.musicBrief, 300);
	if (characters.length === 0 && scenes.length === 0 && ideas.length === 0 && !musicBrief) return undefined;
	return {
		characters,
		scenes,
		ideas,
		...(musicBrief ? { musicBrief } : {}),
	};
}

// ============================================================================
// App
// ============================================================================

function createApp(ctx: ServerContext) {
	const app = express();
	app.use(express.json({ limit: "20mb" }));

	// ---- 访谈 ----

	app.post("/api/clarify/start", (req, res) => {
		const brief = briefFromBody(req.body);
		if (!brief) {
			res.status(400).json({ error: "缺少 brief.logline" });
			return;
		}
		const sid = randomUUID();
		sessions.set(sid, { session: new Clarifier({ creative: brief }), at: Date.now() });
		sessionSweep();
		res.setHeader("Set-Cookie", `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
		res.json({ ok: true });
	});

	app.post("/api/clarify/next", async (req, res) => {
		const session = requireSession(req, res);
		if (!session) return;
		const locale: Locale = req.body?.locale === "en" ? "en" : "zh";
		await settleTailored(ctx, session);
		const question = session.currentQuestion();
		res.json({ question: question ? toView(question, locale) : null, pending: tailoredPending(session) });
	});

	app.post("/api/clarify/answer", async (req, res) => {
		const session = requireSession(req, res);
		if (!session) return;
		const answerId = typeof req.body?.answerId === "string" ? req.body.answerId : "";
		const locale: Locale = req.body?.locale === "en" ? "en" : "zh";
		try {
			const snapshot = session.answer(answerId);
			prefetchTailored(ctx, session);
			await settleTailored(ctx, session);
			const next = session.currentQuestion();
			res.json({
				done: snapshot.phase === "done",
				pending: !next && tailoredPending(session),
				question: next ? toView(next, locale) : null,
				answeredCount: snapshot.answeredCount,
				askedCount: snapshot.askedCount,
				total: snapshot.totalQuestions,
			});
		} catch (error) {
			res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// 单题跳过：不记录答案、不结束访谈，直接推进到下一题
	app.post("/api/clarify/skip-question", async (req, res) => {
		const session = requireSession(req, res);
		if (!session) return;
		const locale: Locale = req.body?.locale === "en" ? "en" : "zh";
		try {
			const snapshot = session.skipCurrent();
			prefetchTailored(ctx, session);
			await settleTailored(ctx, session);
			const next = session.currentQuestion();
			res.json({
				done: snapshot.phase === "done",
				pending: !next && tailoredPending(session),
				question: next ? toView(next, locale) : null,
				answeredCount: snapshot.answeredCount,
				askedCount: snapshot.askedCount,
				total: snapshot.totalQuestions,
			});
		} catch (error) {
			res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/clarify/skip", (req, res) => {
		const session = requireSession(req, res);
		if (!session) return;
		session.skip();
		res.json({ ok: true });
	});

	// ---- 参考素材上传 ----

	app.post("/api/uploads", (req, res) => {
		const name = typeof req.body?.name === "string" ? req.body.name : "";
		const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
		const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
		if (!match) {
			res.status(400).json({ error: "仅支持 PNG/JPEG/WEBP/GIF 的 base64 dataUrl" });
			return;
		}
		const buf = Buffer.from(match[2]!, "base64");
		if (buf.length === 0 || buf.length > 10 * 1024 * 1024) {
			res.status(400).json({ error: "图片需在 10MB 以内且非空" });
			return;
		}
		const ext = IMAGE_EXT[match[1]!]!;
		const id = randomUUID().slice(0, 8);
		const dir = uploadsDir(ctx);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${id}.${ext}`);
		fs.writeFileSync(file, buf);
		const meta: UploadMeta = { id, name: name.trim() || `参考图.${ext}`, ext, file };
		uploads.set(id, meta);
		res.json({ id, name: meta.name, url: `/api/uploads/${id}` });
	});

	app.get("/api/uploads/:id", (req, res) => {
		const meta = uploads.get(req.params.id) ?? scanUpload(uploadsDir(ctx), req.params.id);
		if (!meta || !fs.existsSync(meta.file)) {
			res.status(404).json({ error: "上传素材不存在" });
			return;
		}
		res.setHeader("Content-Type", `image/${meta.ext === "jpg" ? "jpeg" : meta.ext}`);
		res.setHeader("Cache-Control", "no-store");
		streamFile(res, meta.file);
	});

	// ---- 生成 ----

	app.post("/api/generate", (req, res) => {
		const brief = briefFromBody(req.body);
		if (!brief) {
			res.status(400).json({ error: "缺少 brief.logline" });
			return;
		}
		const options = resolveGenerationOptions(req.body?.options ?? undefined);
		const session = sessionOf(req);
		const enriched = session?.compose(options);
		const coSpace = coSpaceFromBody(req.body?.coSpace);
		const imageIds: string[] = Array.isArray(req.body?.imageIds)
			? req.body.imageIds.filter((x: unknown) => typeof x === "string" && x)
			: [];
		const images = imageIds
			.map((id) => uploads.get(id) ?? scanUpload(uploadsDir(ctx), id))
			.filter((m): m is UploadMeta => Boolean(m))
			.map((m) => ({ id: m.id, name: m.name, ext: m.ext }));
		const run = startRun(ctx, runStore, {
			logline: brief.logline,
			...(brief.keyMessage ? { keyMessage: brief.keyMessage } : {}),
			generationOptions: options,
			...(enriched ? { enriched } : {}),
			...(coSpace ? { coSpace } : {}),
			...(images.length > 0 ? { images } : {}),
		});
		res.json({ runId: run.id });
	});

	// ---- P2：预估成本（启动前）
	//  给 Home / CoCreate 页面在「启动制作」」前拿到预计花费，用户可以拍/不拍。
	app.post("/api/pricing/estimate", (req, res) => {
		const options = resolveGenerationOptions(req.body?.options ?? undefined);
		const coSpace = coSpaceFromBody(req.body?.coSpace);
		const estimate = pricingEstimateRun({
			catalog: ctx.priceCatalog,
			shotCount: options.shotCount,
			clipDurationSec: options.clipDurationSec,
			// 共创空间会拉高设计实体推导的准确度，相应多加几轮迭代；重做缓冲：
			withDesignSheets: true,
			redoBuffer: coSpace ? Math.ceil(options.shotCount / 4) : 0,
			// A5/A7：台词模式下重录台词会级联重生成口型视频，预估加缓冲行
			audioDrive: options.audioDrive,
		});
		res.json({
			total: estimate.total,
			currency: estimate.currency,
			lines: estimate.lines,
		});
	});

	// ---- 运行状态 ----

	app.get("/api/runs", (req, res) => {
		const limitRaw = Number(req.query.limit ?? 50);
		const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 50;
		const runs = runStore
			.list()
			.map((run) => {
				try {
					return runSummary(run, fs.statSync(path.join(run.dir, "run-state.json")).mtime.toISOString());
				} catch {
					return runSummary(run);
				}
			})
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
			.slice(0, limit);
		res.json({ runs });
	});

	app.get("/api/runs/:id", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		res.json(runView(run));
	});

	// SSE：一次长连接接收 run 变更。两类消息：
	//   "run" = 完整 RunView 快照（状态级变化时；首连立即一条）
	//   "ev"  = 单条团队事件增量（ndjson 化后 pushEvent 不再触发全量快照）
	// 前端据此立即刷新产物；轮询继续保留为断线兜底。
	app.get("/api/runs/:id/events", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});

		const send = (): void => {
			if (res.writableEnded || !runStore.get(run.id)) return;
			res.write(`event: run\ndata: ${JSON.stringify(runView(run))}\n\n`);
		};
		const sendEvent = (event: TeamEvent): void => {
			if (res.writableEnded || !runStore.get(run.id)) return;
			res.write(`event: ev\ndata: ${JSON.stringify(event)}\n\n`);
		};
		const unsubscribe = subscribeRun(run.id, send);
		const unsubscribeEvents = subscribeRunEvents(run.id, sendEvent);
		send();

		const heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(": ping\n\n");
		}, 15_000);
		const close = (): void => {
			clearInterval(heartbeat);
			unsubscribe();
			unsubscribeEvents();
			res.end();
		};
		req.on("close", close);
		res.on("error", close);
	});

	app.post("/api/runs/:id/cancel", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		if (run.status === "running") run.abort.abort(new Error("用户取消"));
		res.json({ ok: true });
	});

	// ---- 产物读取 ----

	app.get("/api/runs/:id/artifacts", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const readJson = <T>(name: string): T | null => {
			try {
				return JSON.parse(fs.readFileSync(path.join(run.dir, name), "utf-8")) as T;
			} catch {
				return null;
			}
		};
		const assetsDir = path.join(run.dir, "assets");
		const assets: { name: string; url: string; type: "video" | "audio" | "image" | "other" }[] = [];
		if (fs.existsSync(assetsDir)) {
			for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const ext = path.extname(entry.name).toLowerCase();
				assets.push({
					name: entry.name,
					url: `/api/runs/${run.id}/files/assets/${encodeURIComponent(entry.name)}`,
					type:
						ext === ".mp4"
							? "video"
							: ext === ".mp3"
								? "audio"
								: [".jpg", ".jpeg", ".png", ".webp"].includes(ext)
									? "image"
									: "other",
				});
			}
		}
		assets.sort((a, b) => a.name.localeCompare(b.name));
		const fileUrl = (rel: string): string => `/api/runs/${run.id}/files/${rel.split(path.sep).join("/")}`;
		const design = readJson<DesignBibleDoc>("design-bible.json");
		if (design) {
			for (const entity of [...(design.characters ?? []), ...(design.props ?? []), ...(design.scenes ?? [])]) {
				if (entity.file) entity.url = fileUrl(entity.file);
			}
		}
		const keyframes = readJson<KeyframesDoc>("keyframes.json");
		if (keyframes) {
			for (const frame of keyframes.frames ?? []) {
				if (frame.file) frame.url = fileUrl(frame.file);
			}
		}
		const cuts = readJson<CutsDoc>("cuts.json");
		res.json({
			script: readJson<ScriptDoc>("script.json"),
			bible: readJson<VisualBible>("visual-bible.json"),
			prompts: readJson<ShotPromptDoc>("prompts.json"),
			...(design ? { design } : {}),
			...(keyframes ? { keyframes } : {}),
			...(cuts ? { cuts } : {}),
			assets,
		});
	});

	// ---- 组合出片：每镜版本清单 + 按选择装配交付版（限 MAX_COMPOSE_PER_RUN 次） ----

	app.get("/api/runs/:id/versions", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		let used = 0;
		try {
			const cuts = JSON.parse(fs.readFileSync(path.join(run.dir, "cuts.json"), "utf-8")) as CutsDoc;
			used = typeof cuts?.used === "number" ? cuts.used : 0;
		} catch {
			used = 0;
		}
		res.json({ shots: await listShotVersions(run), remaining: Math.max(0, MAX_COMPOSE_PER_RUN - used) });
	});

	app.post("/api/runs/:id/compose", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const raw = req.body?.selections;
		const selections: Record<string, { video?: string; audio?: string }> = {};
		if (raw && typeof raw === "object") {
			for (const [shotId, sel] of Object.entries(raw as Record<string, unknown>)) {
				if (!/^[A-Za-z0-9_-]{1,16}$/.test(shotId) || !sel || typeof sel !== "object") continue;
				const item = sel as { video?: unknown; audio?: unknown };
				selections[shotId] = {
					...(typeof item.video === "string" && item.video ? { video: item.video.slice(0, 120) } : {}),
					...(typeof item.audio === "string" && item.audio ? { audio: item.audio.slice(0, 120) } : {}),
				};
			}
		}
		try {
			const result = await composeCut(run, selections);
			if (!result.ok) {
				res.status(400).json(result);
				return;
			}
			res.json(result);
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// ---- 审议优化：候选成片 / 节奏变体 / 审议循环 ----

	/** 候选清单（首次调用会把历史 compose 产物与主成片登记进台账） */
	app.get("/api/runs/:id/cutvariants", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		// 此前返回了个函数（JSON.stringify 静默丢弃）——改为服务端直接给 url 字段
		const variants = await listCutVariants(run);
		res.json({
			variants: variants.map((v) => ({
				...v,
				url: `/api/runs/${run.id}/files/${v.file.split(path.sep).join("/")}`,
			})),
			presets: PACE_PRESETS,
		});
	});

	/** L1 节奏变体：对基准候选整片等比变速（本地 ffmpeg，零模型成本） */
	app.post("/api/runs/:id/cutvariants", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const baseId = typeof req.body?.baseId === "string" ? req.body.baseId : "";
		const speed = Number(req.body?.speed);
		const variants = await listCutVariants(run);
		const base = variants.find((v) => v.id === baseId);
		if (!base) {
			res.status(400).json({ error: "基准候选不存在" });
			return;
		}
		try {
			const result = await createPaceVariant(run, base, speed);
			if (!result.ok) {
				res.status(400).json(result);
				return;
			}
			res.json(result);
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	/** 审议历史 */
	app.get("/api/runs/:id/deliberations", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		res.json({ rounds: await listDeliberations(run) });
	});

	/** 回写提案采纳记录（下一轮审议据此避免重复建议） */
	app.post("/api/runs/:id/deliberations/:roundId/adopt", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const action = typeof req.body?.action === "string" ? req.body.action : "";
		const target = typeof req.body?.target === "string" ? req.body.target : "";
		if (!action || !target) {
			res.status(400).json({ error: "需要 action 与 target" });
			return;
		}
		res.json({ ok: markAdopted(run, req.params.roundId, action, target) });
	});

	/** 跨镜一致性预检（同步，约 15-40s；结果落盘 consistency.json） */
	app.post("/api/runs/:id/consistency", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		if (run.status === "running") {
			res.status(400).json({ error: "管线运行中，请稍候" });
			return;
		}
		try {
			res.json(await checkConsistency(ctx, run, run.abort.signal));
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	/** 跨镜一致性结果（未检查过为 null） */
	app.get("/api/runs/:id/consistency", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		res.json(await getConsistency(run));
	});

	/** 发起一轮审议（同步等待导演归因循环，约 1-3 分钟） */
	app.post("/api/runs/:id/deliberations", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const baseId = typeof req.body?.baseId === "string" ? req.body.baseId : "";
		const challengerId = typeof req.body?.challengerId === "string" ? req.body.challengerId : undefined;
		const verdict = req.body?.verdict;
		const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
		if (!baseId || !["base", "challenger", "neither"].includes(verdict)) {
			res.status(400).json({
				error: "需要 baseId / verdict(base|challenger|neither)；challengerId 可空（单版诊断）",
			});
			return;
		}
		try {
			const result = await runDeliberation(ctx, run, {
				baseId,
				challengerId,
				verdict,
				tags: tags.filter((t: unknown): t is string => typeof t === "string"),
				note: typeof req.body?.note === "string" ? req.body.note : undefined,
			});
			if (!result.ok) {
				res.status(400).json(result);
				return;
			}
			res.json(result);
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// ---- 美术设计图 / 关键帧：单卡调整重绘（同步等待出图，秒级） ----

	/** 设计出图审核（同步，约 10-30s；结论写回 design-bible.json 的实体 review 字段） */
	app.post("/api/runs/:id/design/review", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		if (run.status === "running") {
			res.status(400).json({ error: "管线运行中，请稍候" });
			return;
		}
		const entityIds = Array.isArray(req.body?.entityIds)
			? req.body.entityIds.filter((x: unknown): x is string => typeof x === "string").slice(0, 9)
			: undefined;
		try {
			const { reviewed } = await reviewDesignBible(ctx, run, run.abort.signal, entityIds);
			res.json({
				ok: true,
				reviewed: reviewed.map((e) => ({ id: e.id, name: e.name, ...e.review })),
			});
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	/** 关键帧出图审核（同步，约 10-30s；结论写回 keyframes.json 的帧 review 字段） */
	app.post("/api/runs/:id/keyframes/review", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		if (run.status === "running") {
			res.status(400).json({ error: "管线运行中，请稍候" });
			return;
		}
		const shotIds = Array.isArray(req.body?.shotIds)
			? req.body.shotIds.filter((x: unknown): x is string => typeof x === "string").slice(0, 12)
			: undefined;
		try {
			const { reviewed } = await reviewKeyframes(ctx, run, run.abort.signal, shotIds);
			res.json({
				ok: true,
				reviewed: reviewed.map((f) => ({ id: f.shotId, ...f.review })),
			});
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/runs/:id/design/adjust", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const entityId = typeof req.body?.entityId === "string" ? req.body.entityId.trim() : "";
		const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim().slice(0, 300) : "";
		if (!entityId) {
			res.status(400).json({ error: "需要 entityId" });
			return;
		}
		try {
			const result = await redesignEntity(ctx, run, entityId, instruction);
			if (!result.ok) {
				res.status(400).json(result);
				return;
			}
			res.json({ ok: true });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/runs/:id/keyframes/adjust", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const shotId = typeof req.body?.shotId === "string" ? req.body.shotId.trim() : "";
		const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim().slice(0, 300) : "";
		if (!shotId) {
			res.status(400).json({ error: "需要 shotId" });
			return;
		}
		try {
			const result = await redesignKeyframe(ctx, run, shotId, instruction);
			if (!result.ok) {
				res.status(400).json(result);
				return;
			}
			res.json({ ok: true });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get(/^\/api\/runs\/([^/]+)\/files\/(.+)$/, (req, res) => {
		const runId = String(req.params[0]);
		const run = runStore.get(runId);
		if (!run) {
			notFoundRun(res, runId);
			return;
		}
		let rel = String(req.params[1]);
		try {
			rel = decodeURIComponent(rel);
		} catch {
			// 保留原值
		}
		const root = path.resolve(run.dir);
		const file = path.resolve(root, rel);
		if (!file.startsWith(root + path.sep)) {
			res.status(403).json({ error: "路径越界" });
			return;
		}
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
			res.status(404).json({ error: "文件不存在" });
			return;
		}
		const ext = path.extname(file).toLowerCase();
		res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
		res.setHeader("Cache-Control", "no-store");
		streamFile(res, file);
	});

	// ---- 导演对话 / 微调 / 续跑 ----

	app.post("/api/runs/:id/chat", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
		if (!text) {
			res.status(400).json({ error: "消息不能为空" });
			return;
		}
		try {
			const event = await directorChat(ctx, run, text.slice(0, 500));
			res.json({ event });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/runs/:id/refine", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const stageId = typeof req.body?.stageId === "string" ? req.body.stageId : "";
		const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
		if (!stageId || !instruction) {
			res.status(400).json({ error: "需要 stageId 与 instruction" });
			return;
		}
		const result = refineRun(ctx, run, stageId as StageId, instruction.slice(0, 500), req.body?.autoResume === true);
		if (!result.ok) {
			res.status(400).json(result);
			return;
		}
		res.json({ ok: true });
	});

	app.post("/api/runs/:id/resume", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const rawIds = req.body?.confirmedShotIds;
		const confirmedShotIds = Array.isArray(rawIds)
			? rawIds.filter((id): id is string => typeof id === "string")
			: undefined;
		const result = resumeRun(ctx, run, confirmedShotIds);
		if (!result.ok) {
			res.status(400).json(result);
			return;
		}
		res.json({ ok: true });
	});

	// ---- 镜头级重做 / 运行追踪 ----

	app.post("/api/runs/:id/reshot", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const shotId = typeof req.body?.shotId === "string" ? req.body.shotId.trim() : "";
		const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
		if (!shotId) {
			res.status(400).json({ error: "需要 shotId" });
			return;
		}
		try {
			const result = await reshotRun(ctx, run, shotId, instruction.slice(0, 500));
			if (!result.ok) {
				res.status(400).json(result);
				return;
			}
			res.json({ ok: true });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// 旁白重录（语音级重做）：可选按指令改写文案 → 重新合成该镜语音 → 以新语音重排该镜并重装配
	app.post("/api/runs/:id/retts", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const shotId = typeof req.body?.shotId === "string" ? req.body.shotId.trim() : "";
		const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
		if (!shotId) {
			res.status(400).json({ error: "需要 shotId" });
			return;
		}
		try {
			const result = await rettsRun(
				ctx,
				run,
				shotId,
				instruction.slice(0, 500),
				typeof req.body?.voice === "string" ? req.body.voice : undefined,
			);
			if (!result.ok) {
				res.status(400).json(result);
				return;
			}
			res.json({ ok: true });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// ---- 可用旁白音色（label → voice-id，供重录选择器与审议提案使用） ----

	app.get("/api/voices", (_req, res) => {
		res.json({ voices: availableVoices(ctx) });
	});

	// 能力清单：e2e 预检校验目标服务与当前代码库一致（防打进旧代码服务白烧配额）
	app.get("/api/health", (_req, res) => {
		res.json({ ok: true, features: ["kitchen", "kitchen-snapshot", "priority", "budget-alerts", "metrics"] });
	});

	// ---- B2 只读制片主任：observe_kitchen → 建议（绝不自动执行） ----

	app.post("/api/runs/:id/kitchen/observe", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		try {
			res.json({ observation: await producerObserve(run, ctx) });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get("/api/runs/:id/kitchen", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		res.json(await kitchenSummary(run));
	});

	// 轻量厨房快照（纯函数折叠，无 LLM/无落盘）：前端烤炉条 5s 轮询令牌呼吸用
	app.get("/api/runs/:id/kitchen/snapshot", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const pools = ctx.quota?.snapshot() ?? [];
		const jobs = activeQueueOf(run.id)?.list() ?? [];
		res.json(buildKitchenSnapshot(pools, jobs));
	});

	app.post("/api/runs/:id/kitchen/feedback", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const obsId = typeof req.body?.obsId === "string" ? req.body.obsId : "";
		const suggestionId = typeof req.body?.suggestionId === "string" ? req.body.suggestionId : "";
		const decision = req.body?.decision === "adopted" || req.body?.decision === "dismissed" ? req.body.decision : null;
		if (!obsId || !suggestionId || !decision) {
			res.status(400).json({ error: "需要 obsId / suggestionId / decision(adopted|dismissed)" });
			return;
		}
		const obs = await kitchenFeedback(run, obsId, suggestionId, decision);
		if (!obs) {
			res.status(404).json({ error: "观察记录不存在" });
			return;
		}
		res.json({ ok: true });
	});

	// B3：采纳建议 → L2 守卫校验 → 执行（defer/downgrade 真改队列；被拒率留痕）
	app.post("/api/runs/:id/kitchen/apply", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const obsId = typeof req.body?.obsId === "string" ? req.body.obsId : "";
		const suggestionId = typeof req.body?.suggestionId === "string" ? req.body.suggestionId : "";
		if (!obsId || !suggestionId) {
			res.status(400).json({ error: "需要 obsId / suggestionId" });
			return;
		}
		try {
			const result = await applySuggestion(run, ctx, obsId, suggestionId);
			if (!result) {
				res.status(404).json({ error: "观察记录或建议不存在" });
				return;
			}
			res.json({ ok: true, verdict: result.verdict });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// B4 导演契约（方向 2）：制片主任 → 导演的预算告警
	app.get("/api/runs/:id/budget-alerts", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const alerts = await readBudgetAlerts(run);
		res.json({ alerts });
	});

	// B4 导演契约（方向 1）：导演 → 制片主任的优先级指令
	app.post("/api/runs/:id/director/priority", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		try {
			const result = await applyPriorityInstruction(run, ctx, req.body);
			res.json(result);
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// B4 读路径：镜头优先级指令列表（段控状态回显用）
	app.get("/api/runs/:id/director/priority", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		res.json({ instructions: await readPriorityInstructions(run) });
	});

	// B5 A/B 度量：配额利用率 / 有效吞吐 / P0 延迟 P95 / 浪费率 / 被拒率
	app.get("/api/runs/:id/metrics", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		try {
			// 配额消耗：不传 poolId = 多池汇总（多 key 场景只看单池会漏账）
			const consumedSec = ctx.quota?.consumedSec() ?? 0;
			// 被拒率（来自 kitchen 汇总）
			const summary = await kitchenSummary(run);
			// P0 指令 + clip 完成时间（从 assets 文件 mtime 推断）
			const p0Instructions = await readPriorityInstructions(run);
			const assetsDir = path.join(run.dir, "assets");
			const p0Latencies: number[] = [];
			for (const inst of p0Instructions.filter((i) => i.priority === "P0")) {
				try {
					const stat = await fs.promises.stat(path.join(assetsDir, `clip-${inst.shotId}.mp4`));
					p0Latencies.push(stat.mtimeMs - inst.at);
				} catch {
					// clip 未完成，跳过
				}
			}
			// clip 完成数（文件存在 = 完成）+ 真实秒数（script.json 镜长求和，缺失回落 5s/镜）
			let completedCount = 0;
			const completedIds: string[] = [];
			try {
				const files = await fs.promises.readdir(assetsDir);
				completedIds.push(
					...files.filter((f) => f.startsWith("clip-") && f.endsWith(".mp4")).map((f) => f.slice(5, -4)),
				);
				completedCount = completedIds.length;
			} catch {
				// assets 目录不存在
			}
			// 尝试从 shotAttempts 推断尝试总数
			const attemptedCount = Object.keys(run.shotAttempts ?? {}).length;
			const failedCount = Math.max(0, attemptedCount - completedCount);
			let effectiveSec = completedCount * 5;
			let wastedSec = failedCount * 5;
			try {
				const script = await readArtifact<{ shots: { id: string; durationSec?: number }[] }>(run, "script.json");
				const failedIds = Object.keys(run.shotAttempts ?? {}).filter((id) => !completedIds.includes(id));
				({ effectiveSec, wastedSec } = shotSeconds(script, completedIds, failedIds));
			} catch {
				// script 缺失（老 run）保留 5s/镜近似
			}
			// 运行时长（从事件首末时间戳推断）
			const events = run.events ?? [];
			const firstAt = events.length > 0 ? Date.parse(events[0]!.at) : 0;
			const lastAt = events.length > 0 ? Date.parse(events[events.length - 1]!.at) : Date.now();
			const runDurationMs = Math.max(0, lastAt - firstAt);

			const metrics = computeRunMetrics({
				consumedSec,
				effectiveSec,
				wastedSec,
				completedCount,
				failedCount,
				rejectionRate: summary.stats.rejectionRate,
				p0Latencies,
				runDurationMs,
			} satisfies MetricsInput);
			res.json(metrics);
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get("/api/runs/:id/traces", async (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		res.json({ spans: await readTraces(run) });
	});

	// ---- BGM 管理（上传 / 试听 / 删除；重新导出时生效） ----

	const bgmUrl = (runId: string, file: string): string =>
		`/api/runs/${runId}/files/assets/${encodeURIComponent(file)}`;

	app.get("/api/runs/:id/bgm", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const file = bgmFileOf(run.dir);
		res.json(file ? { name: file, url: bgmUrl(run.id, file) } : null);
	});

	app.post("/api/runs/:id/bgm", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		const name = typeof req.body?.name === "string" ? req.body.name : "";
		const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
		const match = /^data:(audio\/(?:mpeg|mp3|wav|x-wav|mp4|x-m4a|aac|ogg|flac));base64,([A-Za-z0-9+/=\s]+)$/.exec(
			dataUrl,
		);
		if (!match) {
			res.status(400).json({ error: "仅支持 MP3/WAV/M4A/AAC/OGG/FLAC 的 base64 dataUrl" });
			return;
		}
		const buf = Buffer.from(match[2]!, "base64");
		if (buf.length === 0 || buf.length > 15 * 1024 * 1024) {
			res.status(400).json({ error: "音频需在 15MB 以内且非空" });
			return;
		}
		const ext = AUDIO_EXT[match[1]!]!;
		const assetsDir = path.join(run.dir, "assets");
		fs.mkdirSync(assetsDir, { recursive: true });
		// 单 BGM 语义：清掉其他扩展的旧文件，再写新文件
		for (const old of BGM_FILES) {
			const oldPath = path.join(assetsDir, old);
			if (old !== `bgm.${ext}`) fs.rmSync(oldPath, { force: true });
		}
		const file = `bgm.${ext}`;
		fs.writeFileSync(path.join(assetsDir, file), buf);
		res.json({ name: name.trim() || file, url: bgmUrl(run.id, file) });
	});

	app.delete("/api/runs/:id/bgm", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		for (const f of BGM_FILES) fs.rmSync(path.join(run.dir, "assets", f), { force: true });
		res.json({ ok: true });
	});

	// ---- 重新导出 / 转场表 ----

	app.post("/api/runs/:id/reexport", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		// aspectRatio 可选：指定后按该画幅重新导出（多平台分发版 final-9x16.mp4 等）
		const aspectRatio = typeof req.body?.aspectRatio === "string" ? req.body.aspectRatio : undefined;
		const result = reexportRun(ctx, run, aspectRatio);
		if (!result.ok) {
			res.status(400).json(result);
			return;
		}
		res.json({ ok: true });
	});

	app.get("/api/runs/:id/transitions", (req, res) => {
		const run = runStore.get(req.params.id);
		if (!run) {
			notFoundRun(res, req.params.id);
			return;
		}
		try {
			res.json(JSON.parse(fs.readFileSync(path.join(run.dir, "transitions.json"), "utf-8")));
		} catch {
			res.json(null);
		}
	});

	// ---- 成片（播放 / 下载） ----

	/** 成片定位：优先最近一次导出的版本（多画幅），回退主版本 final.mp4 */
	function finalPathOf(runId: string): string | null {
		const run = runStore.get(runId);
		if (!run) return null;
		const name = run.finalFile ?? "final.mp4";
		const file = path.join(run.dir, "assets", name);
		return fs.existsSync(file) ? file : null;
	}

	/**
	 * 流式发送文件。
	 * 不用 res.sendFile：send 库会对路径做 URL 解码，
	 * 含中文/全角字符的 run 目录名会被破坏导致 404（实测复现）。
	 */
	function streamFile(res: Response, file: string): void {
		const stat = fs.statSync(file);
		res.setHeader("Content-Length", String(stat.size));
		res.status(200);
		const stream = fs.createReadStream(file);
		stream.on("error", (err: NodeJS.ErrnoException) => {
			if (res.headersSent) res.destroy(err);
			else res.status(500).json({ error: `读取文件失败: ${err.message}` });
		});
		stream.pipe(res);
	}

	app.get("/api/runs/:id/video", (req, res) => {
		const file = finalPathOf(req.params.id);
		if (!file) {
			res.status(404).json({ error: "成片尚未生成" });
			return;
		}
		res.setHeader("Content-Type", "video/mp4");
		res.setHeader("Cache-Control", "no-store");
		streamFile(res, file);
	});

	app.get("/api/runs/:id/download", (req, res) => {
		const file = finalPathOf(req.params.id);
		if (!file) {
			res.status(404).json({ error: "成片尚未生成" });
			return;
		}
		// 多画幅版文件名带画幅标记（final-9x16.mp4 → ad-<runId>-9x16.mp4）
		const run = runStore.get(req.params.id);
		const aspectTag = run?.finalFile?.match(/^final-(\d+x\d+)\.mp4$/)?.[1];
		res.setHeader("Content-Type", "video/mp4");
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="ad-${req.params.id}${aspectTag ? `-${aspectTag}` : ""}.mp4"`,
		);
		streamFile(res, file);
	});

	// ---- 共创模式：创意合伙人对话 / 共创空间提炼（无 run 依赖） ----

	app.post("/api/cocreate/chat", async (req, res) => {
		const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
		const context = typeof req.body?.context === "string" ? req.body.context.trim().slice(0, 900) : "";
		const messages = raw
			.filter((m: unknown): m is { role: string; content: string } => {
				const item = m as { role?: unknown; content?: unknown };
				return (
					(item?.role === "user" || item?.role === "assistant") &&
					typeof item?.content === "string" &&
					item.content.trim().length > 0
				);
			})
			.slice(-12)
			.map((m: { role: "user" | "assistant"; content: string }) => ({
				role: m.role,
				content: m.content.trim().slice(0, 1200),
			}));
		if (messages.length === 0) {
			res.status(400).json({ error: "消息不能为空" });
			return;
		}
		try {
			const reply = await chat(ctx.llm, [
				{
					role: "system",
					content:
						"你是一支广告片的「创意合伙人」，陪用户把一个模糊的想法打磨成可开拍的设定。规则：" +
						"1) 每次回复 3-6 句中文：先接住用户想法并给判断，再给 1-2 个具体可执行的创意建议（人物形象/场景/情节钩子，要具体到画面），最后抛出一个推进创作的问题；" +
						"2) 建议必须贴合用户的品类与人群，不写放之四海皆准的空话；" +
						"3) 用户明确要求清单/方案时直接给结构化内容；" +
						"4) 不编造制作进度，不承诺未接入的能力。" +
						(context ? `\n\n【用户创作基底】${context}` : ""),
				},
				...messages,
			]);
			res.json({ reply: reply.trim().slice(0, 1500) });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/cocreate/extract", async (req, res) => {
		const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim().slice(0, 8000) : "";
		if (!transcript) {
			res.status(400).json({ error: "对话内容不能为空" });
			return;
		}
		try {
			const raw = await chatJson<{
				characters?: { name?: unknown; description?: unknown }[];
				scenes?: { name?: unknown; description?: unknown }[];
				ideas?: unknown[];
				musicBrief?: unknown;
			}>(
				ctx.llm,
				[
					"从下面的共创对话中提炼已经达成共识的设定资产（只提取双方明确认可的内容，不要自己发明新设定）：",
					transcript,
					"",
					"要求：",
					"1. characters：出场人物/拟人形象，name ≤10 字中文，description 一句中文外貌+性格+与产品的关系；",
					"2. scenes：场景设定，name ≤10 字，description 一句中文氛围+关键陈设；",
					"3. ideas：已认可的创意情节/卖点节拍，每条一句中文；",
					"4. musicBrief：若对话提到音乐氛围则一句话概括，否则为空串；",
					"5. 没有的类别给空数组。",
					'只输出 JSON: {"characters": [{"name": "…", "description": "…"}], "scenes": […], "ideas": ["…"], "musicBrief": "…"}',
				].join("\n"),
			);
			res.json({ space: coSpaceFromBody(raw) ?? null });
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// ---- 静态 UI 托管（部署形态：单容器同源服务 UI + API，2026-08-31）----
	// 本地开发仍走 vite（5200 代理 /api），此处只在 UI 构建产物存在时启用；
	// SPA 回退放在 API 路由之后、404 之前，/api/* 不被吞。
	const uiDist = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"video-agent-ui",
		"dist",
	);
	if (fs.existsSync(path.join(uiDist, "index.html"))) {
		app.use(express.static(uiDist));
		app.use((req, res, next) => {
			if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
			res.sendFile(path.join(uiDist, "index.html"));
		});
	}

	app.use((_req, res) => {
		res.status(404).json({ error: "Not Found" });
	});

	return app;
}

// ---- 启动 ----

function main() {
	const ctx = loadServerContext();
	const restored = runStore.loadAll(path.join(ctx.studioRoot, ".pi-studio", "video-agent-runs"));
	const app = createApp(ctx);
	app.listen(ctx.port, () => {
		console.log(`[video-agent-server] listening on http://localhost:${ctx.port}`);
		console.log(`[video-agent-server] restored ${restored} run(s) from disk`);
		console.log(`[video-agent-server] studio root: ${ctx.studioRoot}`);
		console.log(
			`[video-agent-server] media adapters: ${ctx.mediaConfig.media.map((a) => a.id).join(", ") || "（无）"}`,
		);
		console.log(`[video-agent-server] llm: ${ctx.llm.model} @ ${ctx.llm.url}`);
		for (const problem of ctx.mediaConfig.errors) console.warn(`[video-agent-server] config: ${problem}`);
	});
}

main();
