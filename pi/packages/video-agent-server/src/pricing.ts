/**
 * 价格与预算（P2 — MVP）。
 *
 * 三块职责：
 *   1. 价格目录：从 `.pi-studio/pricing.json`（可选）加载 media / llm / fallback 价格，
 *      未配置时回退默认估算值（绝不阻塞管线）。
 *   2. 单次调用计费：根据适配器 / 模型 + 实际用量计算本笔成本。
 *   3. 预估引擎：跑前按 brief + options 估算本次预计花费（pre-flight）。
 *
 * 设计原则：
 *   - 价格未配置 ≠ 0：当 catalog 找不到时，fallback 给一个保守的非零估算，让预算护栏仍生效。
 *   - 货币：默认 CNY；目录里每条价格自带 currency，UI 跟着显示。
 *   - 整数 token 计数不可得时（多数 provider 不返回 usage），按 1 token ≈ 1.5 中文字符 / 4 英文
 *     字符做粗估，约定文档在 `estimateLlmCost` 注释。
 *
 * 数据落盘：单笔计费同步进 `RunMetrics.cost.spent`，落 `run-state.json`；服务端重启可恢复累计。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MediaAdapterConfig } from "../../coding-agent/examples/extensions/studio/media/adapter.ts";

export type Currency = "CNY" | "USD";

/** 单条价格条目：缺失的字段按 0 计（保守起见，fallback 会补非零兜底）。 */
export interface PriceSpec {
	currency: Currency;
	/** 每次调用固定价（多数媒体生成） */
	perCall?: number;
	/** 输入 token 单价 */
	perInputToken?: number;
	/** 输出 token 单价 */
	perOutputToken?: number;
	/** 每秒视频 / 音频产出 */
	perSecond?: number;
	/** 每 1024 字符（TTS 粗估） */
	perKChar?: number;
}

export interface PriceCatalog {
	media: Record<string, PriceSpec>;
	llm: Record<string, PriceSpec>;
	/** 找不到任何条目时的兜底 */
	fallback: PriceSpec;
	/** 加载来源（debug 用） */
	source: string;
}

/** 默认兜底（catalogue 缺失时启用）。CNY；非零保守值，预算告警仍能触发。 */
const DEFAULT_FALLBACK: PriceSpec = {
	currency: "CNY",
	perCall: 0.5,
	perInputToken: 0.0001,
	perOutputToken: 0.0003,
	perSecond: 0.8,
	perKChar: 0.05,
};

/** 单笔成本明细（落 metrics 用） */
export interface CostEntry {
	category: "media" | "llm";
	adapterId?: string;
	model?: string;
	amount: number;
	currency: Currency;
}

/** 预估的阶段明细（pre-flight） */
export interface CostEstimate {
	total: number;
	currency: Currency;
	lines: { label: string; amount: number; note?: string }[];
}

// ============================================================================
// 加载
// ============================================================================

interface PriceFile {
	media?: Record<string, PriceSpec>;
	llm?: Record<string, PriceSpec>;
	fallback?: Partial<PriceSpec>;
}

export function loadPriceCatalog(studioRoot: string): PriceCatalog {
	const filePath = path.join(studioRoot, ".pi-studio", "pricing.json");
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PriceFile;
		return {
			media: raw.media ?? {},
			llm: raw.llm ?? {},
			fallback: { ...DEFAULT_FALLBACK, ...(raw.fallback ?? {}) },
			source: filePath,
		};
	} catch {
		// 没找到 / 损坏 → 全 fallback；不让价格配置阻塞业务
		return { media: {}, llm: {}, fallback: DEFAULT_FALLBACK, source: "<default>" };
	}
}

// ============================================================================
// 单次计费
// ============================================================================

/** 简易预估：基于文本阶段数 + 媒体阶段数 + shotCount，给出粗估 breakdown。
 *  不读取实际模型参数，仅按 catalog 默认单价计算 —— 用户可在 UI 看到大致区间。 */
