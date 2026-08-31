/**
 * 制片主任（Producer）—— B2 只读观察者（总文档 4.4 / ReAct 设计 §五-§八）。
 *
 * 职责边界（B2 阶段最不能妥协的一条）：**只观察、只建议、绝不执行**。
 * observe → LLM 权衡 → 结构化建议 → 团队频道（D4：走 ev 通道，复用既有 UI）→
 * 用户采纳/忽略留痕（建议采纳率可度量 = B2 验收标准）。
 * submit/defer/downgrade 等动作在 B3 才接 L2 守卫执行；本文件不碰队列。
 *
 * 降级路径（设计 §八）：LLM 不可用/输出非法 → 不抛错，落一条空建议 + 说明，
 * 产线（确定性队列）完全不受影响。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { chat, tryParseJson } from "./llm.ts";
import { pushEvent } from "./pipeline.ts";
import { buildKitchenSnapshot, activeQueueOf } from "./kitchen.ts";
import { guardSuggestion, rejectionRate } from "./guard.ts";
import { validatePriorityInstruction, validateBudgetAlert, PRIORITY_QUEUE_VALUES, PRIORITY_LABELS, } from "./director-contract.ts";
const KITCHEN_NDJSON = "kitchen.ndjson";
/** 建议类型白名单（ReAct 设计 §六；B3 起经 L2 守卫后可执行） */
export const SUGGESTION_TYPES = ["submit", "defer", "downgrade", "escalate", "signal", "wait"];
/** 决策冷却期（设计 §七：同一任务 N 秒内不改变分配，防代理抖动） */
export const DECISION_COOLDOWN_MS = 60_000;
/** 制片主任的系统提示（角色契约：只管资源与进度，不碰创作判断） */
export function producerSystemPrompt() {
    return [
        "你是视频生成管线的制片主任（Producer），只负责资源与进度：配额账本、并发仲裁、优先级排序、进度汇报。",
        "你收到一份厨房快照（烤炉/配额/排队任务/在途任务/近期失败/预算）。基于它做多维权衡：",
        "高价值低成本的任务必须保；重试次数多且低价值的任务建议降级或放弃（沉没成本）；",
        "预算吃紧时提前上报（escalate）而不是硬撞限流；排队任务按优先级与等待时间排序提交。",
        "只输出建议，你不能执行任何动作。输出 JSON：",
        '{"suggestions":[{"type":"submit|defer|downgrade|escalate|signal|wait","taskId":"J12","ovenId":"video","message":"一句话建议","reason":"推理理由"}],"reasoning":"整体权衡说明"}',
        "没有值得建议的事项时输出空 suggestions 数组。不要发明快照里不存在的任务或烤炉 id。",
    ].join("\n");
}
/** 观察消息（快照 JSON + run 上下文；契约测试锁定必含字段） */
export function producerMessages(snapshot, context) {
    const user = [
        `片名/一句话：${context.logline}`,
        `阶段状态：${context.stages}`,
        `厨房快照（${new Date(snapshot.generatedAt).toISOString()}）：`,
        JSON.stringify(snapshot, null, 2),
    ].join("\n");
    return [
        { role: "system", content: producerSystemPrompt() },
        { role: "user", content: user },
    ];
}
/** 校验并清洗 LLM 建议（白名单外类型 / 缺 message 的条目丢弃——守卫前置到观察层） */
export function sanitizeSuggestions(raw, obsId) {
    const reasoning = typeof raw.reasoning === "string" ? raw.reasoning.slice(0, 2000) : "";
    const suggestions = [];
    for (const item of Array.isArray(raw.suggestions) ? raw.suggestions : []) {
        const type = typeof item.type === "string" && SUGGESTION_TYPES.includes(item.type) ? item.type : null;
        const message = typeof item.message === "string" && item.message.trim() ? item.message.trim().slice(0, 300) : null;
        if (!type || !message)
            continue;
        suggestions.push({
            id: `${obsId}-s${suggestions.length + 1}`,
            type,
            taskId: typeof item.taskId === "string" ? item.taskId.slice(0, 80) : undefined,
            ovenId: typeof item.ovenId === "string" ? item.ovenId.slice(0, 40) : undefined,
            targetSeconds: typeof item.targetSeconds === "number" && Number.isFinite(item.targetSeconds) ? item.targetSeconds : undefined,
            deferMs: typeof item.deferMs === "number" && Number.isFinite(item.deferMs) ? item.deferMs : undefined,
            message,
            reason: typeof item.reason === "string" ? item.reason.slice(0, 600) : "",
        });
    }
    return { suggestions, reasoning };
}
/** 追加一条观察（kitchen.ndjson，append-only；坏行容忍读取） */
async function appendObservation(run, obs) {
    await fs.promises.appendFile(path.join(run.dir, KITCHEN_NDJSON), `${JSON.stringify(obs)}\n`, "utf-8");
}
/** 读 kitchen.ndjson（坏行跳过；文件缺失 = 无观察） */
export async function readObservations(run) {
    try {
        const raw = await fs.promises.readFile(path.join(run.dir, KITCHEN_NDJSON), "utf-8");
        return raw
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((o) => o !== null);
    }
    catch {
        return [];
    }
}
/**
 * 观察一轮：快照 → LLM → 建议 → 落盘 + 团队频道（D4）。绝不改队列/账本状态。
 * trigger：触发来源标注（"手动" / "auto:任务失败" / "auto:配额阈值"）——
 * B1② 事件驱动触发用（首次 429 / 配额阈值越线各一次，防 LLM 费用失控）。
 */
