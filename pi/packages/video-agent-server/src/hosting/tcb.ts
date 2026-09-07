/**
 * CloudBase 音频托管（A2 · 台词链路第 3 步）。
 *
 * 台词是视频生成的"驱动源"，2.5-flash 的 `audios` 参数要求**公开可访问的 URL**，
 * 而 StepFun TTS 只返回二进制——必须自行托管。本模块把 run 目录里的台词 mp3
 * 上传到 CloudBase 云存储（底层 COS），返回 **COS 直连公开 URL**
 * （`https://{bucket}.cos.{region}.myqcloud.com/{key}`，匿名可读、支持 Range、长期有效）。
 *
 * 2026-08-29 实测定案（dev-log「CloudBase 网关探测结论」）：
 * - 上传走 node-sdk `getUploadMetadata`（TCB 签发 COS 临时签名）→ PUT 直传；
 * - 公开读必须在 **COS 桶级 ACL 设 public-read**（CAM 密钥 `putBucketAcl`，
 *   一次性操作，见 scripts/discover-and-open-bucket.ts）；
 * - `https://{envId}.tcb.qcloud.la` 前置层有自己的权限规则（418），
 *   **不走它**——COS 直连域名不受该层影响，实测匿名 Range 206 audio/mpeg。
 *
 * 凭据来源（优先级从高到低）：
 *   1. 环境变量 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
 *   2. `<studioRoot>/.pi-studio/.env.cloudbase`
 *   3. `<包根>/.env.cloudbase`
 * 文件格式：`KEY=VALUE` 每行一条，`#` 注释，值可带引号。该路径已被 .gitignore
 * 的 `.env*` 覆盖——密钥严禁进仓库（1.7 教训）。
 * 可选 TCB_COS_BUCKET / TCB_COS_REGION：显式指定 COS 桶与区域（跳过自动发现）。
 *
 * 未配置凭据 → loadHostingConfig 返回 null，调用方走降级链（台词镜降旁白），
 * 不阻断管线——「降级优于阻断」。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export class HostingError extends Error {}

export interface HostingConfig {
	envId: string;
	/** CloudBase API Key（JWT 形态，service_role；node-sdk 上传链路未被官方支持，优先用 CAM 密钥） */
	apiKey?: string;
	secretId?: string;
	secretKey?: string;
	/** COS 桶名/区域（可选显式指定；缺省由上传元数据自动发现并缓存） */
	cosBucket?: string;
	cosRegion?: string;
}

/** 解析 .env 风格文本（纯函数，可测） */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key) out[key] = value;
	}
	return out;
}

/**
 * COS 直连公开 URL（纯函数，可测）。注意第一参是**桶名**（如
 * `6d79-myagent-xxx-1253451683`），不是 envId——tcb.qcloud.la 前置层有自己的
 * 权限规则（匿名 418），COS 直连域名只受桶 ACL 约束（public-read 后匿名可读）。
 */
export function publicUrlFor(bucket: string, region: string, cloudPath: string): string {
	return `https://${bucket}.cos.${region}.myqcloud.com/${cloudPath.replace(/^\/+/, "")}`;
}

/** 从上传元数据 URL 解析 COS 桶名与区域（纯函数，可测） */
export function parseCosUploadUrl(uploadUrl: string): { bucket: string; region: string } | null {
	const m = uploadUrl.match(/https:\/\/([^.]+)\.cos\.([^.]+)\.myqcloud\.com/);
	return m ? { bucket: m[1]!, region: m[2]! } : null;
}

/** 上传落点：按 run/shot 归位，重复上传同路径即覆盖（幂等） */
export function cloudPathFor(runId: string, shotId: string): string {
	return `video-agent/${runId}/tts-${shotId}.mp3`;
}

/** 上传落点（图片）：独立路径，按实体类型分目录避免被同名 shot 覆盖。
 * 生成与设计图在同一 run 下不会重名，但 shotId 可能与 design 同名，所以按 caller 传 filename 避免冲突。 */
export function imageCloudPathFor(runId: string, filename: string): string {
	return `video-agent/${runId}/design/${filename}`;
}

function readEnvFileCandidates(studioRoot: string): Record<string, string> {
	const candidates = [
		path.join(studioRoot, ".pi-studio", ".env.cloudbase"),
		// 包根（src/hosting/tcb.ts 向上两级）；用 fileURLToPath 而非 process.cwd，测试与 dev 均稳
		path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.cloudbase"),
	];
	for (const file of candidates) {
		try {
			const text = fs.readFileSync(file, "utf-8");
			const parsed = parseEnvFile(text);
			if (parsed.TCB_ENV_ID && (parsed.TCB_API_KEY || (parsed.TCB_SECRET_ID && parsed.TCB_SECRET_KEY))) return parsed;
		} catch {
			// 文件不存在/不可读 → 试下一个候选
		}
	}
	return {};
}

