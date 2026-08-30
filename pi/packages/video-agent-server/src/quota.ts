/**
 * 配额账本 + 多池令牌桶 —— B1 确定性底座的账本层（总文档 §3.5 烤炉模型 / §4.5 D5）。
 *
 * 解决的问题：异步生成要 40–90s 才出片，只在提交时扣配额会让并发任务同时"看到"
 * 配额充足而超额提交冲 429。因此提交前先 **预留（reserve）**、出片后按实际时长
 * **结算（settle）** 释放差额；取消/作废走 **释放（release）** 全额退还。
 * 这是异步模型的正确性要求，不是优化。
 *
 * 每个池（烤炉）两道独立闸门：
 * 1. RPM 令牌桶 —— 提交速率（Free 1 / Ent 2 / TP 5 RPM），每次提交吃 1 令牌；
 * 2. 每日时长配额 —— TokenPlan 500s/天 硬顶；`dailyQuotaSec: null` 表示无明确配额
 *    （只受 RPM 约束）。
 *
 * 确定性约定：所有时间相关方法接受注入的 `now`（缺省 Date.now()），
 * 无定时器、无 I/O，可被纯单元测试精确断言（见 test/quota.test.ts）。
 */

export type KeyType = "free" | "enterprise" | "tokenplan";

/** 池（烤炉）规格：提交时静态给定 */
export interface PoolSpec {
	/** 池标识，如 "tp-1" / "ent-1" */
	id: string;
	keyType: KeyType;
	/** 令牌桶容量 = 每分钟最大提交数（按分钟匀速补充） */
	rpmCap: number;
	/** 每日时长配额（秒）；null = 无明确配额 */
	dailyQuotaSec: number | null;
	/**
	 * 绑定的媒体适配器 ID（= models.json media 条目，含真实 key）。
	 * **账本与执行的桥梁**：选池后提交时把任务投给该 adapter，
	 * 才能把"多 key 记账"落到"多 key 真实并发"。缺省 = 不绑定，走默认 adapter 解析。
	 */
	adapterId?: string;
}

/** 池快照（B2 observe_kitchen 的观察对象，决策相关信息而非全量事件） */
export interface PoolSnapshot {
	id: string;
	keyType: KeyType;
	/** 绑定的媒体适配器 ID（未绑定则缺省，供代理/运维看到"池 ↔ key"对应关系） */
	adapterId?: string;
	/** 令牌桶容量 = 每分钟最大提交数 */
	rpmCap: number;
	/** 当前可用 RPM 令牌（已按 now 补充） */
	rpmTokens: number;
	/** 距下一个 RPM 令牌可用的毫秒数（0 = 现在就能提交） */
	rpmWaitMs: number;
	/** 今日剩余秒数（无配额池为 Infinity） */
	remainingQuotaSec: number;
	/** 在途预留总秒数（已提交未结算） */
	reservedSec: number;
	/** 在途预留条数 */
	inFlight: number;
	/** 累计超支秒数（结算超出预留的部分，预算告警依据） */
	overrunSec: number;
}

export type ReserveRejectReason = "unknown_pool" | "invalid" | "rpm_exhausted" | "insufficient_quota";

export type ReserveResult =
	| {
			ok: true;
			reservationId: string;
			reservedSec: number;
			/** 命中幂等键、未重复扣减 */
			reused: boolean;
			/** 本次预留落在哪个池（多 key 并发下提交时要用同池绑定的 adapter） */
			poolId: string;
			/** 该池绑定的媒体适配器（未绑定则为 undefined，提交时走默认解析） */
			adapterId?: string;
	  }
	| { ok: false; reason: ReserveRejectReason };

export type SettleResult =
	| { settled: true; /** 退还的预留差额（秒） */ releasedSec: number; /** 超出预留的实耗（秒） */ overrunSec: number }
	| { settled: false; reason: "unknown" | "already_finalized" };

export type ReleaseResult =
	| { released: true; refundedSec: number }
	| { released: false; reason: "unknown" | "already_finalized" };

type ReservationStatus = "active" | "settled" | "released";

interface Reservation {
	id: string;
	poolId: string;
	reservedSec: number;
	createdAt: number;
	status: ReservationStatus;
	/** 提交方给的幂等键（回写，便于终态时清理映射） */
	idempotencyKey?: string;
}

