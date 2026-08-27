/**
 * Media adapter interface and shared plumbing.
 *
 * Media models (video / image / tts / music) are configured in
 * `.pi-studio/models.json` (project) or `~/.pi/agent/studio/models.json`
 * (user-level fallback). Text models for roles go through pi's native
 * models.json custom providers instead — this layer is media-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MediaKind } from "../core/types.ts";

// ============================================================================
// Config types
// ============================================================================

export type MediaAdapterType = "openai-compatible" | "custom-http";

export interface MediaPollConfig {
	/** Dot path to the task id in the creation response */
	taskIdPath?: string;
	/** URL template for status polling; {{taskId}} is substituted */
	statusUrl: string;
	/** Dot path to the status value in the poll response */
	statusPath: string;
	/** Status values meaning done */
	doneValues: string[];
	/** Status values meaning failed (default: ["failed", "error"]) */
	failedValues?: string[];
	/** Dot path to the result URL in the poll response (after done) */
	resultPath: string;
	/** Poll interval in ms (default 5000) */
	intervalMs?: number;
	/** Max poll iterations (default 120) */
	maxPolls?: number;
}

export interface MediaAdapterConfig {
	id: string;
	kind: MediaKind;
	type: MediaAdapterType;
	baseUrl: string;
	/** Endpoint path appended to baseUrl (per-type defaults otherwise) */
	path?: string;
	method?: string;
	model?: string;
	apiKey?: string;
	/** Environment variable holding the API key (alternative to apiKey) */
	apiKeyEnv?: string;
	headers?: Record<string, string>;
	/** Max concurrent requests for this adapter (default 1) */
	concurrency?: number;
	/**
	 * Minimum spacing between request submissions for this adapter, in ms.
	 * Providers that enforce N requests per minute (e.g. 1/min) should set
	 * this above the window; submissions are delayed, never dropped.
	 */
	minIntervalMs?: number;
	/** Request timeout in ms (default 600000 for video, 120000 otherwise) */
	timeoutMs?: number;
	/** Saved file extension override (default per kind) */
	fileExtension?: string;
	/** OpenAI-compatible: extra body fields merged into the request */
	extraBody?: Record<string, unknown>;
	/** OpenAI-compatible tts: voice parameter */
	voice?: string;
	/**
	 * Custom-http: body template. Object values may contain {{prompt}},
	 * {{kind}}, or {{paramName}} placeholders. A string value equal to a
	 * placeholder inserts the typed value; inline occurrences interpolate.
	 */
	requestTemplate?: Record<string, unknown>;
	/** Custom-http: response handling */
	responseFormat?: "json" | "binary";
	/** Custom-http: dot path to the result URL/base64 in the JSON response */
	resultPath?: string;
	/** Custom-http: async task polling */
	poll?: MediaPollConfig;
	/** Default params merged into every request */
	defaultParams?: Record<string, unknown>;
}

export interface MediaModelsFile {
	media: MediaAdapterConfig[];
	/**
	 * Role name → adapter id bindings ("*" is the fallback). A binding whose
	 * adapter kind does not match the requested kind falls back to the first
	 * adapter of that kind.
	 */
	bindings?: Record<string, string>;
	/**
	 * Optional vision model (OpenAI-compatible chat completions) used by the
	 * review gate to describe image/video artifacts before the reviewer
	 * session judges them.
	 */
	vision?: VisionConfig;
	defaults: {
		concurrency: number;
		/** Cap on in-flight jobs across all adapters (default 8). */
		globalConcurrency?: number;
		maxAttempts: number;
		priority: number;
	};
	/** Where the config was loaded from */
	source?: string;
	/** Validation problems (config still loads; broken adapters are skipped) */
	errors: string[];
}

/** OpenAI-compatible multimodal model used for artifact review descriptions. */
export interface VisionConfig {
	/** Full chat-completions endpoint URL. */
	url: string;
	/** Model id, e.g. "step-3.7-flash". */
	model: string;
	apiKey?: string;
	apiKeyEnv?: string;
	/** Extra headers merged into every request. */
	headers?: Record<string, string>;
	/** Request timeout in ms (default 120000). */
	timeoutMs?: number;
}

/** Pick the adapter config a role should use for a media kind. */
export function resolveAdapterFor(
	config: MediaModelsFile | undefined,
	roleName: string,
	kind: MediaKind,
): MediaAdapterConfig | undefined {
	if (!config) return undefined;
	const boundId = config.bindings?.[roleName] ?? config.bindings?.["*"];
	if (boundId) {
		const bound = config.media.find((a) => a.id === boundId && a.kind === kind);
		if (bound) return bound;
	}
	return config.media.find((a) => a.kind === kind);
}

