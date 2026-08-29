/**
 * reference 跟随度实验（08-29）：同一参考音频（cn_ref.mp3），对比不同 prompt
 * 形态的包络相关性（08-28 基线 flash_cn.mp4 = +0.665；占位符裸放 = -0.227）。
 * 用法：npx tsx scripts/e2e-reference-variant.ts <variant: v1|v2> <outName>
 *   v1 = 严格指令前置；v2 = 指令后置（与生产 helper 同形，方差重采样）
 * 提交间隔由 2 RPM 决定——脚本一次只跑一个变体，调用方自行间隔 ≥35s。
 */
import * as path from "node:path";
import * as fs from "node:fs";
import * as url from "node:url";
import { hostAudioFile } from "../src/hosting/tcb.ts";

const serverRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const studioRoot = path.resolve(serverRoot, "..", "..", "..");
const variant = process.argv[2] ?? "v1";
const outName = process.argv[3] ?? `e2e-variant-${variant}.mp4`;

const models = JSON.parse(fs.readFileSync(path.join(studioRoot, ".pi-studio", "models.json"), "utf-8")) as {
	media: { kind: string; model: string; baseUrl: string; path?: string; apiKey: string; poll?: Record<string, unknown> }[];
};
const video = models.media.find((m) => m.kind === "video");
if (!video) {
	console.error("models.json 无 video 模型");
	process.exit(1);
}
const BASE = video.baseUrl.replace(/\/$/, "");
const KEY = video.apiKey;
const POLL = (video.poll ?? {}) as Record<string, unknown> & {
	intervalMs?: number;
	maxPolls?: number;
	doneValues?: string[];
	failedValues?: string[];
	resultPath?: string;
};

const visual = "一个年轻男性面向镜头说话，特写，自然口型，电影级画质";
const strict = "严格按 <Audio 1> 的内容与节奏说话，声音响起时口型开合、静音时闭嘴";
const prompt = variant === "v1" ? `${strict}。${visual}` : `${visual}。${strict}`;

const audioLocal = path.join(studioRoot, "_tts_test", "cn_ref.mp3");
const audioUrl = await hostAudioFile(studioRoot, "e2e-a2", "SH01", audioLocal);
console.log(`[${variant}] audioUrl: ${audioUrl}`);
console.log(`[${variant}] prompt: ${prompt}`);

const createRes = await fetch(`${BASE}${video.path ?? "/v1/videos"}`, {
	method: "POST",
	headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
	body: JSON.stringify({ model: video.model, seconds: "5", mode: "reference", audios: [audioUrl], prompt, size: "720P" }),
});
const createText = await createRes.text();
if (!createRes.ok) {
	console.error("create failed:", createText.slice(0, 300));
	process.exit(2);
}
const taskId = String((JSON.parse(createText) as Record<string, unknown>).video_id ?? "");
console.log(`[${variant}] taskId: ${taskId}`);

const pick = (obj: unknown, dotted: string): unknown =>
	dotted.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
const statusUrl = `${BASE}/agnesapi?video_id=${taskId}&model_name=${video.model}`;
const intervalMs = Number(POLL.intervalMs ?? 4000);
const maxPolls = Number(POLL.maxPolls ?? 150);
let videoUrl: string | null = null;
for (let i = 1; i <= maxPolls; i += 1) {
	const res = await fetch(statusUrl, { headers: { Authorization: `Bearer ${KEY}` } });
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	const status = String(pick(body, String(POLL.statusPath ?? "status")) ?? "");
	if (i % 5 === 0) console.log(`[${variant}] poll ${i}: ${status}`);
	if ((POLL.doneValues as string[] | undefined ?? ["completed"]).includes(status)) {
		videoUrl = String(pick(body, String(POLL.resultPath ?? "url")) ?? "");
		break;
	}
	if ((POLL.failedValues as string[] | undefined ?? ["failed", "error"]).includes(status)) {
		console.error("task failed");
		process.exit(3);
	}
	await new Promise((r) => setTimeout(r, intervalMs));
}
if (!videoUrl) {
	console.error("timeout");
	process.exit(4);
}
const out = path.join(studioRoot, "_tts_test", outName);
const bin = await fetch(videoUrl).then((r) => r.arrayBuffer());
fs.writeFileSync(out, Buffer.from(bin));
console.log(`[${variant}] saved: ${out} (${(bin.byteLength / 1024).toFixed(0)} KB)`);
