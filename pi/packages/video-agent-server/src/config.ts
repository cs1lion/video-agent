/**
 * 服务端配置：媒体适配器（复用 studio 的 models.json 约定）与文本 LLM 端点。
 *
 * - 媒体配置：从服务进程 cwd 向上查找 `.pi-studio/`（项目级），回退用户级
 *   `~/.pi/agent/studio/models.json`（由 studio adapter 层实现）。
 * - LLM：默认复用 models.json 的 `vision` 节（OpenAI 兼容 chat/completions），
 *   可用环境变量 VIDEO_AGENT_LLM_URL / _MODEL / _API_KEY 覆盖。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadMediaConfig, type MediaModelsFile } from "../../coding-agent/examples/extensions/studio/media/adapter.ts";

export interface LlmConfig {
	/** chat/completions 完整端点 */
	url: string;
	model: string;
	apiKey?: string;
	timeoutMs: number;
}

/** 向上查找包含 .pi-studio 的目录作为工作区根（运行产物也落在这里） */
export function findStudioRoot(startDir: string = process.cwd()): string {
	let dir = path.resolve(startDir);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".pi-studio"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(startDir);
}

export function loadLlmConfig(media: MediaModelsFile): LlmConfig {
	const url = process.env.VIDEO_AGENT_LLM_URL ?? media.vision?.url;
	const model = process.env.VIDEO_AGENT_LLM_MODEL ?? media.vision?.model;
	const apiKey = process.env.VIDEO_AGENT_LLM_API_KEY ?? media.vision?.apiKey;
	if (!url || !model) {
		throw new Error(
			"文本 LLM 配置缺失：在 .pi-studio/models.json 增加 vision 节（url/model/apiKey），" +
				"或设置环境变量 VIDEO_AGENT_LLM_URL / VIDEO_AGENT_LLM_MODEL / VIDEO_AGENT_LLM_API_KEY",
		);
	}
	return { url, model, apiKey, timeoutMs: media.vision?.timeoutMs ?? 120_000 };
}

export interface ServerContext {
	studioRoot: string;
	mediaConfig: MediaModelsFile;
	llm: LlmConfig;
	port: number;
}

export function loadServerContext(): ServerContext {
	const studioRoot = findStudioRoot();
	const mediaConfig = loadMediaConfig(studioRoot);
	if (mediaConfig.media.length === 0) {
		throw new Error(
			`未找到媒体适配器配置（查找路径: ${path.join(studioRoot, ".pi-studio", "models.json")}）。` +
				"请参照 studio 的 models.json 配置 video/tts 适配器。",
		);
	}
	return {
		studioRoot,
		mediaConfig,
		llm: loadLlmConfig(mediaConfig),
		port: Number(process.env.PORT ?? 8787),
	};
}