export function estimateRunCost(args: {
	catalog: PriceCatalog;
	shotCount: number;
	clipDurationSec: number;
	/** 是否含设计稿概念图（≈shotCount 的 0.6 系数） */
	withDesignSheets?: boolean;
	/** 重做预算（镜头/旁白各算 N 次上限内的额外开销） */
	redoBuffer?: number;
}): CostEstimate {
	const { catalog, shotCount, clipDurationSec, withDesignSheets = true, redoBuffer = 0 } = args;
	const fb = catalog.fallback;
	const lines: CostEstimate["lines"] = [];
	const push = (label: string, amount: number, note?: string): void => {
		lines.push({ label, amount: round2(amount), ...(note ? { note } : {}) });
	};
	// 文本阶段（编剧 / 美术设计 / 分镜提示词 / EDL / 配音指导 / 审片 ≈ 6 次 LLM）
	const llmPerCall = (fb.perInputToken ?? 0) * 2000 + (fb.perOutputToken ?? 0) * 1500;
	push("剧本 LLM", llmPerCall, "约 2k 输入 + 1.5k 输出 token");
	push("美术设计 LLM", llmPerCall, "");
	push("分镜提示词 LLM", llmPerCall * 1.5, "按 shotCount 翻倍");
	push("EDL 转场 LLM", llmPerCall, "");
	push("配音指导 LLM", llmPerCall, "");
	push("审片多模 LLM", llmPerCall, "含抽帧多模输入");
	// 媒体：shotCount 段视频 + 关键帧 + TTS
	if (withDesignSheets) {
		const sheets = Math.ceil(shotCount * 0.6);
		push("设计稿概念图", sheets * (fb.perCall ?? 0), `${sheets} 张`);
	}
	push("分镜关键帧", shotCount * (fb.perCall ?? 0), `${shotCount} 张`);
	push("视频生成", shotCount * clipDurationSec * (fb.perSecond ?? 0), `${shotCount} 段 × ${clipDurationSec}s`);
	push("TTS 配音", shotCount * (fb.perKChar ?? 0), "每镜粗估 1k 字符");
	if (redoBuffer > 0) {
		const redo = redoBuffer * (clipDurationSec * (fb.perSecond ?? 0) + (fb.perCall ?? 0));
		push("重做缓冲", redo, `约 ${redoBuffer} 次镜头补拍`);
	}
	const total = lines.reduce((sum, l) => sum + l.amount, 0);
	return { total: round2(total), currency: fb.currency, lines };
}

/** 提案级预估（审议优化采纳前） */
export function estimateProposalCost(args: {
	catalog: PriceCatalog;
	action: "reedit" | "reshot" | "retts" | "rescript";
	clipDurationSec?: number;
}): { amount: number; note: string } {
	const fb = args.catalog.fallback;
	const dur = args.clipDurationSec ?? 5;
	switch (args.action) {
		case "reedit":
			return { amount: 0, note: "仅本地 ffmpeg，零模型成本" };
		case "reshot":
			return { amount: round2(dur * (fb.perSecond ?? 0)), note: `${dur}s 视频生成` };
		case "retts":
			return { amount: round2(fb.perKChar ?? 0), note: "≈ 1k 字符 TTS" };
		case "rescript":
			return { amount: round2((fb.perInputToken ?? 0) * 2000 + (fb.perOutputToken ?? 0) * 1500), note: "全文本重跑 LLM" };
	}
}

// ============================================================================
// 工具
// ============================================================================

/** 通过 catalog 查 media 适配器价格（id 优先，其次 model 名，最后 fallback） */
export function lookupMediaSpecIn(catalog: PriceCatalog, adapter: MediaAdapterConfig): PriceSpec {
	return catalog.media[adapter.id] ?? (adapter.model ? catalog.media[adapter.model] : undefined) ?? catalog.fallback;
}

/** 通过 catalog 查 LLM 模型价格 */
export function lookupLlmSpecIn(catalog: PriceCatalog, modelName: string): PriceSpec {
	return catalog.llm[modelName] ?? catalog.fallback;
}

/** 媒体单次成本（在 catalog 上下文里调用，pipeline  入口） */
export function costOfMediaIn(
	catalog: PriceCatalog,
	adapter: MediaAdapterConfig,
	params: Record<string, unknown>,
	outputSeconds = 0,
): CostEntry {
	const spec = lookupMediaSpecIn(catalog, adapter);
	const currency = spec.currency;
	let amount = 0;
	if (adapter.kind === "video" && outputSeconds > 0 && spec.perSecond) {
		amount = spec.perSecond * outputSeconds;
	} else if (adapter.kind === "tts") {
		const prompt = typeof params.prompt === "string" ? params.prompt.length : 0;
		amount = (spec.perKChar ?? catalog.fallback.perKChar ?? 0) * (prompt / 1024);
		if (amount === 0 && spec.perCall) amount = spec.perCall;
	} else {
		amount = spec.perCall ?? catalog.fallback.perCall ?? 0;
	}
	return { category: "media", adapterId: adapter.id, amount, currency };
}

/** LLM 单次成本（在 catalog 上下文里调用，pipeline 入口） */
export function costOfLlmIn(
	catalog: PriceCatalog,
	modelName: string,
	promptChars: number,
	completionChars: number,
	usage?: { input_tokens?: number; output_tokens?: number },
): CostEntry {
	const spec = lookupLlmSpecIn(catalog, modelName);
	// 1 token ≈ 4 chars（中英文混合保守估计）
	const CHARS_PER_TOKEN = 4;
	const inputTokens = usage?.input_tokens ?? Math.ceil(promptChars / CHARS_PER_TOKEN);
	const outputTokens = usage?.output_tokens ?? Math.ceil(completionChars / CHARS_PER_TOKEN);
	const inCost = (spec.perInputToken ?? catalog.fallback.perInputToken ?? 0) * inputTokens;
	const outCost = (spec.perOutputToken ?? catalog.fallback.perOutputToken ?? 0) * outputTokens;
	return { category: "llm", model: modelName, amount: inCost + outCost, currency: spec.currency };
}

export function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function formatCost(amount: number, currency: Currency): string {
	const sign = currency === "CNY" ? "¥" : "$";
	if (amount < 0.01) return `${sign}<0.01`;
	return `${sign}${amount.toFixed(2)}`;
}