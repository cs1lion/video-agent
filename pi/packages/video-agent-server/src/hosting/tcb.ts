/**
 * CloudBase 音频托管（A2 · 台词链路第 3 步）。
 *
 * 台词是视频生成的"驱动源"，2.5-flash 的 `audios` 参数要求**公开可访问的 URL**，
 * 而 StepFun TTS 只返回二进制——必须自行托管。本模块把 run 目录里的台词 mp3
 * 上传到 CloudBase 云存储，返回公开下载域 URL（匿名可读、支持 Range、长期有效）。
 *
 * 前置条件：CloudBase 控制台把该环境的**存储权限设为「所有用户可读」**。
 * 若首测 403，退路是切静态网站托管（本模块边界不变，只换实现）。
 *
 * 凭据来源（优先级从高到低）：
 *   1. 环境变量 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
 *   2. `<studioRoot>/.pi-studio/.env.cloudbase`
 *   3. `<包根>/.env.cloudbase`
 * 文件格式：`KEY=VALUE` 每行一条，`#` 注释，值可带引号。该路径已被 .gitignore
 * 的 `.env*` 覆盖——密钥严禁进仓库（1.7 教训）。
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
	secretId: string;
	secretKey: string;
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

/** 云存储公开下载域 URL（纯函数，可测） */
export function publicUrlFor(envId: string, cloudPath: string): string {
	return `https://${envId}.tcb.qcloud.la/${cloudPath.replace(/^\/+/, "")}`;
}

/** 上传落点：按 run/shot 归位，重复上传同路径即覆盖（幂等） */
export function cloudPathFor(runId: string, shotId: string): string {
	return `video-agent/${runId}/tts-${shotId}.mp3`;
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
			if (parsed.TCB_ENV_ID && parsed.TCB_SECRET_ID && parsed.TCB_SECRET_KEY) return parsed;
		} catch {
			// 文件不存在/不可读 → 试下一个候选
		}
	}
	return {};
}

let cachedConfig: HostingConfig | null | undefined;

/** 读取托管配置；未配置返回 null（调用方走降级）。进程内缓存（配置视为静态）。 */
export function loadHostingConfig(studioRoot: string): HostingConfig | null {
	if (cachedConfig !== undefined) return cachedConfig;
	const envId = process.env.TCB_ENV_ID;
	const secretId = process.env.TCB_SECRET_ID;
	const secretKey = process.env.TCB_SECRET_KEY;
	if (envId && secretId && secretKey) {
		cachedConfig = { envId, secretId, secretKey };
		return cachedConfig;
	}
	const fromFile = readEnvFileCandidates(studioRoot);
	cachedConfig =
		fromFile.TCB_ENV_ID && fromFile.TCB_SECRET_ID && fromFile.TCB_SECRET_KEY
			? { envId: fromFile.TCB_ENV_ID, secretId: fromFile.TCB_SECRET_ID, secretKey: fromFile.TCB_SECRET_KEY }
			: null;
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
	uploadFile(args: { cloudPath: string; localPath: string }): Promise<{ fileID?: string }>;
}
interface TcbSdkModule {
	default: { init(cfg: { secretId: string; secretKey: string; env: string }): TcbUploadApp };
}

let cachedApp: { key: string; app: TcbUploadApp } | null = null;

async function appOf(config: HostingConfig): Promise<TcbUploadApp> {
	const key = `${config.envId}:${config.secretId}`;
	if (cachedApp?.key === key) return cachedApp.app;
	let mod: TcbSdkModule;
	try {
		mod = (await import("@cloudbase/node-sdk")) as unknown as TcbSdkModule;
	} catch (error) {
		throw new HostingError(`CloudBase SDK 加载失败（依赖未安装？）: ${String(error)}`);
	}
	const app = mod.default.init({ secretId: config.secretId, secretKey: config.secretKey, env: config.envId });
	cachedApp = { key, app };
	return app;
}

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
 * 上传台词音频到 CloudBase，返回公开 URL。
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
	try {
		await app.uploadFile({ cloudPath, localPath: localAbsPath });
	} catch (error) {
		throw new HostingError(`CloudBase 上传失败（${cloudPath}）: ${String(error)}`);
	}
	return publicUrlFor(config.envId, cloudPath);
}