let cachedConfig: HostingConfig | null | undefined;

function configFromEntries(envId: string | undefined, e: Record<string, string>): HostingConfig | null {
	if (!envId || !(e.TCB_API_KEY || (e.TCB_SECRET_ID && e.TCB_SECRET_KEY))) return null;
	return {
		envId,
		...(e.TCB_SECRET_ID && e.TCB_SECRET_KEY ? { secretId: e.TCB_SECRET_ID, secretKey: e.TCB_SECRET_KEY } : {}),
		...(e.TCB_API_KEY ? { apiKey: e.TCB_API_KEY } : {}),
		...(e.TCB_COS_BUCKET && e.TCB_COS_REGION ? { cosBucket: e.TCB_COS_BUCKET, cosRegion: e.TCB_COS_REGION } : {}),
	};
}

/** 读取托管配置；未配置返回 null（调用方走降级）。进程内缓存（配置视为静态）。 */
export function loadHostingConfig(studioRoot: string): HostingConfig | null {
	if (cachedConfig !== undefined) return cachedConfig;
	cachedConfig = configFromEntries(process.env.TCB_ENV_ID, process.env as unknown as Record<string, string>);
	if (cachedConfig) return cachedConfig;
	const fromFile = readEnvFileCandidates(studioRoot);
	cachedConfig = configFromEntries(fromFile.TCB_ENV_ID, fromFile);
	return cachedConfig;
}

/** 测试注入点：清空进程级缓存 */
export function resetHostingConfigCache(): void {
	cachedConfig = undefined;
}

// ---------------------------------------------------------------------------
// SDK 薄封装（惰性初始化；结构性类型，不引 SDK 的类型导出——CJS 互操作不稳）
// ---------------------------------------------------------------------------

interface TcbUploadApp {
	/** 上传元数据：TCB 签发的 COS 临时签名 + 直传 URL（内含桶名/区域）；包一层 { requestId, data } */
	getUploadMetadata(args: { cloudPath: string }): Promise<{
		requestId?: string;
		data?: {
			url?: string;
			authorization?: string;
			token?: string;
			cosFileId?: string;
		};
	}>;
}
interface TcbSdkModule {
	default: {
		init(cfg: {
			env: string;
			apiKey?: string;
			secretId?: string;
			secretKey?: string;
		}): TcbUploadApp;
	};
}

let cachedApp: { key: string; app: TcbUploadApp } | null = null;

async function appOf(config: HostingConfig): Promise<TcbUploadApp> {
	const key = `${config.envId}:${config.secretId ?? config.apiKey ?? ""}`;
	if (cachedApp?.key === key) return cachedApp.app;
	let mod: TcbSdkModule;
	try {
		mod = (await import("@cloudbase/node-sdk")) as unknown as TcbSdkModule;
	} catch (error) {
		throw new HostingError(`CloudBase SDK 加载失败（依赖未安装？）: ${String(error)}`);
	}
	// CAM 密钥优先（node-sdk 存储链路的实证路径）；仅 apiKey 时仍传入（兼容旧配置）
	const app = mod.default.init({
		env: config.envId,
		...(config.secretId && config.secretKey ? { secretId: config.secretId, secretKey: config.secretKey } : {}),
		...(config.secretId && config.secretKey ? {} : config.apiKey ? { apiKey: config.apiKey } : {}),
	});
	cachedApp = { key, app };
	return app;
}

/** COS 桶/区域自动发现缓存（键 = envId；upload 元数据里带桶名，无需额外请求） */
const cosEndpointCache = new Map<string, { bucket: string; region: string }>();