// ============================================================================
// Requests / results
// ============================================================================

export interface MediaGenerateRequest {
	kind: MediaKind;
	prompt: string;
	params: Record<string, unknown>;
	/** Absolute file path without extension; the adapter saves here */
	outputBase: string;
	signal?: AbortSignal;
}

export interface MediaGenerateResult {
	/** Absolute path of the saved file */
	filePath: string;
	/** Provider metadata worth persisting (raw response excerpt) */
	meta?: Record<string, unknown>;
}

export interface MediaAdapter {
	readonly id: string;
	readonly kind: MediaKind;
	readonly config: MediaAdapterConfig;
	generate(request: MediaGenerateRequest): Promise<MediaGenerateResult>;
}

// ============================================================================
// Config loading / validation
// ============================================================================

const DEFAULT_TIMEOUT_MS: Record<MediaKind, number> = {
	video: 600_000,
	image: 120_000,
	tts: 120_000,
	music: 300_000,
};

const DEFAULT_EXTENSIONS: Record<MediaKind, string> = {
	video: ".mp4",
	image: ".png",
	tts: ".mp3",
	music: ".mp3",
};

export function defaultTimeoutMs(kind: MediaKind, config?: MediaAdapterConfig): number {
	return config?.timeoutMs ?? DEFAULT_TIMEOUT_MS[kind];
}

export function fileExtensionFor(kind: MediaKind, config?: MediaAdapterConfig, url?: string): string {
	if (config?.fileExtension) return config.fileExtension;
	if (url) {
		const ext = path.extname(new URL(url).pathname).toLowerCase();
		if (/^\.[a-z0-9]{2,5}$/.test(ext)) return ext;
	}
	return DEFAULT_EXTENSIONS[kind];
}

export function resolveApiKey(config: MediaAdapterConfig): string | undefined {
	if (config.apiKey) return config.apiKey;
	if (config.apiKeyEnv) return process.env[config.apiKeyEnv];
	return undefined;
}

export function authHeaders(config: MediaAdapterConfig): Record<string, string> {
	const apiKey = resolveApiKey(config);
	return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function readMediaModelsFile(filePath: string): MediaModelsFile | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<MediaModelsFile> & {
			media?: MediaAdapterConfig[];
			bindings?: Record<string, string>;
			defaults?: Partial<MediaModelsFile["defaults"]>;
		};
		return {
			media: Array.isArray(parsed.media) ? parsed.media : [],
			bindings: parsed.bindings,
			vision: parsed.vision,
			defaults: {
				concurrency: parsed.defaults?.concurrency ?? 3,
				maxAttempts: parsed.defaults?.maxAttempts ?? 3,
				priority: parsed.defaults?.priority ?? 5,
			},
			source: filePath,
			errors: [],
		};
	} catch {
		return null;
	}
}

/**
 * Load the media models config. Project-level `.pi-studio/models.json`
 * wins over the user-level `~/.pi/agent/studio/models.json`.
 */
export function loadMediaConfig(cwd: string): MediaModelsFile {
	const candidates = [path.join(cwd, ".pi-studio", "models.json"), path.join(getAgentDir(), "studio", "models.json")];
	for (const candidate of candidates) {
		const loaded = readMediaModelsFile(candidate);
		if (loaded) {
			loaded.media = loaded.media.filter((config) => {
				const valid =
					typeof config.id === "string" &&
					typeof config.baseUrl === "string" &&
					typeof config.kind === "string" &&
					typeof config.type === "string";
				if (!valid) {
					loaded.errors.push(
						`适配器配置不完整（需要 id/kind/type/baseUrl）: ${JSON.stringify(config).slice(0, 120)}`,
					);
				}
				return valid;
			});
			return loaded;
		}
	}
	return {
		media: [],
		defaults: { concurrency: 3, maxAttempts: 3, priority: 5 },
		errors: [],
	};
}

// ============================================================================
// Error classification (retry policy for the generation queue)
// ============================================================================

/**
 * HTTP/transport error carrying retry classification so the generation
 * queue can decide between "backoff and retry" (rate limit, provider
 * overload, transient network faults) and "fail fast" (bad request,
 * unauthorized, unsupported response shape).
 */
export class MediaHttpError extends Error {
	readonly status?: number;
	/** Server-advised wait via the Retry-After header, in ms. */
	readonly retryAfterMs?: number;
	/** True for 408/429/5xx and network-level faults. */
	readonly retryable: boolean;

	constructor(message: string, options: { status?: number; retryAfterMs?: number; retryable?: boolean } = {}) {
		super(message);
		this.name = "MediaHttpError";
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
		this.retryable = options.retryable ?? isRetryableStatus(options.status);
	}
}

