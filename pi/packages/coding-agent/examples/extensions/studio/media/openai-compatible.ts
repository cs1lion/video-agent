/**
 * OpenAI-compatible media adapter.
 *
 * Covers the common endpoint shapes:
 * - image: POST {baseUrl}/v1/images/generations → JSON `data.0.b64_json` or `data.0.url`
 * - tts:   POST {baseUrl}/v1/audio/speech       → binary audio stream
 * - video: POST {baseUrl}/v1/videos             → async task + polling (via config.poll)
 * - music: any endpoint returning JSON/binary (requires explicit `path`)
 *
 * Config knobs: `path` (endpoint override), `defaultParams` (merged body),
 * `extraBody` (final body wins over request params), `resultPath`,
 * `responseFormat: "binary"`, `poll`.
 */

import * as fs from "node:fs";
import type { MediaKind } from "../core/types.ts";
import {
	authHeaders,
	defaultTimeoutMs,
	downloadToFile,
	extensionFromContentType,
	fetchWithTimeout,
	fileExtensionFor,
	joinUrl,
	type MediaAdapter,
	type MediaAdapterConfig,
	type MediaGenerateRequest,
	type MediaGenerateResult,
	type WordTimestamp,
	MediaHttpError,
	pollUntilDone,
	resolveDotPath,
	retryAfterMsFromHeader,
	saveMediaResult,
	videoFramesFor,
} from "./adapter.ts";

const DEFAULT_PATHS: Partial<Record<MediaKind, string>> = {
	image: "/v1/images/generations",
	tts: "/v1/audio/speech",
	video: "/v1/videos",
};

function excerpt(payload: unknown, maxLength = 240): string {
	return JSON.stringify(payload)?.slice(0, maxLength) ?? "";
}

/** Build the request body for the configured kind. */
function buildBody(config: MediaAdapterConfig, request: MediaGenerateRequest): Record<string, unknown> {
	const params = request.params ?? {};
	const body: Record<string, unknown> = {
		model: config.model,
		...(config.defaultParams ?? {}),
		...params,
		...(config.extraBody ?? {}),
	};
	if (request.kind === "tts") {
		body.input = request.prompt;
		if (typeof body.voice !== "string" || !body.voice) body.voice = config.voice ?? "default";
	} else if (request.kind === "video") {
		body.prompt = request.prompt;
		// Convenience: numeric `seconds` translates to the frame count video
		// models expect (8n+1, ≤ 441) and is removed from the body.
		if (body.num_frames === undefined && typeof params.seconds === "number") {
			const frameRate = typeof body.frame_rate === "number" ? body.frame_rate : 24;
			body.num_frames = videoFramesFor(params.seconds, frameRate);
			delete body.seconds;
		}
		// String `seconds`（如 Agnes 2.5 / OpenAI Videos 兼容接口的 "4"-"12"）原样透传。
		// 此前无条件 delete 导致字符串时长被静默丢弃，模型按默认时长（5s）出片。
	} else {
		body.prompt = request.prompt;
	}
	return body;
}

/** True when the response body is the media file itself (not JSON metadata). */
function isBinaryResponse(config: MediaAdapterConfig, contentType: string): boolean {
	if (config.responseFormat === "binary") return true;
	if (config.responseFormat === "json") return false;
	const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/octet-stream";
}

async function saveBinaryResponse(
	config: MediaAdapterConfig,
	request: MediaGenerateRequest,
	response: Response,
	contentType: string,
): Promise<MediaGenerateResult> {
	const extension =
		config.fileExtension ?? extensionFromContentType(contentType) ?? fileExtensionFor(request.kind, config);
	const filePath = `${request.outputBase}${extension}`;
	const buffer = Buffer.from(await response.arrayBuffer());
	await fs.promises.writeFile(filePath, buffer);
	return { filePath };
}

