/**
 * Vision client — describes image/video artifacts for the review gate.
 *
 * The reviewer role session is a text LLM; before it judges a media artifact,
 * the review tool asks a multimodal model (OpenAI-compatible chat completions,
 * e.g. step-3.7-flash) what the artifact actually shows and feeds that
 * description to the reviewer alongside the creative brief.
 *
 * Inputs:
 * - image: local file → base64 data URL, or a public http(s) URL
 * - video: public http(s) URL (Step 3.7 Flash accepts video_url content)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { VisionConfig } from "./adapter.ts";

export interface VisionDescriptionRequest {
	/** Artifact display name (for error messages). */
	name: string;
	/** Local file path or http(s) URL of the media. */
	source: string;
	/** "image" | "video" | "audio" — audio gets a transcript-style probe. */
	kind: "image" | "video" | "audio";
	/** What the artifact was supposed to be (from the storyboard / prompt). */
	expectation?: string;
	/** The project brief for context. */
	brief?: string;
}

export interface VisionDescription {
	name: string;
	ok: boolean;
	description: string;
}

function dataUrlForFile(filePath: string): string {
	const buffer = fs.readFileSync(filePath);
	const ext = path.extname(filePath).toLowerCase();
	const mime =
		ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
	return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** Build the multimodal content parts for one media source. */
function contentPartsFor(request: VisionDescriptionRequest): {
	parts: Array<Record<string, unknown>> | null;
	note?: string;
} {
	const parts: Array<Record<string, unknown>> = [];
	if (request.kind === "audio") {
		// Audio understanding is not universally supported; send a text note so
		// the model can at least reason about the expectation.
		return {
			parts: null,
			note: `（音频文件：${request.name}，审校模型无法直接聆听，请基于台词文本与预期风格判断。）`,
		};
	}
	if (/^https?:\/\//.test(request.source)) {
		if (request.kind === "video") {
			parts.push({ type: "video_url", video_url: { url: request.source } });
		} else {
			parts.push({ type: "image_url", image_url: { url: request.source } });
		}
		return { parts };
	}
	if (request.kind === "video") {
		// Video understanding requires a public URL on most providers.
		return {
			parts: null,
			note: `（视频文件 ${request.name} 没有远程 URL，审校模型无法直接观看；请基于生成提示词与预期画面判断。）`,
		};
	}
	parts.push({ type: "image_url", image_url: { url: dataUrlForFile(request.source) } });
	return { parts };
}

/**
 * Describe one media artifact with the configured vision model.
 * Never throws — a failed probe degrades to a note for the reviewer.
 */
export async function describeArtifact(
	config: VisionConfig | undefined,
	request: VisionDescriptionRequest,
	signal?: AbortSignal,
): Promise<VisionDescription> {
	if (!config) {
		return {
			name: request.name,
			ok: false,
			description: "（未配置视觉审校模型，无法查看媒体内容；请按文件与描述判断）",
		};
	}
	const apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
	const promptLines = [
		"你是视频工作室的审校助手。请客观描述以下制作产物的实际内容。",
		request.brief ? `项目需求背景：${request.brief}` : "",
		request.expectation ? `该产物的预期内容：${request.expectation}` : "",
		"",
		"请输出：",
		"1. 实际画面/内容描述（主体、场景、色调、风格，3-5 句）",
		"2. 与预期的一致性评估（一致/部分偏离/明显偏离 + 理由）",
		"3. 发现的质量问题（如有：画面瑕疵、文字错误、构图问题等）",
	].filter(Boolean);
	const { parts, note } = contentPartsFor(request);
	const text = [note, promptLines.join("\n")].filter(Boolean).join("\n\n");
	try {
		const response = await fetch(config.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				...(config.headers ?? {}),
			},
			body: JSON.stringify({
				model: config.model,
				messages: [
					{
						role: "user",
						content: [...(parts ?? []), { type: "text", text }],
					},
				],
			}),
			signal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				name: request.name,
				ok: false,
				description: `（视觉审校模型返回 HTTP ${response.status}: ${text.slice(0, 150)}）`,
			};
		}
		const payload = (await response.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		const content = payload.choices?.[0]?.message?.content;
		const reply =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(
								(part): part is { type: "text"; text: string } =>
									typeof part === "object" && part !== null && (part as { type?: string }).type === "text",
							)
							.map((part) => part.text)
							.join("")
					: "";
		if (!reply.trim()) {
			return { name: request.name, ok: false, description: "（视觉审校模型未返回内容）" };
		}
		return { name: request.name, ok: true, description: reply.trim() };
	} catch (error) {
		return {
			name: request.name,
			ok: false,
			description: `（视觉审校调用失败：${error instanceof Error ? error.message : String(error)}）`,
		};
	}
}
