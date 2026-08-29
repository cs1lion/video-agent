/**
 * 配额账本 + 多池令牌桶行为测试 —— B1 确定性底座的回归锁。
 *
 * 全部用例注入确定性时钟（`now`），无定时器、无 I/O：
 * 账本是异步模型的正确性部件（D5 reserve/settle），这里锁住的每一条
 * 都是将来接线到生成队列后"不违规（零超额 429）、不丢任务"的前提。
 *
 * 核心用例（变异验证的目标）：
 *   「D5 竞态回归锁」——两个并发预留不许都"看到"配额充足；
 *   「终态重入保护」——结果回收重复送达（轮询 + webhook）不许双份退钱；
 *   「守恒不变量」——任意操作序列终态后，账目 = 日配额 − 实际消耗。
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { loadQuotaLedger } from "../src/config.ts";
import { QuotaLedger, TokenBucket, type PoolSpec } from "../src/quota.ts";

/** 固定基准时钟，跨日用例在其上加偏移 */
const T0 = new Date("2026-08-29T10:00:00").getTime();
const MIN = 60_000;
const HOUR = 3_600_000;

function close(actual: number, expected: number, eps = 1e-6): void {
	assert.ok(Math.abs(actual - expected) <= eps, `期望 ${expected}，实际 ${actual}`);
}

function makeLedger(now = T0): QuotaLedger {
	return new QuotaLedger(
		[
			{ id: "tp-1", keyType: "tokenplan", rpmCap: 5, dailyQuotaSec: 500 },
			{ id: "ent-1", keyType: "enterprise", rpmCap: 2, dailyQuotaSec: null },
			{ id: "free-1", keyType: "free", rpmCap: 1, dailyQuotaSec: null },
		],
		now,
	);
}

function reserveOk(ledger: QuotaLedger, poolId: string, sec: number, opts: { idempotencyKey?: string; now?: number } = {}): string {
	const r = ledger.reserve(poolId, sec, opts);
	assert.ok(r.ok, `预留应成功，实际：${JSON.stringify(r)}`);
	return r.reservationId;
}

describe("令牌桶（TokenBucket）", () => {
	it("满桶启动：容量内放行，耗尽后拒绝且不预支", () => {
		const bucket = new TokenBucket(2, 2 / MIN, T0);
		assert.equal(bucket.tryTake(1, T0), true);
		assert.equal(bucket.tryTake(1, T0), true);
		assert.equal(bucket.tryTake(1, T0), false, "第 3 次应被拒绝");
		close(bucket.available(T0), 0);
	});

	it("按速率匀速补充，且不超过容量", () => {
		const bucket = new TokenBucket(2, 2 / MIN, T0);
		assert.equal(bucket.tryTake(2, T0), true);
		// 2 RPM → 30s 补 1 个
		assert.equal(bucket.tryTake(1, T0 + 30_000), true);
		assert.equal(bucket.tryTake(1, T0 + 30_000), false);
		// 闲置再久也不超过容量
		close(bucket.available(T0 + 10 * HOUR), 2);
	});

	it("msUntil 给出下一令牌等待时长", () => {
		const bucket = new TokenBucket(1, 1 / MIN, T0);
		assert.equal(bucket.msUntil(1, T0), 0);
		assert.equal(bucket.tryTake(1, T0), true);
		assert.equal(bucket.msUntil(1, T0), MIN, "1 RPM 空桶应等 60s");
		close(bucket.msUntil(1, T0 + 30_000), 30_000, 1);
	});
});

