/**
 * Custom HTTP media adapter — fully configurable request/response plumbing
 * for providers that do not follow the OpenAI-compatible shapes.
 *
 * Config knobs:
 * - `path` / `method`: endpoint
 * - `requestTemplate`: body template. String values support `{{placeholders}}`
 *   substituted from the generation params plus `{{prompt}}` / `{{kind}}`.
 *   A string that is exactly `{{param}}` inserts the typed value.
 * - `responseFormat`: "binary" (response body is the media file) or "json"
 * - `resultPath`: dot path to the URL / base64 result in the JSON response
 * - `poll`: async task polling (create → poll statusUrl → resultPath)
 */

import * as fs from "node:fs";
import {
	authHeaders,
	defaultTimeoutMs,
	extensionFromContentType,
	fetchWithTimeout,
	fileExtensionFor,
	joinUrl,
	type MediaAdapter,
	type MediaAdapterConfig,
	type MediaGenerateRequest,
	type MediaGenerateResult,
	MediaHttpError,
	pollUntilDone,
	resolveDotPath,
	retryAfterMsFromHeader,
	saveMediaResult,
} from "./adapter.ts";

function excerpt(payload: unknown, maxLength = 240): string {
	return JSON.stringify(payload)?.slice(0, maxLength) ?? "";
}

/** Render {{placeholders}} in a request template against the call params. */
function renderTemplate(value: unknown, variables: Record<string, unknown>): unknown {
	if (typeof value === "string") {
		const exact = value.match(/^\{\{(\w+)\}\}$/);
		if (exact) return variables[exact[1]] ?? "";
		return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(variables[key] ?? ""));
	}
	if (Array.isArray(value)) return value.map((item) => renderTemplate(item, variables));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renderTemplate(item, variables)]),
		);
	}
	return value;
}

/** Build the final request body: template render + defaults + call params. */
function buildBody(config: MediaAdapterConfig, request: MediaGenerateRequest): Record<string, unknown> {
	const variables: Record<string, unknown> = {
		prompt: request.prompt,
		kind: request.kind,
		...(request.params ?? {}),
	};
	const templated = config.requestTemplate
		? (renderTemplate(config.requestTemplate, variables) as Record<string, unknown>)
		: {};
	return { ...templated, ...(config.defaultParams ?? {}), ...(request.params ?? {}) };
}

export function createCustomHttpAdapter(config: MediaAdapterConfig): MediaAdapter {
	return {
		id: config.id,
		kind: config.kind,
		config,
		async generate(request: MediaGenerateRequest): Promise<MediaGenerateResult> {
			const url = joinUrl(config.baseUrl, config.path ?? "");
			const method = (config.method ?? "POST").toUpperCase();
			const body = buildBody(config, request);
			const hasBody = method !== "GET" && method !== "HEAD";
			const response = await fetchWithTimeout(
				url,
				{
					method,
					headers: {
						...(hasBody ? { "Content-Type": "application/json" } : {}),
						...authHeaders(config),
						...config.headers,
					},
					...(hasBody ? { body: JSON.stringify(body) } : {}),
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
			const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
			if (
				config.responseFormat === "binary" ||
				mime.startsWith("audio/") ||
				mime.startsWith("video/") ||
				mime === "application/octet-stream"
			) {
				const extension =
					config.fileExtension ?? extensionFromContentType(contentType) ?? fileExtensionFor(request.kind, config);
				const filePath = `${request.outputBase}${extension}`;
				const buffer = Buffer.from(await response.arrayBuffer());
				await fs.promises.writeFile(filePath, buffer);
				return { filePath };
			}

			const payload = (await response.json().catch(() => undefined)) as unknown;
			if (payload === undefined) {
				throw new Error(`${config.id}: 响应不是 JSON 也非二进制媒体流`);
			}

			if (config.poll) {
				const finalPayload = await pollUntilDone(config, payload, request.signal);
				const result = resolveDotPath(finalPayload, config.poll.resultPath);
				return saveMediaResult(config, request.outputBase, result, request.signal);
			}

			const result = config.resultPath ? resolveDotPath(payload, config.resultPath) : undefined;
			if (result === undefined) {
				throw new Error(`${config.id}: 响应中未找到生成结果（resultPath）: ${excerpt(payload)}`);
			}
			return saveMediaResult(config, request.outputBase, result, request.signal);
		},
	};
}
