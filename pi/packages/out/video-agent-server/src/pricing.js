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
 *   - 整数 token 计数不可得时（多数 provider 不返回 usage），按文本构成粗估：
 *     中文 ≈ 1 token / 1.5 字符，ASCII ≈ 1 token / 4 字符（见 estimateTokenCounts）；
 *     多模态输入图按 IMAGE_TOKENS_ESTIMATE / 张 粗估。
 *   - 成本追踪（trackLlmCost / trackMediaCost）币种必须与 run.metrics.cost.currency 一致，
 *     不一致的条目跳过并告警——目录混币种时宁可少记，也不把美元加进人民币总额。
 *
 * 数据落盘：单笔计费同步进 `RunMetrics.cost.spent`，落 `run-state.json`；服务端重启可恢复累计。
 */
import * as fs from "node:fs";
import * as path from "node:path";
/** 默认兜底（catalogue 缺失时启用）。CNY；非零保守值，预算告警仍能触发。 */
const DEFAULT_FALLBACK = {
    currency: "CNY",
    perCall: 0.5,
    perInputToken: 0.0001,
    perOutputToken: 0.0003,
    perSecond: 0.8,
    perKChar: 0.05,
};
export function loadPriceCatalog(studioRoot) {
    const filePath = path.join(studioRoot, ".pi-studio", "pricing.json");
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return {
            media: raw.media ?? {},
            llm: raw.llm ?? {},
            fallback: { ...DEFAULT_FALLBACK, ...(raw.fallback ?? {}) },
            source: filePath,
        };
    }
    catch {
        // 没找到 / 损坏 → 全 fallback；不让价格配置阻塞业务
        return { media: {}, llm: {}, fallback: DEFAULT_FALLBACK, source: "<default>" };
    }
}
// ============================================================================
// 单次计费
// ============================================================================
/** 简易预估：基于文本阶段数 + 媒体阶段数 + shotCount，给出粗估 breakdown。
 *  不读取实际模型参数，仅按 catalog 默认单价计算 —— 用户可在 UI 看到大致区间。 */
