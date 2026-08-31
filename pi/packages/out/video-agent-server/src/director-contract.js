/**
 * 导演契约 —— 导演与制片主任之间的结构化通信协议（总文档 §3.7）。
 *
 * 双向契约：
 *   导演 → 制片主任：{ clipId, priority:"P0", qualityBar:"must_keep", maxRetries:1 }
 *   制片主任 → 导演：{ type:"budget_alert", message, suggestion, shortfall, affectedShots }
 *
 * 设计红线（设计报告 §四）：
 *   - **绝不**让 LLM 直接碰硬约束——契约字段是前端硬契约，改类型会破坏 UI；
 *   - 契约测试锁定 schema（字段名、枚举值、验证逻辑）；
 *   - 优先级指令经 L2 守卫校验后才生效（与 B3 的 defer/downgrade 同层次）。
 *
 * 本文件只含纯类型与纯函数：契约测试直接调用，无 I/O、无依赖。
 */
// ═══════════════════════════════════════════════════════════════════
// 方向 1：导演 → 制片主任（优先级指令）
// ═══════════════════════════════════════════════════════════════════
/** 优先级等级（P0 最高——导演说"这镜必须保"就是 P0） */
export const PRIORITY_LEVELS = ["P0", "P1", "P2"];
/** 质量底线（导演对镜头质量的态度，制片主任据此决定重试/降级/放弃策略） */
export const QUALITY_BARS = ["must_keep", "nice_to_have", "sacrificable"];
/** 验证 + 清洗 LLM/用户输入的优先级指令（宽松输入 → 严格输出） */
export function validatePriorityInstruction(raw) {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, reason: "指令不是对象" };
    const r = raw;
    const shotId = typeof r.shotId === "string" ? r.shotId.trim().slice(0, 80) : "";
    if (!shotId)
        return { ok: false, reason: "缺少 shotId" };
    const priority = typeof r.priority === "string" && PRIORITY_LEVELS.includes(r.priority)
        ? r.priority
        : null;
    if (!priority)
        return { ok: false, reason: `priority 必须是 ${PRIORITY_LEVELS.join(" / ")}` };
    const qualityBar = typeof r.qualityBar === "string" && QUALITY_BARS.includes(r.qualityBar)
        ? r.qualityBar
        : null;
    if (!qualityBar)
        return { ok: false, reason: `qualityBar 必须是 ${QUALITY_BARS.join(" / ")}` };
    // maxRetries：非负整数；缺省按优先级给合理默认值
    const maxRetries = typeof r.maxRetries === "number" && Number.isInteger(r.maxRetries) && r.maxRetries >= 0 && r.maxRetries <= 5
        ? r.maxRetries
        : priority === "P0"
            ? 2
            : priority === "P1"
                ? 1
                : 0;
    return { ok: true, instruction: { shotId, priority, qualityBar, maxRetries } };
}
/** 优先级等级 → 队列数值（队列排序：越低越优先，与 kitchen.ts 的 a.priority - b.priority 一致） */
export const PRIORITY_QUEUE_VALUES = {
    P0: 1,
    P1: 50,
    P2: 100,
};
/** 优先级等级 → 可读标签（UI 徽标） */
export const PRIORITY_LABELS = {
    P0: "必保",
    P1: "优先",
    P2: "常规",
};
export const QUALITY_BAR_LABELS = {
    must_keep: "必须保留",
    nice_to_have: "锦上添花",
    sacrificable: "可放弃",
};
/**
 * 构建结构化预算告警（从 clips.ts 的预算参数构建，纯函数）。
 * 制片主任的职责是给出**可操作建议**——不是报数字，是报裁剪路径。
 */
export function buildBudgetAlert(input) {
    const requiredSec = input.estimateSec * input.productionShotIds.length;
    const shortfallSec = Math.max(0, requiredSec - input.remainingSec);
    const affectedShots = input.productionShotIds.slice(input.fromIndex);
    const skipCount = affectedShots.length;
    return {
        type: "budget_alert",
        message: `视频配额不足（剩 ${Math.round(input.remainingSec)}s < 预估 ${input.estimateSec}s/镜×${input.productionShotIds.length} 镜）`,
        suggestion: skipCount > 0
            ? `建议裁剪 ${skipCount} 镜或缩短镜长，缺口约 ${Math.round(shortfallSec)}s`
            : "建议降低整体镜长或减少镜头数",
        remainingSec: Math.round(input.remainingSec),
        requiredSec: Math.round(requiredSec),
        shortfallSec: Math.round(shortfallSec),
        affectedShots,
        at: input.at ?? Date.now(),
    };
}
/** 验证预算告警结构（用于读取时校验持久化数据，防御半行损坏） */
export function validateBudgetAlert(raw) {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, reason: "告警不是对象" };
    const r = raw;
    if (r.type !== "budget_alert")
        return { ok: false, reason: "type 必须是 budget_alert" };
    const message = typeof r.message === "string" ? r.message : "";
    if (!message)
        return { ok: false, reason: "缺少 message" };
    const remainingSec = typeof r.remainingSec === "number" ? r.remainingSec : NaN;
    const requiredSec = typeof r.requiredSec === "number" ? r.requiredSec : NaN;
    const shortfallSec = typeof r.shortfallSec === "number" ? r.shortfallSec : NaN;
    const at = typeof r.at === "number" ? r.at : NaN;
    if (!Number.isFinite(remainingSec) || !Number.isFinite(requiredSec) || !Number.isFinite(shortfallSec)) {
        return { ok: false, reason: "remainingSec/requiredSec/shortfallSec 必须是数字" };
    }
    if (!Number.isFinite(at) || at <= 0)
        return { ok: false, reason: "at 必须是正数时间戳" };
    const affectedShots = Array.isArray(r.affectedShots) ? r.affectedShots.filter((s) => typeof s === "string") : [];
    return {
        ok: true,
        alert: {
            type: "budget_alert",
            message,
            suggestion: typeof r.suggestion === "string" ? r.suggestion : "",
            remainingSec: Math.round(remainingSec),
            requiredSec: Math.round(requiredSec),
            shortfallSec: Math.round(shortfallSec),
            affectedShots,
            at: Math.round(at),
        },
    };
}
// ═══════════════════════════════════════════════════════════════════
// 契约测试辅助：双向闭环的完整 schema 快照
// ═══════════════════════════════════════════════════════════════════
/** 契约常量快照（测试锁定枚举值不漂移） */
export const CONTRACT_SCHEMA = {
    priorityLevels: PRIORITY_LEVELS,
    qualityBars: QUALITY_BARS,
    priorityQueueValues: PRIORITY_QUEUE_VALUES,
};
