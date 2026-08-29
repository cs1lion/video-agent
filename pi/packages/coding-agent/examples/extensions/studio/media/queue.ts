/**
 * Generation queue — serializes media model calls with per-adapter
 * concurrency limits (video models are usually rate-limited), retries failed
 * jobs, and lets callers await completion with progress callbacks.
 *
 * The producer role steers ordering via `priority`; lower values run first.
 * Concurrency defaults come from the adapter config / models.json `defaults`,
 * and can be tuned at runtime through `setConcurrency`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MediaKind } from "../core/types.ts";
import {
	fileExtensionFor,
	isRetryableError,
	type MediaAdapter,
	type MediaAdapterConfig,
	MediaHttpError,
	type MediaModelsFile,
	resolveAdapterFor,
	retryDelayMsFromError,
} from "./adapter.ts";
import { createCustomHttpAdapter } from "./custom-http.ts";
import { createOpenAICompatibleAdapter } from "./openai-compatible.ts";

export type QueueJobStatus = "queued" | "running" | "done" | "failed";

/** One recorded execution attempt of a job (tracking). */
export interface QueueJobAttempt {
	attempt: number;
	startedAt: number;
	finishedAt: number;
	/** Error that failed the attempt, if any. */
	error?: string;
	/** Whether the error was classified transient (rate limit / busy / network). */
	retryable?: boolean;
	/** Advised backoff before the next attempt, in ms (Retry-After or backoff). */
	retryInMs?: number;
}

export interface QueueJob {
	id: string;
	adapterId: string;
	kind: MediaKind;
	prompt: string;
	params: Record<string, unknown>;
	/** Path relative to the project dir (what callers store in artifacts). */
	relativePath: string;
	priority: number;
	status: QueueJobStatus;
	attempts: number;
	maxAttempts: number;
	error?: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Time the job waited in queue before its first attempt (ms). */
	queuedMs?: number;
	/** Per-attempt history (oldest first; tracking for the producer/lead). */
	attemptLog: QueueJobAttempt[];
	/** Absolute path of the generated file (set on success). */
	filePath?: string;
	/** Provider URL of the generated media (set when the adapter reports one). */
	metaUrl?: string;
}

/** Aggregate queue statistics (tracking). */
export interface QueueStats {
	submitted: number;
	done: number;
	failed: number;
	/** Retried attempts, i.e. attempts beyond the first per job. */
	retries: number;
	/** Attempts that hit HTTP 429 rate limiting. */
	rateLimited: number;
	queued: number;
	running: number;
	adapters: Record<
		string,
		{
			id: string;
			done: number;
			failed: number;
			retries: number;
			rateLimited: number;
			/** Average successful generation duration in ms. */
			avgDurationMs: number;
			/** Current effective concurrency limit (reduced while throttled). */
			limit: number;
			/** Remaining throttle cooldown in ms, when the adapter is throttled. */
			throttledForMs?: number;
		}
	>;
}

export interface SubmitInput {
	roleName: string;
	kind: MediaKind;
	prompt: string;
	params?: Record<string, unknown>;
	/** File name (without extension) under the project assets dir. */
	outputName: string;
	priority?: number;
}

export class MediaQueueError extends Error {}

const adapterCache = new Map<string, MediaAdapter>();

function adapterFor(config: MediaAdapterConfig): MediaAdapter {
	let adapter = adapterCache.get(config.id);
	if (!adapter) {
		adapter = config.type === "custom-http" ? createCustomHttpAdapter(config) : createOpenAICompatibleAdapter(config);
		adapterCache.set(config.id, adapter);
	}
	return adapter;
}

// Retry policy: exponential backoff with jitter, capped. A server-advised
// Retry-After always wins over the computed backoff.
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60_000;
/** Cooldown before an adapter's concurrency is restored after a 429. */
const THROTTLE_COOLDOWN_MS = 60_000;
const THROTTLE_COOLDOWN_MAX_MS = 300_000;
const DEFAULT_GLOBAL_CONCURRENCY = 8;