/** 已托管的 URL 是否仍可匿名访问（HEAD 200/206 即认为存活，可复用免重传） */
export async function isAudioUrlAlive(url: string, timeoutMs = 5_000): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	try {
		const res = await fetch(url, { method: "HEAD", signal: controller.signal });
		return res.ok || res.status === 206;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 上传台词音频到 CloudBase（COS），返回 COS 直连公开 URL。
 * 流程：getUploadMetadata（TCB 签发）→ PUT 直传 → 从元数据 URL 解析桶/区域 → 公开 URL。
 * 抛 HostingError（未配置/上传失败）——调用方按降级链处理（台词镜降旁白）。
 */
export async function hostAudioFile(
	studioRoot: string,
	runId: string,
	shotId: string,
	localAbsPath: string,
): Promise<string> {
	const config = loadHostingConfig(studioRoot);
	if (!config) {
		throw new HostingError(
			"未配置 CloudBase 托管（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY 或 .env.cloudbase）——台词镜无法获得公开音频 URL",
		);
	}
	const cloudPath = cloudPathFor(runId, shotId);
	const app = await appOf(config);
	let endpoint: { bucket: string; region: string } | undefined =
		config.cosBucket && config.cosRegion ? { bucket: config.cosBucket, region: config.cosRegion } : cosEndpointCache.get(config.envId);
	try {
		const fileContent = await fs.promises.readFile(localAbsPath);
		const meta = await app.getUploadMetadata({ cloudPath });
		const inner = (meta.data ?? {}) as { url?: string; authorization?: string; token?: string; cosFileId?: string };
		if (!inner.url || !inner.authorization || !inner.token) {
			throw new HostingError(`上传元数据缺失（url/authorization/token）：${JSON.stringify(Object.keys(meta))}`);
		}
		if (!endpoint) {
			const parsed = parseCosUploadUrl(inner.url);
			if (!parsed) throw new HostingError(`无法从上传 URL 解析 COS 桶/区域：${inner.url.slice(0, 120)}`);
			endpoint = parsed;
			cosEndpointCache.set(config.envId, endpoint);
		}
		// 与 node-sdk uploadFile 同一套头（签名覆盖本 key 的本次直传）
		const res = await fetch(inner.url, {
			method: "PUT",
			headers: {
				Authorization: inner.authorization,
				Signature: inner.authorization,
				"x-cos-security-token": inner.token,
				"x-cos-meta-fileid": inner.cosFileId ?? "",
				key: encodeURIComponent(cloudPath),
			},
			body: new Uint8Array(fileContent),
		});
		if (!res.ok) {
			throw new HostingError(`COS PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
	} catch (error) {
		if (error instanceof HostingError) throw error;
		throw new HostingError(`CloudBase 上传失败（${cloudPath}）: ${String(error)}`);
	}
	if (!endpoint) throw new HostingError("COS 桶/区域未知（不应发生）");
	return publicUrlFor(endpoint.bucket, endpoint.region, cloudPath);
}

/**
 * 通用文件托管（用于图片等非音频资源）。返回公开 URL。
 * 与 hostAudioFile 共享同一 COS 桶/上传元数据流程，仅 cloudPath 不同。
 * 不传 CloudBase 配置时抛 HostingError（与 hostAudioFile 行为一致）。
 */
export async function hostFile(
	studioRoot: string,
	runId: string,
	cloudPath: string,
	localAbsPath: string,
): Promise<string> {
	const config = loadHostingConfig(studioRoot);
	if (!config) {
		throw new HostingError(
			"未配置 CloudBase 托管（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY 或 .env.cloudbase）——设计图/资产无法获得公开 URL",
		);
	}
	const app = await appOf(config);
	let endpoint: { bucket: string; region: string } | undefined =
		config.cosBucket && config.cosRegion ? { bucket: config.cosBucket, region: config.cosRegion } : cosEndpointCache.get(config.envId);
	try {
		const fileContent = await fs.promises.readFile(localAbsPath);
		const meta = await app.getUploadMetadata({ cloudPath });
		const inner = (meta.data ?? {}) as { url?: string; authorization?: string; token?: string; cosFileId?: string };
		if (!inner.url || !inner.authorization || !inner.token) {
			throw new HostingError(`上传元数据缺失（url/authorization/token）：${JSON.stringify(Object.keys(meta))}`);
		}
		if (!endpoint) {
			const parsed = parseCosUploadUrl(inner.url);
			if (!parsed) throw new HostingError(`无法从上传 URL 解析 COS 桶/区域：${inner.url.slice(0, 120)}`);
			endpoint = parsed;
			cosEndpointCache.set(config.envId, endpoint);
		}
		const res = await fetch(inner.url, {
			method: "PUT",
			headers: {
				Authorization: inner.authorization,
				Signature: inner.authorization,
				"x-cos-security-token": inner.token,
				"x-cos-meta-fileid": inner.cosFileId ?? "",
				key: encodeURIComponent(cloudPath),
			},
			body: new Uint8Array(fileContent),
		});
		if (!res.ok) {
			throw new HostingError(`COS PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
	} catch (error) {
		if (error instanceof HostingError) throw error;
		throw new HostingError(`CloudBase 上传失败（${cloudPath}）: ${String(error)}`);
	}
	if (!endpoint) throw new HostingError("COS 桶/区域未知（不应发生）");
	return publicUrlFor(endpoint.bucket, endpoint.region, cloudPath);
}
