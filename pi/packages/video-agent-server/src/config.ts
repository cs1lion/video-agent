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
import { QuotaLedger, type KeyType, type PoolSpec } from "./quota.ts";

/** 视频配额池 id（当前单视频适配器 = 单池；多 key 多池是 B2+ 的事） */
export const VIDEO_QUOTA_POOL = "video";

/**
 * 视频配额账本（进程级共享，跨 run 累计——每日配额是全局的）。
 * 缺省按 TokenPlan 实测（总文档 2.1/3.5）：500s/天、2 RPM；环境变量覆盖：
 *   VIDEO_AGENT_QUOTA_DAILY_SEC  每日秒数（"0" = 无明确配额，只受 RPM 约束）
 *   VIDEO_AGENT_QUOTA_RPM        每分钟提交上限
 *   VIDEO_AGENT_QUOTA_KEY_TYPE   池类型标注（free/enterprise/tokenplan），缺省按配额推断
 *
 * ⚠️ **「有无每日时长配额」与「Key 层级」是两个正交维度，不能互相推导**：
 * 企业版与 free 都可能没有明确的每日时长配额（`dailyQuotaSec: null`），
 * 但 RPM 分别是 2 与 1（Agnes 官方表）。早期实现把 null 直接推导为 "free"，
 * 会让厨房快照把企业版池误标成 free（官方 1 RPM），进而让 ReAct 代理低估该池能力。
 * keyType 只用于快照展示与代理决策语义，**不参与** RPM / 配额的实际计算。
 *
 * 2026-08-29：视频模型处于**限时免费**状态（无每日秒数配额，但 RPM 限流依然存在）→
 * 生产设 `VIDEO_AGENT_QUOTA_DAILY_SEC=0` 即可，账本退化为「只记 RPM 令牌桶 + 用量统计」。
 */
export function loadQuotaLedger(mediaConfig?: MediaModelsFile): QuotaLedger {
	const dailyRaw = process.env.VIDEO_AGENT_QUOTA_DAILY_SEC;
	const parsedDaily = dailyRaw === undefined ? Number.NaN : Number(dailyRaw);
	const dailyQuotaSec = Number.isFinite(parsedDaily) ? (parsedDaily > 0 ? parsedDaily : null) : 500;
	const parsedRpm = Number(process.env.VIDEO_AGENT_QUOTA_RPM);
	const rpmCap = Number.isFinite(parsedRpm) && parsedRpm > 0 ? parsedRpm : 2;
	const kt = process.env.VIDEO_AGENT_QUOTA_KEY_TYPE;
	const keyType: KeyType =
		kt === "free" || kt === "enterprise" || kt === "tokenplan"
			? kt
			: dailyQuotaSec === null
				? "enterprise"
				: "tokenplan";
	if (dailyRaw === undefined && process.env.VIDEO_AGENT_SILENCE_QUOTA_HINT !== "1") {
		console.warn(
			"[video-agent] 未设置 VIDEO_AGENT_QUOTA_DAILY_SEC，按保守默认 500s/天记账（当前 Agnes Key 为企业版，真实额度更高）。" +
				"要放开请设 VIDEO_AGENT_QUOTA_DAILY_SEC=<秒数>（\"0\" = 不限每日量，只受 RPM 约束；" +
				"视频模型限时免费期推荐设 0）；测试环境可设 VIDEO_AGENT_SILENCE_QUOTA_HINT=1 关闭本提示。",
		);
	}
	// ① 显式多池配置（VIDEO_AGENT_QUOTA_POOLS）优先——精细控制每池的 keyType/rpmCap/dailyQuotaSec
	const explicit = parsePools();
	if (explicit) return new QuotaLedger(explicit);
	// ② 自动探测：从 models.json 的 video adapter 自动建多池（一 key 一池 + adapterId 绑定）。
	// 这样配了 4 个 adapter 就自动有 4 个池，pickPool 会自动选最早可用的池，submit 时走绑定的 adapter。
	// 单 adapter 时不走这条（回退③单池，保持旧行为不破坏）。
	// 容错与 ① 同 philosophy：adapter id 重复 = 配置坏了（账本无法建池、队列解析也会错位），
	// 整份丢弃回退单池，宁可退化单 key 也不让服务起不来。
	if (mediaConfig) {
		const videoAdapters = mediaConfig.media.filter((m) => m.kind === "video");
		const uniqueIds = new Set(videoAdapters.map((a) => a.id));
		if (videoAdapters.length > 1 && uniqueIds.size === videoAdapters.length) {
			return new QuotaLedger(
				videoAdapters.map((a) => ({
					id: a.id,
					keyType,
					rpmCap,
					dailyQuotaSec,
					adapterId: a.id,
				})),
			);
		}
		if (videoAdapters.length > 1 && uniqueIds.size !== videoAdapters.length && process.env.VIDEO_AGENT_SILENCE_QUOTA_HINT !== "1") {
			console.warn("[video-agent] models.json 存在重复 id 的 video adapter，无法一 key 一池，回退单池配置。请修正 adapter id 后重启。");
		}
	}
	// ③ 回退单池（旧行为）
	return new QuotaLedger([{ id: VIDEO_QUOTA_POOL, keyType, rpmCap, dailyQuotaSec }]);
}

