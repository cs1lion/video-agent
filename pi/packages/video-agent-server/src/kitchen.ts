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

import type { QueueJob } from "../../coding-agent/examples/extensions/studio/media/queue.ts";
import type { PoolSnapshot } from "./quota.ts";

/** 烤炉（观察视图 = PoolSnapshot 的投影，字段名对齐 ReAct 设计 §二的 Oven） */
export interface KitchenOven {
	id: string;
	keyType: string;
	/** 绑定的媒体适配器 ID（多 key：池↔key 对应关系；未绑定的单池缺省） */
	adapterId?: string;
	/** 当前可用 RPM 令牌 */
	tokens: number;
	/** 令牌桶容量 = 每分钟最大提交数（前端令牌点渲染的分母） */
	rpmCap: number;
	/** 距下一个令牌可用的毫秒数（0 = 现在就能提交） */
	rpmWaitMs: number;
	/** 今日剩余秒数（null = 无明确配额，只受 RPM 约束） */
	remainingQuotaSec: number | null;
	/** 在途预留总秒数（已提交未结算） */
	reservedSec: number;
	/** 在途预留条数 */
	inFlight: number;
	/** 累计超支秒数 */
	overrunSec: number;
	/** 隔离截止（key 认证失效；期间不会被选池）。未隔离缺省 */
	quarantinedUntil?: number;
}

/** 排队 / 在途任务（观察视图 = QueueJob 的投影） */
export interface KitchenTask {
	/** 队列 job id（J12） */
	id: string;
	/** 产物名（clip-SH03.mp4 等，比 job id 对人可读） */
	outputName: string;
	/** 生成秒数（params.seconds；无则 null） */
	seconds: number | null;
	priority: number;
	/** 已重试次数（attempts - 1） */
	retryCount: number;
	/** 已等待毫秒（在排队时从 createdAt 起算） */
	waitingMs: number;
}

export interface KitchenFailure {
	id: string;
	outputName: string;
	reason: string;
	attempts: number;
	at: number;
}

export interface KitchenBudget {
	/** 每日总配额（null = 无明确配额） */
	totalSec: number | null;
	/** 今日剩余秒数（含在途预留的占用） */
	remainingSec: number | null;
	/** 在途预留总秒数 */
	reservedSec: number;
	/** 累计超支秒数（结算超出预留的部分） */
	overrunSec: number;
	/** 预算日（本地时区 YYYY-MM-DD） */
	day: string;
}

export interface KitchenSnapshot {
	generatedAt: number;
	ovens: KitchenOven[];
	/** 排队中（依赖已满足——管线只在依赖就绪后才提交） */
	readyTasks: KitchenTask[];
	/** 炉内在烤（running） */
	inFlightTasks: KitchenTask[];
	recentFailures: KitchenFailure[];
	budget: KitchenBudget;
}

/** 从配额池快照 + 队列任务列表折叠厨房快照（纯函数，now 注入） */
export function buildKitchenSnapshot(pools: PoolSnapshot[], jobs: QueueJob[], now: number = Date.now()): KitchenSnapshot {
	const ovens: KitchenOven[] = pools.map((p) => ({
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

	const project = (job: QueueJob): KitchenTask => ({
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
	const recentFailures: KitchenFailure[] = jobs
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
	const budget: KitchenBudget = {
		totalSec: null,
		remainingSec:
			pools.length > 0 && finitePools.length === pools.length
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

const activeQueues = new Map<string, QueueJobSource>();

/** 观察需要的队列面（真实 GenerationQueue 满足；测试给桩） */
export interface QueueJobSource {
	list(): QueueJob[];
	stats(): { queued: number; running: number; failed: number; rateLimited: number };
	/** B3 执行口（L2 守卫通过后由 producer 调用；桩可不实现） */
	defer?(jobId: string, ms: number): boolean;
	amend?(jobId: string, params: Record<string, unknown>): boolean;
	/** B4 导演契约：导演下优先级指令 → 修改排队任务优先级 */
	setPriority?(jobId: string, priority: number): boolean;
}

export function registerActiveQueue(runId: string, queue: QueueJobSource): void {
	activeQueues.set(runId, queue);
}

export function unregisterActiveQueue(runId: string): void {
	activeQueues.delete(runId);
}

export function activeQueueOf(runId: string): QueueJobSource | undefined {
	return activeQueues.get(runId);
}