export function createOpenAICompatibleAdapter(config: MediaAdapterConfig): MediaAdapter {
	return {
		id: config.id,
		kind: config.kind,
		config,
		async generate(request: MediaGenerateRequest): Promise<MediaGenerateResult> {
			const endpointPath = config.path ?? DEFAULT_PATHS[request.kind];
			if (!endpointPath) {
				throw new Error(`${config.id}: ${request.kind} 类型需要显式配置 path（无默认端点）`);
			}
			const url = joinUrl(config.baseUrl, endpointPath);
			const body = buildBody(config, request);
			const response = await fetchWithTimeout(
				url,
				{
					method: config.method ?? "POST",
					headers: {
						"Content-Type": "application/json",
						...authHeaders(config),
						...config.headers,
					},
					body: JSON.stringify(body),
				},
				defaultTimeoutMs(request.kind, config),
				request.signal,
			);
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new MediaHttpError(`${config.id} 请求失败 HTTP ${response.status}: ${text.slice(0, 300)}`, {
					status: response.status,
					retryAfterMs: retryAfterMsFromHeader(response.headers.get("retry-after")),
				});
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (isBinaryResponse(config, contentType)) {
				return saveBinaryResponse(config, request, response, contentType);
			}

			const payload = (await response.json().catch(() => undefined)) as unknown;
			if (payload === undefined) {
				throw new Error(`${config.id}: 响应不是 JSON 也非二进制媒体流`);
			}

			// TTS word-timestamp flow: providers that support `timestamp=true` +
			// `return_url=true` return JSON with an audio URL and optional word-level
			// timings instead of a binary audio stream.
			if (request.kind === "tts" && typeof payload === "object" && payload !== null) {
				const jsonPayload = payload as Record<string, unknown>;
				const audioUrl = typeof jsonPayload.url === "string" ? jsonPayload.url : undefined;
				const rawWords = resolveDotPath(payload, "words") ?? resolveDotPath(payload, "data.words");
				const words: WordTimestamp[] = [];
				if (Array.isArray(rawWords)) {
					for (const w of rawWords) {
						if (typeof w !== "object" || w === null) continue;
						const rec = w as Record<string, unknown>;
						const text = typeof rec.text === "string" ? rec.text : typeof rec.word === "string" ? rec.word : "";
						const start = typeof rec.start === "number" ? rec.start : typeof rec.start_time === "number" ? rec.start_time : NaN;
						const end = typeof rec.end === "number" ? rec.end : typeof rec.end_time === "number" ? rec.end_time : NaN;
						if (text && Number.isFinite(start) && Number.isFinite(end)) {
							words.push({ text, start, end });
						}
					}
				}
				if (audioUrl) {
					const extension = fileExtensionFor("tts", config, audioUrl);
					const filePath = `${request.outputBase}${extension}`;
					await downloadToFile(audioUrl, filePath, config, request.signal);
					const meta: Record<string, unknown> = { url: audioUrl };
					if (words.length > 0) meta.wordTimestamps = words;
					return { filePath, meta };
				}
				if (words.length > 0) {
					return { filePath: request.outputBase + fileExtensionFor("tts", config), meta: { wordTimestamps: words } };
				}
			}

			// Async task flow: create → poll → extract result.
			if (config.poll) {
				const finalPayload = await pollUntilDone(config, payload, request.signal);
				const result = resolveDotPath(finalPayload, config.poll.resultPath);
				return saveMediaResult(config, request.outputBase, result, request.signal);
			}

			// Synchronous JSON flow.
			if (!config.resultPath && request.kind === "image") {
				const b64 = resolveDotPath(payload, "data.0.b64_json");
				if (typeof b64 === "string" && b64) {
					return saveMediaResult(config, request.outputBase, b64, request.signal);
				}
				const imageUrl = resolveDotPath(payload, "data.0.url");
				if (typeof imageUrl === "string" && imageUrl) {
					return saveMediaResult(config, request.outputBase, imageUrl, request.signal);
				}
				throw new Error(`${config.id}: 响应中未找到 data.0.b64_json / data.0.url: ${excerpt(payload)}`);
			}
			const result = config.resultPath ? resolveDotPath(payload, config.resultPath) : undefined;
			return saveMediaResult(config, request.outputBase, result, request.signal);
		},
	};
}