/** Statuses worth retrying: request timeout, rate limit, provider overload. */
export function isRetryableStatus(status: number | undefined): boolean {
	if (status === undefined) return false;
	return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Parse a Retry-After header (delay-seconds or HTTP-date) into ms. */
export function retryAfterMsFromHeader(value: string | null): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
}

const TIMEOUT_PATTERN = /timeout|timed out|超时/i;
const TRANSIENT_NETWORK_PATTERN =
	/econn|etimedout|enotfound|eai_again|econnreset|econnrefused|epipe|fetch failed|network|socket hang up/i;

/**
 * Whether a thrown error is transient (rate limit / provider busy / network
 * fault) and the caller should back off and retry. Abort signals are never
 * retryable.
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof MediaHttpError) return error.retryable;
	if (error instanceof Error) {
		// User-initiated abort (AbortError / "已中止") is never retried.
		if (error.name === "AbortError" || error.message === "已中止") return false;
		// fetchWithTimeout aborts carry the timeout message as the reason.
		if (TIMEOUT_PATTERN.test(error.message)) return true;
		return TRANSIENT_NETWORK_PATTERN.test(error.message);
	}
	return false;
}

/** Retry delay (ms) the queue should honor, when the error carries one. */
export function retryDelayMsFromError(error: unknown): number | undefined {
	return error instanceof MediaHttpError ? error.retryAfterMs : undefined;
}

// ============================================================================
// Shared helpers
// ============================================================================

/** Resolve a dot path like "choices.0.message.content" against parsed JSON. */
export function resolveDotPath(obj: unknown, dotPath: string): unknown {
	let current: unknown = obj;
	for (const segment of dotPath.split(".")) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			current = Number.isInteger(index) ? current[index] : undefined;
		} else if (typeof current === "object") {
			current = (current as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return current;
}

export function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`请求超时 (${timeoutMs}ms): ${url}`)), timeoutMs);
	const onOuterAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onOuterAbort, { once: true });
	return fetch(url, { ...init, signal: controller.signal }).finally(() => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onOuterAbort);
	});
}

/**
 * Download a URL to disk (streaming).
 *
 * Result URLs are often hosted on a signed CDN origin distinct from the API
 * origin; those reject requests carrying an Authorization header with 401.
 * So download anonymously first and retry with auth only on 401/403 (for
 * providers that serve files from their authenticated API origin).
 */
export async function downloadToFile(
	url: string,
	filePath: string,
	config: MediaAdapterConfig,
	signal?: AbortSignal,
): Promise<void> {
	const timeoutMs = defaultTimeoutMs(config.kind, config);
	let response = await fetchWithTimeout(url, { headers: {} }, timeoutMs, signal);
	if ((response.status === 401 || response.status === 403) && resolveApiKey(config)) {
		response = await fetchWithTimeout(
			url,
			{ headers: { ...authHeaders(config), ...config.headers } },
			timeoutMs,
			signal,
		);
	}
	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => "");
		throw new MediaHttpError(`下载失败 HTTP ${response.status}: ${url} ${text.slice(0, 160)}`, {
			status: response.status,
			retryAfterMs: retryAfterMsFromHeader(response.headers.get("retry-after")),
		});
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	await fs.promises.writeFile(filePath, buffer);
}

/** Extract the first http(s) URL from a string. */
export function extractUrl(text: string): string | undefined {
	const match = text.match(/https?:\/\/[^\s"'<>)]+/);
	return match?.[0];
}

/** True when the value looks like base64 payload rather than a URL. */
export function looksLikeBase64(value: string): boolean {
	return value.length > 128 && !value.startsWith("http");
}

export async function saveBase64(base64: string, filePath: string): Promise<void> {
	await fs.promises.writeFile(filePath, Buffer.from(base64, "base64"));
}

// ============================================================================
// Shared adapter helpers (used by openai-compatible.ts / custom-http.ts)
// ============================================================================

/** Join a base URL and an endpoint path (absolute paths win). */
export function joinUrl(base: string, endpointPath: string): string {
	if (!endpointPath) return base;
	if (/^https?:\/\//i.test(endpointPath)) return endpointPath;
	return `${base.replace(/\/+$/, "")}/${endpointPath.replace(/^\/+/, "")}`;
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("已中止"));
			},
			{ once: true },
		);
	});
}

/**
 * Convert a target duration in seconds to a frame count following the
 * `8n + 1` rule (≤ 441) used by common video models:
 * seconds = num_frames / frame_rate.
 */
export function videoFramesFor(seconds: number, frameRate: number): number {
	const raw = Math.max(1, Math.round(seconds * frameRate));
	const frames = 8 * Math.round((raw - 1) / 8) + 1;
	return Math.min(441, Math.max(9, frames));
}