/** 合法的 Key 层级（与 quota.ts 的 KeyType 对齐） */
const KEY_TYPES = ["free", "enterprise", "tokenplan"] as const;

/**
 * 解析多池配置 —— **每个 key 限流独立**（2026-08-29 郭煜实测确认），
 * 所以 N 个 key 应配成 N 个池，总提交速率 = 各池 RPM 之和（线性叠加）。
 *
 *   VIDEO_AGENT_QUOTA_POOLS='[{"id":"ent-1","keyType":"enterprise","rpmCap":2},
 *                             {"id":"ent-2","keyType":"enterprise","rpmCap":2}]'
 *
 * 字段：id（唯一）/ keyType / rpmCap（>0）/ dailyQuotaSec（可选，null 或省略 = 无每日配额）。
 * 未设该变量时返回 null → 调用方回退到单池环境变量（DAILY_SEC / RPM / KEY_TYPE），保持向后兼容。
 *
 * 容错优先：任何一项不合法都**整份丢弃并回退单池**，避免配置写错导致产线无配额可用。
 */
function parsePools(): PoolSpec[] | null {
	const raw = process.env.VIDEO_AGENT_QUOTA_POOLS;
	if (raw === undefined || raw.trim() === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warnPools("JSON 解析失败");
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		warnPools("应为非空数组");
		return null;
	}
	const pools: PoolSpec[] = [];
	const seen = new Set<string>();
	const seenAdapters = new Set<string>();
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) return warnPools("元素应为对象");
		const { id, keyType, rpmCap, dailyQuotaSec, adapterId } = item as Record<string, unknown>;
		if (typeof id !== "string" || id === "") return warnPools("id 应为非空字符串");
		if (seen.has(id)) return warnPools(`id 重复：${id}`);
		if (typeof keyType !== "string" || !KEY_TYPES.includes(keyType as (typeof KEY_TYPES)[number])) {
			return warnPools(`keyType 应为 ${KEY_TYPES.join(" / ")} 之一（id=${id}）`);
		}
		if (typeof rpmCap !== "number" || !Number.isFinite(rpmCap) || rpmCap <= 0) {
			return warnPools(`rpmCap 应为正数（id=${id}）`);
		}
		// adapterId 绑定真实 key（models.json media 条目）：选池后任务投给该 adapter，
		// 才能把"多 key 记账"落到"多 key 真实并发"。同一 adapter 最多绑一个池（一对一才账实相符）
		let boundAdapter: string | undefined;
		if (adapterId !== undefined && adapterId !== null) {
			if (typeof adapterId !== "string" || adapterId === "") {
				return warnPools(`adapterId 应为非空字符串（id=${id}）`);
			}
			if (seenAdapters.has(adapterId)) {
				return warnPools(`adapterId 重复绑定：${adapterId}（一个 key 一个池才账实相符）`);
			}
			boundAdapter = adapterId;
			seenAdapters.add(adapterId);
		}
		const daily =
			dailyQuotaSec === undefined || dailyQuotaSec === null
				? null
				: typeof dailyQuotaSec === "number" && dailyQuotaSec > 0
					? dailyQuotaSec
					: null;
		seen.add(id);
		pools.push({
			id,
			keyType: keyType as KeyType,
			rpmCap,
			dailyQuotaSec: daily,
			...(boundAdapter ? { adapterId: boundAdapter } : {}),
		});
	}
	return pools;
}

function warnPools(reason: string): null {
	if (process.env.VIDEO_AGENT_SILENCE_QUOTA_HINT !== "1") {
		console.warn(
			`[video-agent] VIDEO_AGENT_QUOTA_POOLS 无效（${reason}），回退单池配置（VIDEO_AGENT_QUOTA_DAILY_SEC / _RPM / _KEY_TYPE）。`,
		);
	}
	return null;
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
		quota: loadQuotaLedger(mediaConfig),
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