export function estimateRunCost(args) {
    const { catalog, shotCount, clipDurationSec, withDesignSheets = true, redoBuffer = 0, audioDrive = "off" } = args;
    const fb = catalog.fallback;
    const lines = [];
    const push = (label, amount, note) => {
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
    if (audioDrive === "dialogue" && redoBuffer > 0) {
        // A5 台词重录级联：每次 = TTS（首录 + 精简重录各 1）+ 口型视频重生成 1 次
        const dialogueRedo = redoBuffer * (clipDurationSec * (fb.perSecond ?? 0) + 2 * (fb.perKChar ?? 0));
        push("台词重录缓冲", dialogueRedo, `约 ${redoBuffer} 次台词重录（TTS×2 + 口型重生成）`);
    }
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    return { total: round2(total), currency: fb.currency, lines };
}
/** 提案级预估（审议优化采纳前） */
export function estimateProposalCost(args) {
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
export function lookupMediaSpecIn(catalog, adapter) {
    return catalog.media[adapter.id] ?? (adapter.model ? catalog.media[adapter.model] : undefined) ?? catalog.fallback;
}
/** 通过 catalog 查 LLM 模型价格 */
export function lookupLlmSpecIn(catalog, modelName) {
    return catalog.llm[modelName] ?? catalog.fallback;
}
/** 媒体单次成本（在 catalog 上下文里调用，pipeline  入口） */
export function costOfMediaIn(catalog, adapter, params, outputSeconds = 0) {
    const spec = lookupMediaSpecIn(catalog, adapter);
    const currency = spec.currency;
    let amount = 0;
    if (adapter.kind === "video" && outputSeconds > 0 && spec.perSecond) {
        amount = spec.perSecond * outputSeconds;
    }
    else if (adapter.kind === "tts") {
        const prompt = typeof params.prompt === "string" ? params.prompt.length : 0;
        amount = (spec.perKChar ?? catalog.fallback.perKChar ?? 0) * (prompt / 1024);
        if (amount === 0 && spec.perCall)
            amount = spec.perCall;
    }
    else {
        amount = spec.perCall ?? catalog.fallback.perCall ?? 0;
    }
    return { category: "media", adapterId: adapter.id, amount, currency };
}
/** LLM 单次成本（在 catalog 上下文里调用，pipeline 入口） */
export function costOfLlmIn(catalog, modelName, promptChars, completionChars, usage) {
    const spec = lookupLlmSpecIn(catalog, modelName);
    // 1 token ≈ 4 chars（中英文混合保守估计；CJK 精估见 estimateTokenCounts）
    const CHARS_PER_TOKEN = 4;
    const inputTokens = (usage?.input_tokens ?? Math.ceil(promptChars / CHARS_PER_TOKEN)) + (usage?.images ?? 0) * IMAGE_TOKENS_ESTIMATE;
    const outputTokens = usage?.output_tokens ?? Math.ceil(completionChars / CHARS_PER_TOKEN);
    const inCost = (spec.perInputToken ?? catalog.fallback.perInputToken ?? 0) * inputTokens;
    const outCost = (spec.perOutputToken ?? catalog.fallback.perOutputToken ?? 0) * outputTokens;
    return { category: "llm", model: modelName, amount: inCost + outCost, currency: spec.currency };
}
/** 多模态输入图的粗估 token 数（640-1024px 压缩帧的典型视觉 token 量级） */
export const IMAGE_TOKENS_ESTIMATE = 800;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g;
/** 按文本构成精估 token：中文 ≈ 1 token / 1.5 字符，ASCII ≈ 1 token / 4 字符。
 *  与文件头注释约定一致；costOfLlmIn 的纯字符回退口径（/4）只作保守下界。 */
export function estimateTokenCounts(prompt, completion) {
    const cjkOf = (s) => (s.match(CJK_RE) ?? []).length;
    const tokensOf = (s) => {
        const cjk = cjkOf(s);
        return Math.ceil(cjk / 1.5 + (s.length - cjk) / 4);
    };
    return { input_tokens: tokensOf(prompt), output_tokens: tokensOf(completion) };
}
/** 币种守卫：条目币种与 run 累计币种不一致时跳过并告警，保证总额口径单一 */
function accumulateCost(run, entry, source) {
    const cost = run.metrics?.cost;
    if (!cost)
        return;
    if (entry.currency !== cost.currency) {
        console.warn(`[pricing] 跳过 ${source} 成本条目：币种 ${entry.currency} 与 run 累计币种 ${cost.currency} 不一致（金额 ${entry.amount}）`);
        return;
    }
    cost.spent = round2(cost.spent + entry.amount);
}
/** 累计本次 LLM 调用的成本。images 为多模态输入图张数（每张按 IMAGE_TOKENS_ESTIMATE 粗估）。 */
export function trackLlmCost(run, ctx, promptText, completionText, images = 0) {
    const usage = { ...estimateTokenCounts(promptText, completionText), images };
    const entry = costOfLlmIn(ctx.priceCatalog, ctx.llm.model, promptText.length, completionText.length, usage);
    accumulateCost(run, entry, `LLM(${ctx.llm.model})`);
}
/** 累计本次媒体生成的成本。outputSeconds 仅视频/音频有意义；图像/TTS 走 perCall/perKChar。 */
export function trackMediaCost(run, ctx, adapter, params, outputSeconds = 0) {
    const fake = { id: adapter.id, kind: adapter.kind, model: adapter.model ?? adapter.id };
    const entry = costOfMediaIn(ctx.priceCatalog, fake, params, outputSeconds);
    accumulateCost(run, entry, `media(${adapter.id})`);
}
export function round2(n) {
    return Math.round(n * 100) / 100;
}
export function formatCost(amount, currency) {
    const sign = currency === "CNY" ? "¥" : "$";
    if (amount < 0.01)
        return `${sign}<0.01`;
    return `${sign}${amount.toFixed(2)}`;
}