interface PoolState {
	spec: PoolSpec;
	bucket: TokenBucket;
	remainingQuotaSec: number;
	overrunSec: number;
}

/** 浮点比较容差（令牌按毫秒速率补充，累计有舍入误差） */
const EPS = 1e-9;

function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}

function dayKeyOf(now: number): string {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 标准令牌桶：容量封顶，按速率匀速补充，惰性结算（访问时按 now 补发）。
 * 纯内存、无定时器——"实时衰减"由调用方传入的 now 驱动。
 */
export class TokenBucket {
	readonly capacity: number;
	private readonly ratePerMs: number;
	private tokensNow: number;
	private lastRefillAt: number;

	constructor(capacity: number, ratePerMs: number, startAt: number) {
		this.capacity = capacity;
		this.ratePerMs = ratePerMs;
		this.tokensNow = capacity;
		this.lastRefillAt = startAt;
	}

	private refill(now: number): void {
		if (now > this.lastRefillAt) {
			this.tokensNow = Math.min(this.capacity, this.tokensNow + (now - this.lastRefillAt) * this.ratePerMs);
			this.lastRefillAt = now;
		}
	}

	/** 当前可用令牌数（先补充到 now） */
	available(now: number): number {
		this.refill(now);
		return this.tokensNow;
	}

	/** 尝试取走 count 个令牌；不足则不动状态并返回 false */
	tryTake(count: number, now: number): boolean {
		this.refill(now);
		if (this.tokensNow + EPS < count) return false;
		this.tokensNow -= count;
		return true;
	}

	/** 距 count 个令牌可用还需多少毫秒（0 = 已够；速率为 0 则永不满足） */
	msUntil(count: number, now: number): number {
		this.refill(now);
		if (this.tokensNow + EPS >= count) return 0;
		if (this.ratePerMs <= 0) return Number.POSITIVE_INFINITY;
		return Math.ceil((count - this.tokensNow) / this.ratePerMs);
	}
}

/**
 * 多池配额账本。线程模型：单进程内同步调用（Node 事件循环单线程），
 * 竞态窗口只在"异步等待期间状态被并发请求读取"——这正是 reserve 存在的理由：
 * 扣减发生在提交前的同步段，出片后的异步回调只做结算。
 */
export class QuotaLedger {
	private pools = new Map<string, PoolState>();
	private reservations = new Map<string, Reservation>();
	/** 幂等键 → 预留 id。只保护在途预留：终态后键即释放（允许重做时复用键名） */
	private idempotency = new Map<string, string>();
	private dayKey: string;
	private nextReservation = 1;

	constructor(pools: PoolSpec[], initialNow: number = Date.now()) {
		for (const spec of pools) {
			if (this.pools.has(spec.id)) throw new Error(`池 id 重复：${spec.id}`);
			if (!(spec.rpmCap > 0)) throw new Error(`池 ${spec.id} 的 rpmCap 必须 > 0`);
			this.pools.set(spec.id, {
				spec,
				bucket: new TokenBucket(spec.rpmCap, spec.rpmCap / 60_000, initialNow),
				remainingQuotaSec: spec.dailyQuotaSec ?? Number.POSITIVE_INFINITY,
				overrunSec: 0,
			});
		}
		this.dayKey = dayKeyOf(initialNow);
	}

	/** 当前账本日（本地时区），跨日首访自动换日并重置每日配额 */
	get day(): string {
		return this.dayKey;
	}

	/** 池今日剩余秒数；未知池返回 null（无配额池为 Infinity）。传 now 时先按该时钟跨日滚动 */
	remainingSec(poolId: string, now?: number): number | null {
		if (now !== undefined) this.rollToDay(now);
		const pool = this.pools.get(poolId);
		return pool ? pool.remainingQuotaSec : null;
	}

	/** B5 度量：已消耗配额秒数 = dailyQuota - remaining（null = 无配额池/Infinity 池） */
	/**
	 * 已消耗秒数。**多池下不传 poolId 则汇总全部池**（多 key 场景的账面消耗；
	 * 此前硬编码单池 id，配了 POOLS 后统计会直接失效）。
	 * 无每日配额的池不参与汇总（限免期无从谈"已消耗/上限"），全部无配额时返回 null。
	 */
	consumedSec(poolId?: string, now: number = Date.now()): number | null {
		this.rollToDay(now);
		if (poolId !== undefined) {
			const pool = this.pools.get(poolId);
			if (!pool) return null;
			const daily = pool.spec.dailyQuotaSec;
			if (daily === null || !Number.isFinite(daily)) return null;
			return Math.max(0, Math.round(daily - pool.remainingQuotaSec));
		}
		let total: number | null = null;
		for (const pool of this.pools.values()) {
			const daily = pool.spec.dailyQuotaSec;
			if (daily === null || !Number.isFinite(daily)) continue;
			total = (total ?? 0) + Math.max(0, Math.round(daily - pool.remainingQuotaSec));
		}
		return total;
	}

	/**
	 * 提交前预留（D5）。同步完成两闸校验 + 扣减：
	 * 1. 幂等键命中在途预留 → 原样返回（重复提交不再扣减）；
	 * 2. 时长配额不足 → `insufficient_quota`（先于 RPM 校验，拒绝不吃令牌）；
	 * 3. RPM 令牌不足 → `rpm_exhausted`。
	 */
	reserve(poolId: string, estimatedSec: number, opts: { idempotencyKey?: string; now?: number } = {}): ReserveResult {
		const now = opts.now ?? Date.now();
		this.rollToDay(now);
		const pool = this.pools.get(poolId);
		if (!pool) return { ok: false, reason: "unknown_pool" };
		if (!Number.isFinite(estimatedSec) || estimatedSec <= 0) return { ok: false, reason: "invalid" };

		if (opts.idempotencyKey !== undefined) {
			const existingId = this.idempotency.get(opts.idempotencyKey);
			if (existingId) {
				const existing = this.reservations.get(existingId);
				if (existing && existing.status === "active") {
					return {
						ok: true,
						reservationId: existing.id,
						reservedSec: existing.reservedSec,
						reused: true,
						poolId: existing.poolId,
						adapterId: this.pools.get(existing.poolId)?.spec.adapterId,
					};
				}
				this.idempotency.delete(opts.idempotencyKey);
			}
		}

		if (pool.remainingQuotaSec + EPS < estimatedSec) return { ok: false, reason: "insufficient_quota" };
		if (!pool.bucket.tryTake(1, now)) return { ok: false, reason: "rpm_exhausted" };

		pool.remainingQuotaSec -= estimatedSec;
		const id = `R${this.nextReservation++}`;
		const reservation: Reservation = {
			id,
			poolId,
			reservedSec: estimatedSec,
			createdAt: now,
			status: "active",
			idempotencyKey: opts.idempotencyKey,
		};
		this.reservations.set(id, reservation);
		if (opts.idempotencyKey !== undefined) this.idempotency.set(opts.idempotencyKey, id);
		return { ok: true, reservationId: id, reservedSec: estimatedSec, reused: false, poolId, adapterId: pool.spec.adapterId };
	}

	/**
	 * 出片后按实际时长结算：多退（退还预留差额）、少补（超支继续扣，
	 * 扣到 0 为止，缺口记入 overrunSec 供预算告警）。
	 * 结果回收可能重复送达（轮询 + webhook），终态后重入为无副作用 no-op。
	 */
	settle(reservationId: string, actualSec: number, opts: { now?: number } = {}): SettleResult {
		const now = opts.now ?? Date.now();
		this.rollToDay(now);
		const reservation = this.reservations.get(reservationId);
		if (!reservation) return { settled: false, reason: "unknown" };
		if (reservation.status !== "active") return { settled: false, reason: "already_finalized" };
		const pool = this.pools.get(reservation.poolId)!;
		reservation.status = "settled";
		this.clearIdempotency(reservation);

		// 非法实际时长（探测失败等）按"预留全额消耗"保守结算——宁可少退不可多退
		const actual = Number.isFinite(actualSec) && actualSec >= 0 ? actualSec : reservation.reservedSec;
		const diff = reservation.reservedSec - actual;
		if (diff >= 0) {
			this.credit(pool, diff);
			return { settled: true, releasedSec: diff, overrunSec: 0 };
		}
		const overrun = -diff;
		const consumed = Math.min(overrun, pool.remainingQuotaSec);
		pool.remainingQuotaSec -= consumed;
		pool.overrunSec += overrun;
		return { settled: true, releasedSec: 0, overrunSec: overrun };
	}

	/**
	 * 释放预留（提交前取消 / 作废且供应商未消耗配额）：全额退还。
	 * 注意失败重试若供应商已消耗配额，应走 `settle(id, 实际消耗)` 而非 release。
	 */
	release(reservationId: string, opts: { now?: number } = {}): ReleaseResult {
		const now = opts.now ?? Date.now();
		this.rollToDay(now);
		const reservation = this.reservations.get(reservationId);
		if (!reservation) return { released: false, reason: "unknown" };
		if (reservation.status !== "active") return { released: false, reason: "already_finalized" };
		const pool = this.pools.get(reservation.poolId)!;
		reservation.status = "released";
		this.clearIdempotency(reservation);
		this.credit(pool, reservation.reservedSec);
		return { released: true, refundedSec: reservation.reservedSec };
	}

	/** 全池快照（B2 观察 / 运维面板；顺序与注册顺序一致） */
	snapshot(now: number = Date.now()): PoolSnapshot[] {
		this.rollToDay(now);
		return [...this.pools.values()].map((pool) => {
			let reservedSec = 0;
			let inFlight = 0;
			for (const reservation of this.reservations.values()) {
				if (reservation.poolId === pool.spec.id && reservation.status === "active") {
					reservedSec += reservation.reservedSec;
					inFlight += 1;
				}
			}
			return {
				id: pool.spec.id,
				keyType: pool.spec.keyType,
				...(pool.spec.adapterId ? { adapterId: pool.spec.adapterId } : {}),
				rpmCap: pool.spec.rpmCap,
				rpmTokens: round3(pool.bucket.available(now)),
				rpmWaitMs: pool.bucket.msUntil(1, now),
				remainingQuotaSec: round3(pool.remainingQuotaSec),
				reservedSec: round3(reservedSec),
				inFlight,
				overrunSec: round3(pool.overrunSec),
			};
		});
	}

	/**
	 * 选池（确定性，供 L2 守卫层使用）：**多 key 并发提交的核心决策点**。
	 *
	 * 2026-08-29 事实更正：**每个 key 的限流是各自独立的**（早期按官方 FAQ 记录的
	 * "同类型 key 共享限流池"已由郭煜实测证伪）。因此**一个池 = 一个 key 的额度视图**，
	 * N 个 key 配成 N 个池，总提交速率 = 各池 RPM 之和（可线性叠加）。
	 *
	 * 这里只做"当前哪个池能立刻提交"的确定性判断，不做价值权衡——
	 * 后者属于 L3（ReAct 代理）的职责，遵守"代理有建议权，代码有否决权"的分层。
	 *
	 * 策略：过滤出「有令牌 且 剩余额度够」的池，取**最早可用**（rpmWaitMs 最小）的；
	 * 平局取剩余令牌更多的（给后续并发留余量）。全部不可用返回 null（调用方应等待而非违规提交）。
	 */
	pickPool(estimatedSec: number, now: number = Date.now()): string | null {
		const ready = this.snapshot(now)
			.filter((p) => p.rpmTokens >= 1 && p.remainingQuotaSec >= estimatedSec)
			.sort((a, b) => a.rpmWaitMs - b.rpmWaitMs || b.rpmTokens - a.rpmTokens);
		return ready.length > 0 ? ready[0]!.id : null;
	}

	/** 池 ID 列表（注册顺序），便于配置校验与运维展示 */
	poolIds(): string[] {
		return [...this.pools.keys()];
	}

	// ---------------------------------------------------------------- internal

	/** 退还额度：受每日上限封顶（跨日结算不得把新一天的配额充爆） */
	private credit(pool: PoolState, sec: number): void {
		if (sec <= 0) return;
		const cap = pool.spec.dailyQuotaSec ?? Number.POSITIVE_INFINITY;
		pool.remainingQuotaSec = Math.min(pool.remainingQuotaSec + sec, cap);
	}

	/** 跨日：重置每池今日剩余（在途预留保留，其结算/释放计入新的一天） */
	private rollToDay(now: number): void {
		const key = dayKeyOf(now);
		if (key === this.dayKey) return;
		this.dayKey = key;
		for (const pool of this.pools.values()) {
			pool.remainingQuotaSec = pool.spec.dailyQuotaSec ?? Number.POSITIVE_INFINITY;
		}
	}

	private clearIdempotency(reservation: Reservation): void {
		if (reservation.idempotencyKey !== undefined && this.idempotency.get(reservation.idempotencyKey) === reservation.id) {
			this.idempotency.delete(reservation.idempotencyKey);
		}
	}
}