function excerpt(payload: unknown, maxLength = 240): string {
	return JSON.stringify(payload)?.slice(0, maxLength) ?? "";
}

/**
 * Poll an async generation task to completion. `createResponse` is the JSON
 * returned by the creation request; the task id is read from it via
 * `poll.taskIdPath`. Returns the final poll response payload.
 */
export async function pollUntilDone(
	config: MediaAdapterConfig,
	createResponse: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const poll = config.poll;
	if (!poll) throw new Error("适配器缺少 poll 配置");
	const taskId = resolveDotPath(createResponse, poll.taskIdPath ?? "id");
	if (typeof taskId !== "string" || !taskId) {
		throw new Error(`创建任务的响应中未找到任务 id（${poll.taskIdPath ?? "id"}）: ${excerpt(createResponse)}`);
	}
	const intervalMs = poll.intervalMs ?? 5000;
	const maxPolls = poll.maxPolls ?? 120;
	const failedValues = poll.failedValues ?? ["failed", "error"];
	// Poll endpoints commonly return transient 429/5xx under load; tolerate a
	// few consecutive failures instead of failing the whole (expensive) job.
	const maxPollErrors = 5;
	let pollErrors = 0;
	for (let attempt = 0; attempt < maxPolls; attempt++) {
		await sleep(intervalMs, signal);
		const url = poll.statusUrl.replace(/\{\{taskId\}\}/g, encodeURIComponent(taskId));
		const response = await fetchWithTimeout(
			url,
			{ headers: { ...authHeaders(config), ...config.headers } },
			defaultTimeoutMs(config.kind, config),
			signal,
		).catch((error: unknown) => {
			if (!isRetryableError(error)) throw error;
			return undefined as unknown as Response;
		});
		if (!response || !response.ok) {
			if (response) {
				const status = response.status;
				const retryAfter = retryAfterMsFromHeader(response.headers.get("retry-after"));
				if (!isRetryableStatus(status)) {
					const text = await response.text().catch(() => "");
					throw new MediaHttpError(`查询任务状态失败 HTTP ${status}: ${url} ${text.slice(0, 160)}`, {
						status,
						retryAfterMs: retryAfter,
					});
				}
				if (retryAfter && retryAfter > intervalMs && retryAfter < 60_000) {
					await sleep(retryAfter, signal);
				}
			}
			pollErrors++;
			if (pollErrors >= maxPollErrors) {
				const detail = response ? `HTTP ${response.status}` : "网络错误";
				throw new MediaHttpError(`查询任务状态连续失败（${detail}）: ${url}`, {
					status: response?.status,
					retryable: true,
				});
			}
			continue;
		}
		pollErrors = 0;
		const payload = (await response.json()) as unknown;
		const status = String(resolveDotPath(payload, poll.statusPath) ?? "");
		if (failedValues.includes(status)) {
			throw new Error(`生成任务失败（${status}）: ${excerpt(payload, 300)}`);
		}
		if (poll.doneValues.includes(status)) return payload;
	}
	throw new Error(`生成任务超时（轮询 ${maxPolls} 次未完成）: ${taskId}`);
}

/** Save a generation result value (http URL / base64 / data URL) to disk. */
export async function saveMediaResult(
	config: MediaAdapterConfig,
	outputBase: string,
	result: unknown,
	signal?: AbortSignal,
): Promise<MediaGenerateResult> {
	if (typeof result !== "string" || !result) {
		throw new Error(`响应中未找到生成结果: ${excerpt(result)}`);
	}
	const extension = fileExtensionFor(config.kind, config, result.startsWith("http") ? result : undefined);
	const filePath = `${outputBase}${extension}`;
	if (result.startsWith("http")) {
		await downloadToFile(result, filePath, config, signal);
	} else if (result.startsWith("data:")) {
		await saveBase64(result.slice(result.indexOf(",") + 1), filePath);
	} else if (looksLikeBase64(result)) {
		await saveBase64(result, filePath);
	} else {
		throw new Error(`无法识别的生成结果: ${result.slice(0, 120)}`);
	}
	return { filePath, meta: { url: result.startsWith("http") ? result : undefined } };
}

/** Map a response content type to a file extension (binary responses). */
export function extensionFromContentType(contentType: string): string | undefined {
	const mime = contentType.split(";")[0]?.trim().toLowerCase();
	switch (mime) {
		case "audio/mpeg":
		case "audio/mp3":
			return ".mp3";
		case "audio/wav":
		case "audio/x-wav":
			return ".wav";
		case "audio/ogg":
			return ".ogg";
		case "video/mp4":
			return ".mp4";
		case "video/webm":
			return ".webm";
		default:
			return undefined;
	}
}