export async function producerObserve(run, ctx, opts) {
    const pools = ctx.quota?.snapshot() ?? [];
    const queue = activeQueueOf(run.id);
    const jobs = queue?.list() ?? [];
    const snapshot = buildKitchenSnapshot(pools, jobs);
    const obsId = `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const stageLine = run.stages.map((s) => `${s.id}:${s.status}`).join(" ");
    let suggestions = [];
    let reasoning = "";
    try {
        const raw = await chat(ctx.llm, producerMessages(snapshot, { logline: run.brief?.creative?.logline ?? "", stages: stageLine }), run.abort?.signal);
        const parsed = tryParseJson(raw);
        if (parsed === undefined)
            throw new Error(`LLM 输出非法 JSON：${raw.slice(0, 120)}`);
        const clean = sanitizeSuggestions(parsed, obsId);
        suggestions = clean.suggestions;
        reasoning = clean.reasoning;
    }
    catch (error) {
        // 降级：LLM 不可用不是产线故障——落盘说明，观察记录留痕
        reasoning = `观察降级：LLM 调用失败（${error instanceof Error ? error.message : String(error)}）。确定性队列不受影响。`;
    }
    const obs = { id: obsId, runId: run.id, at: new Date().toISOString(), snapshot, suggestions, reasoning };
    await appendObservation(run, obs);
    // D4：制片主任决策走团队频道（ev 通道），用户在频道里直接看到调度理由
    const head = suggestions.length > 0 ? suggestions.map((s) => s.message).join("；") : "厨房正常，无需调整。";
    const tag = opts?.trigger ? `（${opts.trigger}）` : "";
    pushEvent(run, "producer", "client", "status", `制片主任观察${tag}：${head}${reasoning ? `（${reasoning.slice(0, 120)}）` : ""}`);
    return obs;
}
/** 用户对建议的反馈留痕（B2 验收：建议采纳率可度量） */
export async function kitchenFeedback(run, obsId, suggestionId, decision) {
    const observations = await readObservations(run);
    const obs = observations.find((o) => o.id === obsId);
    if (!obs)
        return null;
    obs.feedback = [...(obs.feedback ?? []).filter((f) => f.id !== suggestionId), { id: suggestionId, decision, at: new Date().toISOString() }];
    // 全量重写（文件小、低频操作；坏行在读取时已剔除）
    await fs.promises.writeFile(path.join(run.dir, KITCHEN_NDJSON), `${observations.map((o) => JSON.stringify(o)).join("\n")}\n`, "utf-8");
    return obs;
}
/** 汇总：观察列表 + 采纳率 + 执行/被拒率（B3：决策被拒率常驻监控） */
export async function kitchenSummary(run) {
    const observations = await readObservations(run);
    let adopted = 0;
    let dismissed = 0;
    let applied = 0;
    let rejected = 0;
    for (const o of observations) {
        for (const f of o.feedback ?? []) {
            if (f.decision === "adopted")
                adopted += 1;
            else
                dismissed += 1;
        }
        for (const e of o.executions ?? []) {
            if (e.status === "applied")
                applied += 1;
            else
                rejected += 1;
        }
    }
    const total = adopted + dismissed;
    return {
        observations,
        stats: {
            total,
            adopted,
            dismissed,
            adoptionRate: total > 0 ? Math.round((adopted / total) * 1000) / 1000 : null,
            applied,
            rejected,
            rejectionRate: rejectionRate(applied, rejected),
        },
    };
}
/**
 * B3：采纳一条建议 → **L2 守卫校验 → 执行 → 留痕**。
 * 守卫用**实时状态**（当前账本快照 + 活跃队列），不是观察时的旧快照——
 * 配额与队列瞬息万变，旧数据会做出违规决策。被拒也是有效留痕（被拒率监控）。
 * 单池现状下的 submit 语义：队列自动泵已覆盖提交本身，执行 = 确认放行；
 * defer/downgrade 直接改队列；escalate/signal/wait = 频道播报。
 */
export async function applySuggestion(run, ctx, obsId, suggestionId) {
    const observations = await readObservations(run);
    const obs = observations.find((o) => o.id === obsId);
    if (!obs)
        return null;
    const s = obs.suggestions.find((x) => x.id === suggestionId);
    if (!s)
        return null;
    // 实时厨房状态
    const pools = ctx.quota?.snapshot() ?? [];
    const queue = activeQueueOf(run.id);
    const snapshot = buildKitchenSnapshot(pools, queue?.list() ?? []);
    const recentDecisions = observations.flatMap((o) => (o.executions ?? []).map((e) => ({ type: e.type, taskId: e.taskId, at: Date.parse(e.at) })));
    const spec = {
        type: s.type,
        taskId: s.taskId,
        ovenId: s.ovenId,
        targetSeconds: s.targetSeconds,
        deferMs: s.deferMs,
    };
    const verdict = guardSuggestion(spec, {
        snapshot,
        recentDecisions,
        cooldownMs: DECISION_COOLDOWN_MS,
        now: Date.now(),
    });
    let execution;
    if (verdict.ok) {
        const at = new Date().toISOString();
        if (s.type === "escalate" || s.type === "signal" || s.type === "wait") {
            execution = { id: s.id, type: s.type, taskId: s.taskId, status: "applied", detail: "频道播报", at };
            pushEvent(run, "producer", "client", "status", `制片主任${s.type === "escalate" ? "上报" : s.type === "signal" ? "催办" : "提醒"}：${s.message}`);
        }
        else if (s.type === "submit") {
            // 单池自动调度：队列本就按优先级泵任务，L2 通过 = 确认放行（多池手动投递是 B3+ 多烤炉的事）
            execution = { id: s.id, type: s.type, taskId: s.taskId, status: "applied", detail: "队列自动调度已覆盖（单池）", at };
        }
        else if (s.type === "defer") {
            const ok = queue?.defer?.(s.taskId, s.deferMs ?? 60_000) ?? false;
            execution = ok
                ? { id: s.id, type: s.type, taskId: s.taskId, status: "applied", detail: `已推迟 ${Math.round((s.deferMs ?? 0) / 1000)}s`, at }
                : { id: s.id, type: s.type, taskId: s.taskId, status: "rejected", detail: "队列不可达或任务不在排队态", at };
        }
        else {
            // downgrade
            const ok = queue?.amend?.(s.taskId, { seconds: String(s.targetSeconds) }) ?? false;
            execution = ok
                ? { id: s.id, type: s.type, taskId: s.taskId, status: "applied", detail: `已降级为 ${s.targetSeconds}s`, at }
                : { id: s.id, type: s.type, taskId: s.taskId, status: "rejected", detail: "队列不可达或任务不在排队态", at };
        }
    }
    else {
        execution = { id: s.id, type: s.type, taskId: s.taskId, status: "rejected", detail: `L2 守卫拒绝（${verdict.reason}）：${verdict.detail}`, at: new Date().toISOString() };
    }
    obs.executions = [...(obs.executions ?? []).filter((e) => e.id !== s.id), execution];
    await fs.promises.writeFile(path.join(run.dir, KITCHEN_NDJSON), `${observations.map((o) => JSON.stringify(o)).join("\n")}\n`, "utf-8");
    pushEvent(run, "producer", "client", "redo", execution.status === "applied" ? `建议已执行：${s.message}（${execution.detail}）` : `建议被守卫否决：${s.message}（${execution.detail}）`);
    return { observation: obs, verdict };
}
// ============================================================================
// B4 导演契约：预算告警读取 + 优先级指令应用
// ============================================================================
const BUDGET_ALERTS_NDJSON = "budget-alerts.ndjson";
/** 读 budget-alerts.ndjson（坏行跳过，与 readObservations 同策略；文件缺失 = 无告警） */
export async function readBudgetAlerts(run) {
    try {
        const raw = await fs.promises.readFile(path.join(run.dir, BUDGET_ALERTS_NDJSON), "utf-8");
        return raw
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .map((raw) => validateBudgetAlert(raw))
            .filter((r) => r?.ok === true)
            .map((r) => r.alert);
    }
    catch {
        return [];
    }
}
/**
 * B4 导演契约（方向 1）：导演下优先级指令 → 校验 → 按镜头 id 找排队任务 → 改优先级。
 * 镜头 id（SH01）映射到队列 job：relativePath 含 shotId（"assets/clip-SH01.mp4"）。
 * 只改 queued 任务（running 已发出）；找不到匹配任务也不抛错——可能是已派发或已完成。
 */
export async function applyPriorityInstruction(run, ctx, rawInstruction) {
    const v = validatePriorityInstruction(rawInstruction);
    if (!v.ok)
        return { ok: false, detail: v.reason };
    const instruction = v.instruction;
    const queue = activeQueueOf(run.id);
    const jobs = queue?.list() ?? [];
    const match = jobs.find((j) => j.relativePath.includes(instruction.shotId));
    if (!match) {
        pushEvent(run, "director", "client", "status", `优先级指令：镜头 ${instruction.shotId} 标记为 ${PRIORITY_LABELS[instruction.priority]}，但当前无对应排队任务（已派发或已完成）`);
        return { ok: false, detail: `未找到镜头 ${instruction.shotId} 的排队任务`, instruction };
    }
    const ok = queue?.setPriority?.(match.id, PRIORITY_QUEUE_VALUES[instruction.priority]) ?? false;
    if (!ok) {
        return { ok: false, detail: `镜头 ${instruction.shotId} 对应任务不在排队态（可能正在执行）`, instruction };
    }
    // B5：持久化优先级指令（P0 延迟 P95 度量的输入：指令时间 → 完成时间）
    try {
        fs.promises.appendFile(path.join(run.dir, "priority-instructions.ndjson"), `${JSON.stringify({ ...instruction, jobId: match.id, at: Date.now() })}\n`, "utf-8");
    }
    catch {
        // 持久化失败不影响管线
    }
    pushEvent(run, "director", "producer", "status", `优先级指令：镜头 ${instruction.shotId} → ${PRIORITY_LABELS[instruction.priority]}（质量底线 ${instruction.qualityBar}，上限重试 ${instruction.maxRetries} 次）`);
    pushEvent(run, "producer", "client", "status", `制片主任已收到导演优先级指令：${instruction.shotId} 调整为 ${PRIORITY_LABELS[instruction.priority]}`);
    return { ok: true, detail: `已将 ${instruction.shotId} 优先级设为 ${instruction.priority}`, instruction };
}
/** 读 priority-instructions.ndjson（B5 P0 延迟度量的输入） */
export async function readPriorityInstructions(run) {
    try {
        const raw = await fs.promises.readFile(path.join(run.dir, "priority-instructions.ndjson"), "utf-8");
        return raw
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((v) => v !== null);
    }
    catch {
        return [];
    }
}