describe("配额账本（QuotaLedger）· 预留与闸门", () => {
	it("成功预留：扣减今日剩余并计入在途快照", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 100, { now: T0 });
		assert.match(id, /^R\d+$/);
		close(ledger.remainingSec("tp-1")!, 400);
		const pool = ledger.snapshot(T0).find((p) => p.id === "tp-1")!;
		assert.equal(pool.inFlight, 1);
		close(pool.reservedSec, 100);
	});

	it("拒绝：未知池与非法预估时长（0 / 负数 / NaN）", () => {
		const ledger = makeLedger();
		assert.deepEqual(ledger.reserve("no-such", 10, { now: T0 }), { ok: false, reason: "unknown_pool" });
		assert.deepEqual(ledger.reserve("tp-1", 0, { now: T0 }), { ok: false, reason: "invalid" });
		assert.deepEqual(ledger.reserve("tp-1", -5, { now: T0 }), { ok: false, reason: "invalid" });
		assert.deepEqual(ledger.reserve("tp-1", Number.NaN, { now: T0 }), { ok: false, reason: "invalid" });
		close(ledger.remainingSec("tp-1")!, 500, 0);
	});

	it("D5 竞态回归锁：并发预留不许都看到配额充足", () => {
		const ledger = makeLedger();
		// 500s 配额：两个"同时"各要 300s 的任务，只许一个通过
		reserveOk(ledger, "tp-1", 300, { now: T0 });
		const second = ledger.reserve("tp-1", 300, { now: T0 });
		assert.deepEqual(second, { ok: false, reason: "insufficient_quota" });
		close(ledger.remainingSec("tp-1")!, 200);
	});

	it("RPM 闸门：配额充足但令牌耗尽 → rpm_exhausted，等一分钟恢复", () => {
		const ledger = new QuotaLedger([{ id: "s-1", keyType: "free", rpmCap: 1, dailyQuotaSec: 1000 }], T0);
		reserveOk(ledger, "s-1", 10, { now: T0 });
		const blocked = ledger.reserve("s-1", 10, { now: T0 });
		assert.deepEqual(blocked, { ok: false, reason: "rpm_exhausted" });
		const pool = ledger.snapshot(T0)[0]!;
		close(pool.rpmTokens, 0);
		assert.ok(pool.rpmWaitMs > 0 && pool.rpmWaitMs <= MIN, `等待应在 (0, 60s]，实际 ${pool.rpmWaitMs}`);
		reserveOk(ledger, "s-1", 10, { now: T0 + MIN });
	});

	it("配额不足被拒不消耗 RPM 令牌（校验顺序）", () => {
		const ledger = new QuotaLedger([{ id: "s-1", keyType: "free", rpmCap: 1, dailyQuotaSec: 100 }], T0);
		assert.deepEqual(ledger.reserve("s-1", 200, { now: T0 }), { ok: false, reason: "insufficient_quota" });
		// 若上面误吃了唯一的令牌，这里会 rpm_exhausted
		reserveOk(ledger, "s-1", 50, { now: T0 });
	});

	it("幂等键：重复提交返回同一预留且不重复扣减", () => {
		const ledger = makeLedger();
		const first = reserveOk(ledger, "tp-1", 100, { idempotencyKey: "run1:shot01", now: T0 });
		const dup = ledger.reserve("tp-1", 100, { idempotencyKey: "run1:shot01", now: T0 });
		assert.ok(dup.ok);
		assert.equal(dup.reservationId, first);
		assert.equal(dup.reused, true);
		close(ledger.remainingSec("tp-1")!, 400, 0);
	});

	it("幂等键在终态后释放，允许重做复用键名", () => {
		const ledger = makeLedger();
		const first = reserveOk(ledger, "tp-1", 100, { idempotencyKey: "run1:shot01", now: T0 });
		ledger.settle(first, 100, { now: T0 + MIN });
		const again = ledger.reserve("tp-1", 100, { idempotencyKey: "run1:shot01", now: T0 + MIN });
		assert.ok(again.ok);
		assert.notEqual(again.reservationId, first, "重做应是新预留");
		assert.equal(again.reused, false);
	});
});

