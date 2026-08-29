/**
 * A2 真镜端到端（一次性脚本，不入测试套件）：
 * 1. hostAudioFile 托管台词音频 → COS 公开 URL
 * 2. 2.5-flash reference 任务（audios=[URL] + prompt <Audio 1> 占位符）
 * 3. 轮询 agnesapi → completed → 下载 mp4
 * 验收 = 人眼确认口型与音频对上（dev-log 4.2.4 清单第 ② 项）。
 */
import * as path from "node:path";
import * as fs from "node:fs";
import * as url from "node:url";
import { hostAudioFile } from "../src/hosting/tcb.ts";

const serverRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const studioRoot = path.resolve(serverRoot, "..", "..", "..");

// --- 视频模型连接参数（.pi-studio/models.json，不入库） ---
const models = JSON.parse(fs.readFileSync(path.join(studioRoot, ".pi-studio", "models.json"), "utf-8")) as {
	media: { kind: string; model: string; baseUrl: string; path?: string; apiKey: string; poll?: Record<string, unknown> }[];
};
const video = models.media.find((m) => m.kind === "video");
if (!video) {
	console.error("models.json 无 video 模型");
	process.exit(1);
}
const MODEL = video.model;
const BASE = video.baseUrl.replace(/\/$/, "");
const KEY = video.apiKey;
const POLL = (video.poll ?? {}) as {
	taskIdPath?: string;
	statusUrl?: string;
	statusPath?: string;
	doneValues?: string[];
	failedValues?: string[];
	resultPath?: string;
	intervalMs?: number;
	maxPolls?: number;
};

// --- 1. 托管 ---
const audioLocal = path.join(studioRoot, "_tts_test", "cn_ref.mp3");
console.log("[1/3] hosting audio...");
const audioUrl = await hostAudioFile(studioRoot, "e2e-a2", "SH01", audioLocal);
console.log("audioUrl:", audioUrl);

// --- 2. reference 提交 ---
console.log("[2/3] submitting reference task...");
const prompt = "一个年轻男性面向镜头说话，特写，自然口型，电影级画质。<Audio 1>";
const createRes = await fetch(`${BASE}${video.path ?? "/v1/videos"}`, {
	method: "POST",
	headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
	body: JSON.stringify({ model: MODEL, seconds: "5", mode: "reference", audios: [audioUrl], prompt, size: "720P" }),
});
const createText = await createRes.text();
console.log("create status:", createRes.status, createText.slice(0, 300));
if (!createRes.ok) process.exit(2);
const created = JSON.parse(createText) as Record<string, unknown>;
const taskId = String(created[POLL.taskIdPath ?? "video_id"] ?? created.id ?? "");
if (!taskId) {
	console.error("no task id");
	process.exit(3);
}
console.log("taskId:", taskId);

// --- 3. 轮询 ---
console.log("[3/3] polling...");
const statusUrl = (POLL.statusUrl ?? `${BASE}/v1/videos/{{taskId}}`).replace("{{taskId}}", taskId);
const intervalMs = POLL.intervalMs ?? 4000;
const maxPolls = POLL.maxPolls ?? 150;
const doneValues = POLL.doneValues ?? ["completed"];
const failedValues = POLL.failedValues ?? ["failed", "error"];
const resultPath = POLL.resultPath ?? "url";
const pick = (obj: unknown, dotted: string): unknown =>
	dotted.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
let videoUrl: string | null = null;
for (let i = 1; i <= maxPolls; i += 1) {
	const res = await fetch(statusUrl, { headers: { Authorization: `Bearer ${KEY}` } });
	const text = await res.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		console.log(`poll ${i}: non-json ${text.slice(0, 120)}`);
		await new Promise((r) => setTimeout(r, intervalMs));
		continue;
	}
	const status = String(pick(body, POLL.statusPath ?? "status") ?? "");
	if (i % 5 === 0 || doneValues.includes(status) || failedValues.includes(status)) {
		console.log(`poll ${i}: status=${status}`);
	}
	if (doneValues.includes(status)) {
		videoUrl = String(pick(body, resultPath) ?? "");
		break;
	}
	if (failedValues.includes(status)) {
		console.error("task failed:", text.slice(0, 400));
		process.exit(4);
	}
	await new Promise((r) => setTimeout(r, intervalMs));
}
if (!videoUrl) {
	console.error("timeout / no url");
	process.exit(5);
}
console.log("videoUrl:", videoUrl);
const out = path.join(studioRoot, "_tts_test", "e2e-a2-SH01.mp4");
const bin = await fetch(videoUrl).then((r) => r.arrayBuffer());
fs.writeFileSync(out, Buffer.from(bin));
console.log(`saved: ${out} (${(bin.byteLength / 1024).toFixed(0)} KB)`);
console.log("✅ E2E 完成 —— 请人眼确认口型与「你好，世界。」音频对上（4.2.4 验收②）");