interface AdapterStats {
	done: number;
	failed: number;
	retries: number;
	rateLimited: number;
	durationTotalMs: number;
}

interface ThrottleState {
	/** Effective concurrency while throttled. */
	limit: number;
	/** Timestamp after which the configured limit is restored. */
	until: number;
	cooldownMs: number;
}

function backoffDelayMs(attempt: number): number {
	const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
	return exp + Math.floor(Math.random() * RETRY_BASE_MS);
}

export class GenerationQueue {
	private config: MediaModelsFile | undefined;
	private jobs = new Map<string, QueueJob>();
	private running = new Set<string>();
	private concurrencyOverrides = new Map<string, number>();
	private waiters = new Map<string, Set<(job: QueueJob) => void>>();
	private updateListeners = new Map<string, Set<(job: QueueJob) => void>>();
	/** Global job-update listeners (heartbeats for the session runner). */
	private globalListeners = new Set<(job: QueueJob) => void>();
	private nextJobId = 1;
	private submitted = 0;
	private adapterStats = new Map<string, AdapterStats>();
	private throttled = new Map<string, ThrottleState>();
	/** Per-adapter next allowed submission timestamp (minIntervalMs spacing). */
	private nextFireAt = new Map<string, number>();
	/** Safety pump: guarantees queued jobs are reconsidered periodically. */
	private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	/** B3 defer：排队任务的"不早于"时间戳（到点后 pump 正常放行） */
	private deferredUntil = new Map<string, number>();
	/** B3 defer 重泵需要 projectDir；pump/submit 时记录最近一次 */
	private lastProjectDir?: string;

	constructor(config?: MediaModelsFile) {
		this.config = config;
	}

	setConfig(config: MediaModelsFile | undefined): void {
		this.config = config;
		adapterCache.clear();
	}

	/** Producer adjusts an adapter's in-flight limit at runtime. */
	setConcurrency(adapterId: string, limit: number): void {
		if (!Number.isInteger(limit) || limit < 1) throw new MediaQueueError("并发上限必须 ≥ 1");
		this.concurrencyOverrides.set(adapterId, limit);
		this.throttled.delete(adapterId);
	}

	getJob(id: string): QueueJob | undefined {
		return this.jobs.get(id);
	}

	/**
	 * B3 执行口（L3 建议 → L2 守卫通过后调用）：把排队任务推迟到 notBefore。
	 * 只对 queued 任务生效（running/done 不可延）；到期后自动重泵。
	 * 返回是否生效。这是"让出高价值池给更紧急任务"的执行原语。
	 */
	defer(jobId: string, ms: number): boolean {
		const job = this.jobs.get(jobId);
		if (!job || job.status !== "queued" || !(ms > 0)) return false;
		this.deferredUntil.set(jobId, Date.now() + Math.min(ms, 15 * 60_000));
		if (this.lastProjectDir) {
			const dir = this.lastProjectDir;
			setTimeout(() => this.pump(dir), Math.min(ms, 15 * 60_000) + 50);
		}
		return true;
	}

	/**
	 * B3 执行口：修订排队任务参数（降级：如 seconds "10"→"5"，直接降低配额消耗）。
	 * 只对 queued 任务生效；running/done 返回 false。与既有重试机制正交。
	 */
	amend(jobId: string, params: Record<string, unknown>): boolean {
		const job = this.jobs.get(jobId);
		if (!job || job.status !== "queued") return false;
		job.params = { ...job.params, ...params };
		return true;
	}

	/**
	 * Subscribe to every job update (any status transition). The session
	 * runner uses this as an activity heartbeat so long media generations
	 * don't trip its inactivity watchdog.
	 */
	onJobUpdate(listener: (job: QueueJob) => void): () => void {
		this.globalListeners.add(listener);
		return () => {
			this.globalListeners.delete(listener);
		};
	}

