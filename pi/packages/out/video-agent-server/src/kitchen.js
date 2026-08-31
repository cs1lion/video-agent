/**
 * observe_kitchen —— B2 只读制片主任的观察层（总文档 §3.5 烤炉模型 / ReAct 设计 §三）。
 *
 * 职责：把「配额账本快照 + 活跃队列任务」折叠成一份**只含决策相关信息**的
 * 结构化快照（不塞 400 条事件——噪声会显著劣化推理质量）。纯函数、时间注入，
 * 契约测试锁定 schema（观察信息格式一变，推理质量会断崖下跌——这是设计报告
 * 点名的脆弱点）。
 *
 * 活跃队列注册表：GenerationQueue 是 run 级瞬态对象（executeStages 每轮新建），
 * 观察端点要在 run 运行中看到"炉内 + 排队"的任务，因此 run 启动时注册、
 * 结束时注销；run 间观察只能看到账本与预算（readyTasks 为空是合法状态）。
 */
/** 从配额池快照 + 队列任务列表折叠厨房快照（纯函数，now 注入） */
export function buildKitchenSnapshot(pools, jobs, now = Date.now()) {
    const ovens = pools.map((p) => ({
        id: p.id,
        keyType: p.keyType,
        ...(p.adapterId ? { adapterId: p.adapterId } : {}),
        tokens: p.rpmTokens,
        rpmCap: p.rpmCap,
        rpmWaitMs: p.rpmWaitMs,
        remainingQuotaSec: Number.isFinite(p.remainingQuotaSec) ? p.remainingQuotaSec : null,
        reservedSec: p.reservedSec,
        inFlight: p.inFlight,
        overrunSec: p.overrunSec,
        ...(p.quarantinedUntil ? { quarantinedUntil: p.quarantinedUntil } : {}),
    }));
    const project = (job) => ({
        id: job.id,
        outputName: job.relativePath.split("/").pop() ?? job.relativePath,
        seconds: typeof job.params.seconds === "string" || typeof job.params.seconds === "number" ? Number(job.params.seconds) : null,
        priority: job.priority,
        retryCount: Math.max(0, job.attempts - 1),
        waitingMs: Math.max(0, now - job.createdAt),
    });
    const readyTasks = jobs
        .filter((j) => j.status === "queued")
        .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
        .map(project);
    const inFlightTasks = jobs.filter((j) => j.status === "running").map(project);
    const recentFailures = jobs
        .filter((j) => j.status === "failed")
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(0, 5)
        .map((j) => ({
        id: j.id,
        outputName: j.relativePath.split("/").pop() ?? j.relativePath,
        reason: j.error ?? "unknown",
        attempts: j.attempts,
        at: j.finishedAt ?? j.createdAt,
    }));
    // 预算：多池下剩余 = 各池剩余之和（此前只读第一池，多 key 下漏算其余池且首池无配额时误报 null）；
    // 任一池无每日配额（Infinity）= 总量无明确上限 → null（限免期语义）。
    // PoolSnapshot 不带日配额总量——剩余/预留/超支三值已足够推理（"还剩多少"比"用了多少"更贴决策）。
    const finitePools = pools.filter((p) => Number.isFinite(p.remainingQuotaSec));
    const budget = {
        totalSec: null,
        remainingSec: pools.length > 0 && finitePools.length === pools.length
            ? Math.round(finitePools.reduce((s, p) => s + p.remainingQuotaSec, 0) * 1000) / 1000
            : null,
        reservedSec: pools.reduce((s, p) => s + p.reservedSec, 0),
        overrunSec: pools.reduce((s, p) => s + p.overrunSec, 0),
        day: new Date(now).toISOString().slice(0, 10),
    };
    return { generatedAt: now, ovens, readyTasks, inFlightTasks, recentFailures, budget };
}
// ---------------------------------------------------------------------------
// 活跃队列注册表（run 级瞬态队列 → 观察端点可达）
// ---------------------------------------------------------------------------
const activeQueues = new Map();
export function registerActiveQueue(runId, queue) {
    activeQueues.set(runId, queue);
}
export function unregisterActiveQueue(runId) {
    activeQueues.delete(runId);
}
export function activeQueueOf(runId) {
    return activeQueues.get(runId);
}