describe("配额账本（QuotaLedger）· 结算与释放", () => {
	it("结算退还差额：实际短于预留 → 剩余回升", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 100, { now: T0 });
		const r = ledger.settle(id, 80, { now: T0 + MIN });
		assert.deepEqual(r, { settled: true, releasedSec: 20, overrunSec: 0 });
		close(ledger.remainingSec("tp-1")!, 420);
	});

	it("结算超支：实际长于预留 → 继续扣减并记 overrun", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 60, { now: T0 });
		close(ledger.remainingSec("tp-1")!, 440);
		const r = ledger.settle(id, 75, { now: T0 + MIN });
		assert.deepEqual(r, { settled: true, releasedSec: 0, overrunSec: 15 });
		close(ledger.remainingSec("tp-1")!, 425);
	});

	it("超支不把账本扣成负数：缺口只记入 overrun", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 500, { now: T0 });
		const r = ledger.settle(id, 520, { now: T0 + MIN });
		assert.deepEqual(r, { settled: true, releasedSec: 0, overrunSec: 20 });
		close(ledger.remainingSec("tp-1")!, 0);
		assert.equal(ledger.snapshot(T0 + MIN)[0]!.overrunSec, 20);
	});

	it("非法实际时长（探测失败）按预留全额消耗保守结算", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 100, { now: T0 });
		const r = ledger.settle(id, Number.NaN, { now: T0 + MIN });
		assert.deepEqual(r, { settled: true, releasedSec: 0, overrunSec: 0 });
		close(ledger.remainingSec("tp-1")!, 400);
	});

	it("终态重入保护：双份结果回收不许重复退钱", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 100, { now: T0 });
		ledger.settle(id, 80, { now: T0 + MIN });
		close(ledger.remainingSec("tp-1")!, 420);
		// 轮询与 webhook 都送到了同一份结果
		assert.deepEqual(ledger.settle(id, 80, { now: T0 + MIN }), { settled: false, reason: "already_finalized" });
		assert.deepEqual(ledger.release(id, { now: T0 + MIN }), { released: false, reason: "already_finalized" });
		close(ledger.remainingSec("tp-1")!, 420, 0);
	});

	it("release 全额退还；释放后不可再结算", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 100, { now: T0 });
		assert.deepEqual(ledger.release(id, { now: T0 }), { released: true, refundedSec: 100 });
		close(ledger.remainingSec("tp-1")!, 500);
		assert.deepEqual(ledger.settle(id, 50, { now: T0 }), { settled: false, reason: "already_finalized" });
		assert.deepEqual(ledger.release(id, { now: T0 }), { released: false, reason: "already_finalized" });
	});

	it("未知预留 id：settle / release 均明确拒绝", () => {
		const ledger = makeLedger();
		assert.deepEqual(ledger.settle("R999", 10, { now: T0 }), { settled: false, reason: "unknown" });
		assert.deepEqual(ledger.release("R999", { now: T0 }), { released: false, reason: "unknown" });
	});

	it("无时长配额池（dailyQuotaSec=null）只受 RPM 约束", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "ent-1", 100_000, { now: T0 });
		assert.equal(ledger.remainingSec("ent-1"), Number.POSITIVE_INFINITY);
		ledger.settle(id, 100_000, { now: T0 + MIN });
		assert.equal(ledger.remainingSec("ent-1"), Number.POSITIVE_INFINITY);
	});

	it("守恒不变量：任意操作序列全部终态后，剩余 = 日配额 − 实际消耗", () => {
		const ledger = makeLedger();
		const r1 = reserveOk(ledger, "tp-1", 120, { now: T0 });
		const r2 = reserveOk(ledger, "tp-1", 180, { now: T0 });
		ledger.release(r1, { now: T0 }); // 取消：全退
		ledger.settle(r2, 150, { now: T0 + MIN }); // 实耗 150
		const r3 = reserveOk(ledger, "tp-1", 200, { now: T0 + MIN });
		ledger.settle(r3, 200, { now: T0 + 2 * MIN }); // 实耗 200
		close(ledger.remainingSec("tp-1")!, 500 - 150 - 200);
		const pool = ledger.snapshot(T0 + 2 * MIN)[0]!;
		assert.equal(pool.inFlight, 0);
		close(pool.reservedSec, 0);
	});
});

describe("配额账本（QuotaLedger）· 跨日", () => {
	it("跨日重置每日配额；在途预留存活并可在新的一天结算", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 300, { now: T0 });
		close(ledger.remainingSec("tp-1")!, 200);
		const nextDay = T0 + 25 * HOUR;
		close(ledger.remainingSec("tp-1", nextDay)!, 500, 0);
		assert.equal(ledger.snapshot(nextDay)[0]!.inFlight, 1, "跨日在途预留应存活");
		// 跨日任务在新的一天结算：退还计入新日（受日上限封顶）
		ledger.settle(id, 300, { now: nextDay });
		close(ledger.remainingSec("tp-1")!, 500, 0);
	});

	it("跨日释放不得把新的一天充爆（退还受日上限封顶）", () => {
		const ledger = makeLedger();
		const id = reserveOk(ledger, "tp-1", 300, { now: T0 });
		const nextDay = T0 + 25 * HOUR;
		// 新的一天已重置为 500，若无封顶释放 300 会变成 800
		ledger.release(id, { now: nextDay });
		close(ledger.remainingSec("tp-1")!, 500, 0);
	});
});