	list(): QueueJob[] {
		return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	counts(): { queued: number; running: number; done: number; failed: number } {
		const counts = { queued: 0, running: 0, done: 0, failed: 0 };
		for (const job of this.jobs.values()) counts[job.status]++;
		return counts;
	}

	/** Aggregate tracking statistics, per adapter and overall. */
	stats(): QueueStats {
		const counts = this.counts();
		const adapters: QueueStats["adapters"] = {};
		for (const [id, stats] of this.adapterStats) {
			const throttle = this.throttled.get(id);
			const throttledForMs = throttle ? Math.max(0, throttle.until - Date.now()) : undefined;
			adapters[id] = {
				id,
				done: stats.done,
				failed: stats.failed,
				retries: stats.retries,
				rateLimited: stats.rateLimited,
				avgDurationMs: stats.done > 0 ? Math.round(stats.durationTotalMs / stats.done) : 0,
				limit: this.effectiveLimitFor(id),
				...(throttledForMs !== undefined && throttledForMs > 0 ? { throttledForMs } : {}),
			};
		}
		let retries = 0;
		let rateLimited = 0;
		for (const stats of this.adapterStats.values()) {
			retries += stats.retries;
			rateLimited += stats.rateLimited;
		}
		return {
			submitted: this.submitted,
			done: counts.done,
			failed: counts.failed,
			retries,
			rateLimited,
			queued: counts.queued,
			running: counts.running,
			adapters,
		};
	}

	/** Queue a generation. Returns the job; use awaitJob to wait for it. */
	submit(input: SubmitInput, projectDir: string): QueueJob {
		const config = resolveAdapterFor(this.config, input.roleName, input.kind);
		if (!config) {
			const known = this.config?.media.map((adapter) => `${adapter.id}(${adapter.kind})`).join(", ") || "（无）";
			throw new MediaQueueError(
				`没有为角色 "${input.roleName}" 配置 ${input.kind} 生成模型。` +
					`请在 .pi-studio/models.json 的 media/bindings 中配置（当前已配置: ${known}）。`,
			);
		}
		const extension = fileExtensionFor(input.kind, config);
		const safeName =
			input.outputName
				.replace(/[\\/:*?"<>|]+/g, "-")
				.replace(/\s+/g, "-")
				.slice(0, 80) || "media";
		const job: QueueJob = {
			id: `J${this.nextJobId++}`,
			adapterId: config.id,
			kind: input.kind,
			prompt: input.prompt,
			params: input.params ?? {},
			relativePath: path.posix.join("assets", `${safeName}${extension}`),
			priority: input.priority ?? this.config?.defaults.priority ?? 100,
			status: "queued",
			attempts: 0,
			maxAttempts: this.config?.defaults.maxAttempts ?? 3,
			createdAt: Date.now(),
			attemptLog: [],
		};
		this.jobs.set(job.id, job);
		this.submitted++;
		this.pump(projectDir);
		return job;
	}

	/** Wait for a job to finish. Resolves with the final job state. */
	async awaitJob(jobId: string, onUpdate?: (job: QueueJob) => void, signal?: AbortSignal): Promise<QueueJob> {
		const job = this.jobs.get(jobId);
		if (!job) throw new MediaQueueError(`任务 ${jobId} 不存在`);
		if (job.status === "done" || job.status === "failed") {
			onUpdate?.(job);
			return job;
		}
		if (onUpdate) {
			let set = this.updateListeners.get(jobId);
			if (!set) {
				set = new Set();
				this.updateListeners.set(jobId, set);
			}
			set.add(onUpdate);
			onUpdate(job);
		}
		return new Promise<QueueJob>((resolve, reject) => {
			const waiter = (finished: QueueJob) => {
				cleanup();
				resolve(finished);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("已中止"));
			};
			const cleanup = () => {
				this.waiters.get(jobId)?.delete(waiter);
				signal?.removeEventListener("abort", onAbort);
				if (onUpdate) this.updateListeners.get(jobId)?.delete(onUpdate);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			let set = this.waiters.get(jobId);
			if (!set) {
				set = new Set();
				this.waiters.set(jobId, set);
			}
			set.add(waiter);
		});
	}

	// ---------------------------------------------------------------- internal

	private statsFor(adapterId: string): AdapterStats {
		let stats = this.adapterStats.get(adapterId);
		if (!stats) {
			stats = { done: 0, failed: 0, retries: 0, rateLimited: 0, durationTotalMs: 0 };
			this.adapterStats.set(adapterId, stats);
		}
		return stats;
	}

	private configuredLimitFor(adapterId: string): number {
		return (
			this.concurrencyOverrides.get(adapterId) ??
			this.config?.media.find((adapter) => adapter.id === adapterId)?.concurrency ??
			this.config?.defaults.concurrency ??
			2
		);
	}

	/** Effective limit: the configured one, or a reduced one while throttled. */
	private effectiveLimitFor(adapterId: string): number {
		const throttle = this.throttled.get(adapterId);
		if (throttle && Date.now() < throttle.until) return throttle.limit;
		return this.configuredLimitFor(adapterId);
	}

	private globalLimit(): number {
		return this.config?.defaults.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY;
	}

	private queuedJobs(): QueueJob[] {
		return [...this.jobs.values()]
			.filter((job) => job.status === "queued")
			.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
	}

	private pump(projectDir: string): void {
		this.lastProjectDir = projectDir;
		let waiting = 0;
		for (const job of this.queuedJobs()) {
			// Global cap keeps total request pressure bounded even with many
			// adapters in play.
			if (this.running.size >= this.globalLimit()) break;
			// B3 defer：未到点的任务本轮跳过（不阻塞其他任务，watchdog 会回来）
			const notBefore = this.deferredUntil.get(job.id);
			if (notBefore !== undefined) {
				if (Date.now() < notBefore) continue;
				this.deferredUntil.delete(job.id);
			}
			const inFlight = [...this.running]
				.map((id) => this.jobs.get(id))
				.filter((running) => running?.adapterId === job.adapterId).length;
			if (inFlight >= this.effectiveLimitFor(job.adapterId)) continue;
			this.start(job, projectDir);
		}
		waiting = this.queuedJobs().length;
		// Watchdog: while jobs remain queued, periodically re-attempt pumping
		// so no job can be stranded without a pending wake-up timer.
		if (waiting > 0 && !this.watchdogTimer) {
			this.watchdogTimer = setTimeout(() => {
				this.watchdogTimer = undefined;
				this.pump(projectDir);
			}, 30_000);
		}
	}

	/** Adaptive throttling: a 429 lowers this adapter's limit until cooldown. */
	private throttleAdapter(adapterId: string, projectDir: string): void {
		const previous = this.throttled.get(adapterId);
		const inFlight = [...this.running]
			.map((id) => this.jobs.get(id))
			.filter((running) => running?.adapterId === adapterId).length;
		const cooldownMs = Math.min(THROTTLE_COOLDOWN_MAX_MS, (previous?.cooldownMs ?? 0) * 2 || THROTTLE_COOLDOWN_MS);
		const until = Date.now() + cooldownMs;
		this.throttled.set(adapterId, {
			// Cut the limit below whatever is currently in flight (floor 0).
			limit: Math.max(0, Math.min(inFlight - 1, this.configuredLimitFor(adapterId) - 1)),
			until,
			cooldownMs,
		});
		// Wake the queue when the cooldown lapses: nothing else may trigger a
		// pump while every job of this adapter is held back.
		setTimeout(() => this.pump(projectDir), cooldownMs + 100);
	}

	private start(job: QueueJob, projectDir: string): void {
		job.status = "running";
		job.attempts++;
		const attemptStartedAt = Date.now();
		if (job.attempts === 1) {
			job.startedAt = attemptStartedAt;
			job.queuedMs = attemptStartedAt - job.createdAt;
		} else {
			this.statsFor(job.adapterId).retries++;
		}
		this.running.add(job.id);
		this.notify(job);

		const adapterConfig = this.config?.media.find((adapter) => adapter.id === job.adapterId);
		const outputBase = path.join(projectDir, job.relativePath).replace(/\.[^./\\]+$/, "");
		// Providers with N-requests-per-minute limits: space submissions out.
		// The job already holds its concurrency slot; only the request itself
		// waits, so parallel submissions stay serialized per adapter.
		let fireDelayMs = 0;
		const minIntervalMs = adapterConfig?.minIntervalMs ?? 0;
		if (minIntervalMs > 0) {
			const now = Date.now();
			const next = this.nextFireAt.get(job.adapterId) ?? 0;
			fireDelayMs = Math.max(0, next - now);
			this.nextFireAt.set(job.adapterId, Math.max(now, next) + minIntervalMs);
		}
		const run = async () => {
			let requeued = false;
			try {
				if (!adapterConfig) throw new MediaQueueError(`适配器 ${job.adapterId} 已从配置中移除`);
				await fs.promises.mkdir(path.dirname(outputBase), { recursive: true });
				const adapter = adapterFor(adapterConfig);
				const result = await adapter.generate({
					kind: job.kind,
					prompt: job.prompt,
					params: job.params,
					outputBase,
				});
				job.status = "done";
				job.filePath = result.filePath;
				job.metaUrl = typeof result.meta?.url === "string" ? (result.meta.url as string) : undefined;
				job.error = undefined;
				job.finishedAt = Date.now();
				const stats = this.statsFor(job.adapterId);
				stats.done++;
				stats.durationTotalMs += job.finishedAt - attemptStartedAt;
				job.attemptLog.push({
					attempt: job.attempts,
					startedAt: attemptStartedAt,
					finishedAt: job.finishedAt,
				});
				// A success within the cooldown window still counts: reset the
				// escalating cooldown so the limit recovers sooner.
				const throttle = this.throttled.get(job.adapterId);
				if (throttle) throttle.cooldownMs = THROTTLE_COOLDOWN_MS;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const retryable = isRetryableError(error);
				const rateLimited = error instanceof MediaHttpError && error.status === 429;
				if (rateLimited) this.statsFor(job.adapterId).rateLimited++;
				job.error = message;
				job.attemptLog.push({
					attempt: job.attempts,
					startedAt: attemptStartedAt,
					finishedAt: Date.now(),
					error: message,
					retryable,
				});
				// Fail fast on non-transient errors (bad request, auth, shape);
				// back off and retry only when the provider is limiting/busy.
				if (retryable && job.attempts < job.maxAttempts) {
					const advised = retryDelayMsFromError(error);
					const backoff = advised ?? backoffDelayMs(job.attempts);
					job.attemptLog[job.attemptLog.length - 1].retryInMs = backoff;
					if (rateLimited) this.throttleAdapter(job.adapterId, projectDir);
					job.status = "queued";
					requeued = true;
					setTimeout(() => this.pump(projectDir), backoff);
				} else {
					job.status = "failed";
					job.finishedAt = Date.now();
					this.statsFor(job.adapterId).failed++;
				}
			} finally {
				this.running.delete(job.id);
				this.notify(job);
				if (!requeued) this.pump(projectDir);
			}
		};
		if (fireDelayMs > 0) {
			setTimeout(() => void run(), fireDelayMs);
		} else {
			void run();
		}
	}

	private notify(job: QueueJob): void {
		for (const listener of this.globalListeners) {
			try {
				listener(job);
			} catch {
				/* listener errors must not break the queue */
			}
		}
		for (const listener of this.updateListeners.get(job.id) ?? []) {
			try {
				listener(job);
			} catch {
				/* listener errors must not break the queue */
			}
		}
		if (job.status === "done" || job.status === "failed") {
			const set = this.waiters.get(job.id);
			if (set) {
				for (const waiter of [...set]) waiter(job);
				this.waiters.delete(job.id);
				this.updateListeners.delete(job.id);
			}
		}
	}
}
