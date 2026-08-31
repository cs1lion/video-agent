/**
 * B5 A/B 度量 —— 配额利用率 / 有效吞吐 / P0 延迟 P95 / 浪费率 / 被拒率。
 *
 * 设计报告 §3.8：度量否则就是自我感动——做 A/B（相同配额预算下比交付量）。
 * 核心指标是**配额利用率**（有效成片秒数 ÷ 消耗配额秒数），
 * 反映"花出去的配额换来了多少有效成片"。
 *
 * 纯函数：输入结构化数据 → 输出度量值，无 I/O，契约测试直接调用。
 * 服务端端点负责从各数据源（账本/队列/kitchen.ndjson/traces/assets）组装输入。
 * 数据不全的字段返回 null（降级而非阻断——B5 是辅助度量，不是产线依赖）。
 */
/** 百分位数（线性插值法；空数组返回 null） */
export function percentile(sorted, p) {
    if (sorted.length === 0)
        return null;
    if (sorted.length === 1)
        return sorted[0];
    const rank = p * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    const frac = rank - lo;
    return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * frac);
}
/** 计算 P95（95 百分位） */
export function p95(values) {
    return percentile([...values].sort((a, b) => a - b), 0.95);
}
/** 四舍五入到 3 位小数 */
function round3(n) {
    return Math.round(n * 1000) / 1000;
}
/**
 * 纯函数度量计算（设计 §3.8 五项指标）。
 * 输入由服务端组装，本函数只做数学——可被契约测试精确断言。
 */
export function computeRunMetrics(input) {
    const { consumedSec, effectiveSec, wastedSec, completedCount, failedCount, rejectionRate, p0Latencies, runDurationMs } = input;
    return {
        quotaUtilization: consumedSec > 0 ? round3(effectiveSec / consumedSec) : null,
        effectiveThroughput: runDurationMs > 0 ? round3(completedCount / (runDurationMs / 60_000)) : null,
        p0LatencyP95: p95(p0Latencies),
        wasteRate: consumedSec > 0 ? round3(wastedSec / consumedSec) : null,
        rejectionRate,
        consumedSec: Math.round(consumedSec),
        effectiveSec: Math.round(effectiveSec),
        wastedSec: Math.round(wastedSec),
        completedClips: completedCount,
        failedClips: failedCount,
    };
}
/** 完成/失败镜头的真实秒数（script.json 镜长求和；script 缺失或镜长缺省回落 5s/镜） */
export function shotSeconds(script, completedIds, failedIds) {
    const fallback = 5;
    const durOf = (id) => script?.shots.find((s) => s.id === id)?.durationSec ?? fallback;
    return {
        effectiveSec: completedIds.reduce((s, id) => s + durOf(id), 0),
        wastedSec: failedIds.reduce((s, id) => s + durOf(id), 0),
    };
}