describe("loadQuotaLedger 环境变量与 keyType 语义（限时免费场景）", () => {
	const KEYS = [
		"VIDEO_AGENT_QUOTA_DAILY_SEC",
		"VIDEO_AGENT_QUOTA_RPM",
		"VIDEO_AGENT_QUOTA_KEY_TYPE",
	] as const;
	type Key = (typeof KEYS)[number];
	const HINT = "VIDEO_AGENT_SILENCE_QUOTA_HINT";
	const saved = new Map<string, string | undefined>(
		[...KEYS, HINT].map((k) => [k, process.env[k]]),
	);
	// 静音运营提示，避免"未设环境变量"用例的 console.warn 污染测试输出
	process.env[HINT] = "1";

	after(() => {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	function setEnv(vars: Partial<Record<Key, string>>): void {
		for (const k of KEYS) {
			if (vars[k] === undefined) delete process.env[k];
			else process.env[k] = vars[k];
		}
	}

	/**
	 * 核心回归锁：**「有无每日时长配额」与「Key 层级」是两个正交维度**。
	 * 早期实现 `dailyQuotaSec === null ? "free" : "tokenplan"` 把两者混为一谈——
	 * 视频模型限时免费（设 DAILY_SEC=0）时，会把企业版池（RPM 2）误标成
	 * free（官方 RPM 1），让 ReAct 代理低估该池能力、做出次优调度。
	 */
	it("DAILY_SEC=0（无每日配额）→ keyType 仍按企业版，不得误判为 free", () => {
		setEnv({ VIDEO_AGENT_QUOTA_DAILY_SEC: "0" });
		const pool = loadQuotaLedger().snapshot(T0)[0]!;
		assert.equal(pool.remainingQuotaSec, Number.POSITIVE_INFINITY, "0 应表示无每日秒数上限");
		assert.equal(pool.keyType, "enterprise", "无时长配额 ≠ free：企业版 RPM=2，误标会让代理低估该池");
		assert.equal(pool.rpmTokens, 2, "RPM 令牌桶仍按企业版 2/分钟");
	});

	it("不设环境变量 → 保守默认 500s/天 + tokenplan + 2RPM", () => {
		setEnv({});
		const pool = loadQuotaLedger().snapshot(T0)[0]!;
		assert.equal(pool.remainingQuotaSec, 500);
		assert.equal(pool.keyType, "tokenplan");
	});

	it("显式 KEY_TYPE 优先于按配额推断", () => {
		setEnv({ VIDEO_AGENT_QUOTA_DAILY_SEC: "0", VIDEO_AGENT_QUOTA_KEY_TYPE: "free" });
		assert.equal(loadQuotaLedger().snapshot(T0)[0]!.keyType, "free");
	});

	it("非法 KEY_TYPE 回落推断逻辑，不崩溃", () => {
		setEnv({ VIDEO_AGENT_QUOTA_DAILY_SEC: "0", VIDEO_AGENT_QUOTA_KEY_TYPE: "bogus" });
		assert.equal(loadQuotaLedger().snapshot(T0)[0]!.keyType, "enterprise");
	});

	it("RPM 可覆盖（限时免费下 RPM 才是真实瓶颈）", () => {
		setEnv({ VIDEO_AGENT_QUOTA_DAILY_SEC: "0", VIDEO_AGENT_QUOTA_RPM: "5" });
		assert.equal(loadQuotaLedger().snapshot(T0)[0]!.rpmTokens, 5);
	});
});

describe("多池并发：每个 key 限流独立 → RPM 线性叠加", () => {
	/**
	 * 2026-08-29 事实更正（郭煜实测）：**每个 key 的限流是各自独立的**，
	 * 早期按官方 FAQ 记录的"同类型 key 共享限流池、多 key 不扩容"已证伪。
	 * 因此架构上「一个池 = 一个 key 的额度视图」，N 个 key 就是 N 个池，
	 * 总提交速率 = 各池 RPM 之和 —— 这是本次并发优化的全部收益来源。
	 */

	/** 反复「选池 → 预留」直到选不到池，返回成功次数 */
	function drain(ledger: QuotaLedger, sec: number, now: number): number {
		let ok = 0;
		for (let i = 0; i < 50; i += 1) {
			const poolId = ledger.pickPool(sec, now);
			if (poolId === null) break;
			const r = ledger.reserve(poolId, sec, { idempotencyKey: `d-${i}`, now });
			if (!r.ok) break;
			ok += 1;
		}
		return ok;
	}

	it("核心收益：3 池 × 2RPM 可并发 6 次，单池对照只有 2 次", () => {
		const spec = (id: string): PoolSpec => ({
			id,
			keyType: "enterprise",
			rpmCap: 2,
			dailyQuotaSec: null,
		});
		const multi = new QuotaLedger([spec("k1"), spec("k2"), spec("k3")], T0);
		const single = new QuotaLedger([spec("only")], T0);

		assert.equal(drain(multi, 5, T0), 6, "3 个 key 应能并发 6 次（RPM 叠加）");
		assert.equal(drain(single, 5, T0), 2, "单 key 对照组只有 2 次");
	});

	it("选池策略：跳过令牌耗尽的池，选当前可用的", () => {
		const busy: PoolSpec = { id: "busy", keyType: "enterprise", rpmCap: 1, dailyQuotaSec: null };
		const free: PoolSpec = { id: "free", keyType: "enterprise", rpmCap: 1, dailyQuotaSec: null };
		const ledger = new QuotaLedger([busy, free], T0);

		// 手动吃光 busy 的令牌
		const first = ledger.reserve("busy", 5, { idempotencyKey: "eat", now: T0 });
		assert.ok(first.ok);
		assert.equal(ledger.pickPool(5, T0), "free", "busy 令牌耗尽后应改选 free");
	});

	it("选池策略：都能用时取剩余令牌更多的池（给并发留余量）", () => {
		const big: PoolSpec = { id: "big", keyType: "tokenplan", rpmCap: 5, dailyQuotaSec: null };
		const small: PoolSpec = { id: "small", keyType: "enterprise", rpmCap: 1, dailyQuotaSec: null };
		const ledger = new QuotaLedger([small, big], T0);
		assert.equal(ledger.pickPool(5, T0), "big");
	});

	it("选池策略：额度不足的池被排除（哪怕它令牌充足）", () => {
		const poor: PoolSpec = { id: "poor", keyType: "enterprise", rpmCap: 5, dailyQuotaSec: 3 };
		const rich: PoolSpec = { id: "rich", keyType: "enterprise", rpmCap: 1, dailyQuotaSec: 100 };
		const ledger = new QuotaLedger([poor, rich], T0);
		assert.equal(ledger.pickPool(10, T0), "rich", "poor 只剩 3s，不够 10s 应被跳过");
	});

	it("全部池不可用时 pickPool 返回 null（调用方应等待而非违规提交）", () => {
		const spec: PoolSpec = { id: "k1", keyType: "enterprise", rpmCap: 1, dailyQuotaSec: null };
		const ledger = new QuotaLedger([spec], T0);
		assert.ok(ledger.reserve("k1", 5, { idempotencyKey: "x", now: T0 }).ok);
		assert.equal(ledger.pickPool(5, T0), null);
	});
});

describe("多池配置解析（VIDEO_AGENT_QUOTA_POOLS）", () => {
	const KEYS = ["VIDEO_AGENT_QUOTA_POOLS", "VIDEO_AGENT_QUOTA_DAILY_SEC"] as const;
	const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
	process.env.VIDEO_AGENT_SILENCE_QUOTA_HINT = "1";

	after(() => {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	function setPools(json: string | undefined): void {
		if (json === undefined) delete process.env.VIDEO_AGENT_QUOTA_POOLS;
		else process.env.VIDEO_AGENT_QUOTA_POOLS = json;
	}

	it("合法多池配置 → 每个 key 一个池，RPM 叠加", () => {
		setPools(
			JSON.stringify([
				{ id: "k1", keyType: "enterprise", rpmCap: 2 },
				{ id: "k2", keyType: "enterprise", rpmCap: 2 },
			]),
		);
		const snap = loadQuotaLedger().snapshot(T0);
		assert.deepEqual(
			snap.map((p) => p.id),
			["k1", "k2"],
		);
		assert.deepEqual(
			snap.map((p) => p.rpmTokens),
			[2, 2],
			"两个 key 各自 2 RPM，合计 4",
		);
	});

	it("未设 POOLS → 回退单池（向后兼容既有环境变量）", () => {
		setPools(undefined);
		process.env.VIDEO_AGENT_QUOTA_DAILY_SEC = "0";
		const snap = loadQuotaLedger().snapshot(T0);
		assert.equal(snap.length, 1);
		assert.equal(snap[0]!.id, "video");
	});

	it("非法配置一律整份丢弃并回退单池（不允许带病上线）", () => {
		for (const bad of [
			"{not json}",
			"[]",
			'[{"id":"k1","keyType":"bogus","rpmCap":2}]',
			'[{"id":"k1","keyType":"enterprise","rpmCap":0}]',
			'[{"id":"a","keyType":"enterprise","rpmCap":2},{"id":"a","keyType":"free","rpmCap":1}]',
		]) {
			setPools(bad);
			const snap = loadQuotaLedger().snapshot(T0);
			assert.equal(snap.length, 1, `配置 ${bad} 应回退单池`);
			assert.equal(snap[0]!.id, "video");
		}
	});

	it("dailyQuotaSec 缺省即无每日配额（限时免费场景）", () => {
		setPools(JSON.stringify([{ id: "k1", keyType: "enterprise", rpmCap: 2 }]));
		const snap = loadQuotaLedger().snapshot(T0);
		assert.equal(snap[0]!.remainingQuotaSec, Number.POSITIVE_INFINITY);
	});
});
