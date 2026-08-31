/**
 * L2 守卫 —— B3 自动执行的确定性否决层（总文档 4.4 / ReAct 设计 §四）。
 *
 * 职责边界（整个设计里最不能妥协的一条）：**绝不让 LLM 直接碰硬约束**。
 * L3（制片主任）有建议权，L2（本文件）有否决权：校验决策是否违反硬约束
 * ——任务存在性、烤炉存在性、剩余配额、RPM 令牌、决策冷却期——违规即拒绝
 * 并附原因（"决策被拒率"常驻监控：持续偏高说明观察信息不足或提示词有问题）。
 *
 * 纯函数：快照 + 近期决策 + now 全部注入，可被契约测试精确断言。
 * 执行细节（发 HTTP/退避/幂等）属 L1，由 GenerationQueue + QuotaLedger 承担。
 */
const EXECUTABLE = ["submit", "defer", "downgrade", "escalate", "signal", "wait"];
/** L2 校验一条建议。ok = 可交执行层；否则拒绝（安全默认 = 什么都不做，排队继续）。 */
export function guardSuggestion(s, world) {
    if (!EXECUTABLE.includes(s.type)) {
        return { ok: false, reason: "unknown_task", detail: `未知建议类型 ${String(s.type)}` };
    }
    // 无硬约束的动作：上报/催办/观望直接放行
    if (s.type === "escalate" || s.type === "signal" || s.type === "wait") {
        return checkCooldown(s, world);
    }
    // submit / defer / downgrade 都依赖一个真实存在的排队任务
    const { snapshot } = world;
    const active = world.snapshot.readyTasks.find((t) => t.id === s.taskId) ?? snapshot.inFlightTasks.find((t) => t.id === s.taskId);
    if (!active)
        return { ok: false, reason: "unknown_task", detail: `任务 ${s.taskId ?? "?"} 不在排队/在途清单中` };
    const queued = snapshot.readyTasks.some((t) => t.id === s.taskId);
    if (!queued && s.type !== "submit") {
        // defer/amend 只对排队任务生效（在途任务已发出，改不动）
        return { ok: false, reason: "task_not_queued", detail: `任务 ${s.taskId} 在途，${s.type} 只对排队任务生效` };
    }
    const cooldown = checkCooldown(s, world);
    if (!cooldown.ok)
        return cooldown;
    if (s.type === "submit") {
        const oven = snapshot.ovens.find((o) => o.id === s.ovenId);
        if (!s.ovenId || !oven)
            return { ok: false, reason: "unknown_oven", detail: `烤炉 ${s.ovenId ?? "?"} 不存在` };
        if (oven.tokens < 1)
            return { ok: false, reason: "rpm_exhausted", detail: `烤炉 ${oven.id} 当前无可用 RPM 令牌` };
        const need = active.seconds ?? 0;
        if (oven.remainingQuotaSec !== null && need > 0 && oven.remainingQuotaSec < need) {
            return { ok: false, reason: "insufficient_quota", detail: `烤炉 ${oven.id} 剩余 ${oven.remainingQuotaSec}s < 任务需 ${need}s` };
        }
        return { ok: true };
    }
    if (s.type === "downgrade") {
        if (!Number.isFinite(s.targetSeconds) || s.targetSeconds <= 0 || s.targetSeconds >= (active.seconds ?? Infinity)) {
            return {
                ok: false,
                reason: "invalid_target_seconds",
                detail: `降级目标 ${s.targetSeconds}s 必须为正且小于当前 ${active.seconds ?? "?"}s`,
            };
        }
        return { ok: true };
    }
    // defer
    if (!Number.isFinite(s.deferMs) || s.deferMs <= 0) {
        return { ok: false, reason: "invalid_defer_ms", detail: `defer 时长非法：${s.deferMs}` };
    }
    return { ok: true };
}
function checkCooldown(s, world) {
    const dup = world.recentDecisions.some((d) => d.type === s.type && (d.taskId ?? "") === (s.taskId ?? "") && world.now - d.at < world.cooldownMs);
    if (dup) {
        return { ok: false, reason: "cooldown", detail: `同任务同类决策 ${Math.round(world.cooldownMs / 1000)}s 内已执行过（防抖动）` };
    }
    return { ok: true };
}
/** 决策被拒率（设计 §九：常驻监控，持续偏高 = 观察信息不足或提示词有问题） */
export function rejectionRate(applied, rejected) {
    const total = applied + rejected;
    return total > 0 ? Math.round((rejected / total) * 1000) / 1000 : null;
}
