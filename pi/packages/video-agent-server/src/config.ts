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
import { loadPriceCatalog, type PriceCatalog } from "./pricing.ts";
import { QuotaLedger, type KeyType } from "./quota.ts";

/** 视频配额池 id（当前单视频适配器 = 单池；多 key 多池是 B2+ 的事） */
export const VIDEO_QUOTA_POOL = "video";

/**
 * 视频配额账本（进程级共享，跨 run 累计——每日配额是全局的）。
 * 缺省按 TokenPlan 实测（总文档 2.1/3.5）：500s/天、2 RPM；环境变量覆盖：
 *   VIDEO_AGENT_QUOTA_DAILY_SEC  每日秒数（"0" = 无明确配额，只受 RPM 约束）
 *   VIDEO_AGENT_QUOTA_RPM        每分钟提交上限
 */
export function loadQuotaLedger(): QuotaLedger {
	const dailyRaw = process.env.VIDEO_AGENT_QUOTA_DAILY_SEC;
	const parsedDaily = dailyRaw === undefined ? Number.NaN : Number(dailyRaw);
	const dailyQuotaSec = Number.isFinite(parsedDaily) ? (parsedDaily > 0 ? parsedDaily : null) : 500;
	const parsedRpm = Number(process.env.VIDEO_AGENT_QUOTA_RPM);
	const rpmCap = Number.isFinite(parsedRpm) && parsedRpm > 0 ? parsedRpm : 2;
	const keyType: KeyType = dailyQuotaSec === null ? "free" : "tokenplan";
	if (dailyRaw === undefined && process.env.VIDEO_AGENT_SILENCE_QUOTA_HINT !== "1") {
		// 运营提示（一次性，进程级 console）：默认值按 TokenPlan 保守估计；实际 Key 为
		// 企业版时真实额度更高，不覆盖会让账本"精确地记一笔错误的预算"。
		console.warn(
			"[video-agent] 未设置 VIDEO_AGENT_QUOTA_DAILY_SEC，按保守默认 500s/天记账（当前 Agnes Key 为企业版，真实额度更高）。" +
				"要放开请设 VIDEO_AGENT_QUOTA_DAILY_SEC=<秒数>（\"0\" = 不限每日量，只受 RPM 约束）；测试环境可设 VIDEO_AGENT_SILENCE_QUOTA_HINT=1 关闭本提示。",
		);
	}
	return new QuotaLedger([{ id: VIDEO_QUOTA_POOL, keyType, rpmCap, dailyQuotaSec }]);
}

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
	/** 价格目录（P2：运行时成本跟踪 + pre-flight 预估） */
	priceCatalog: PriceCatalog;
	/** 视频配额账本（B1）。loadServerContext 恒提供；测试桩可省略 = 不启用配额闸门（旧行为） */
	quota?: QuotaLedger;
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
	// P2：价格目录（如未配置则回退默认估算，不阻塞业务）
	const priceCatalog = loadPriceCatalog(studioRoot);
	// 安全提醒：检测 models.json 中是否明文写入了 apiKey（不警告不会阻断运行，但会推个 console.warn）。
	// 推荐配置：在 adapter 上用 apiKeyEnv 代替 apiKey（已在 media/adapter.ts 支持）。
	warnPlaintextApiKeys(mediaConfig);
	return {
		studioRoot,
		mediaConfig,
		llm: loadLlmConfig(mediaConfig),
		port: Number(process.env.PORT ?? 8787),
		priceCatalog,
		quota: loadQuotaLedger(),
	};
}

/** 扫描 media + vision 适配器，发现明文 apiKey 则提示改用 apiKeyEnv。 */
function warnPlaintextApiKeys(media: MediaModelsFile): void {
	const offenders: string[] = [];
	for (const m of media.media ?? []) {
		if (m.apiKey) offenders.push(`media.${m.id || m.kind}`);
	}
	if (media.vision?.apiKey) offenders.push("vision");
	if (offenders.length === 0) return;
	console.warn(
		`[video-agent-server] ⚠️  检测到 models.json 中明文 apiKey: ${offenders.join(", ")}。` +
			`\n  推荐改用 "apiKeyEnv": "ENV_VAR_NAME"（media/adapter.ts 已支持），apiKey 从 process.env 读取，` +
			`\n  避免把密钥提交进仓库或共享。LLM 端点已支持 VIDEO_AGENT_LLM_API_KEY 环境变量覆盖。`,
	);
}
