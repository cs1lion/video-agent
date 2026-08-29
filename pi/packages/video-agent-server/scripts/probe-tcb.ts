/**
 * A2 真实验证探针（一次性脚本，不入测试套件）：
 * 1. loadHostingConfig 读 .env.cloudbase → hostAudioFile 上传测试音频 → 公开 URL
 * 2. 匿名 Range 请求 → 期望 206 / audio/mpeg
 */
import { hostAudioFile, loadHostingConfig, isAudioUrlAlive } from "../src/hosting/tcb.ts";
import * as path from "node:path";
import * as url from "node:url";

const studioRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const cfg = loadHostingConfig(studioRoot);
console.log("config loaded:", cfg ? `env=${cfg.envId} mode=${cfg.secretId ? "cam-secret" : "apiKey"}` : "NULL");
if (!cfg) process.exit(1);

const testFile = path.join(studioRoot, "_tts_test", "cn_ref.mp3");
console.log("uploading:", testFile);
const t0 = Date.now();
const uploadedUrl = await hostAudioFile(studioRoot, "probe-a2", "TEST", testFile).catch((e) => {
	console.error("UPLOAD FAILED:", String(e).slice(0, 300));
	process.exit(2);
});
console.log(`uploaded in ${Date.now() - t0}ms → ${uploadedUrl}`);

// 匿名 Range 请求
const res = await fetch(uploadedUrl, { headers: { Range: "bytes=0-1023" } });
console.log("anonymous range:", res.status, res.headers.get("content-type"), `len=${res.headers.get("content-length") ?? res.headers.get("content-range")}`);
const res2 = await fetch(uploadedUrl, { method: "HEAD" });
console.log("anonymous HEAD:", res2.status);
const alive = await isAudioUrlAlive(uploadedUrl);
console.log("isAudioUrlAlive:", alive);
process.exit(res.status === 206 ? 0 : 3);
