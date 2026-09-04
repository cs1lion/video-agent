/**
 * N1 词级时间戳字幕 · 探针脚本
 *
 * L1：纯 TTS（最便宜）—— 验证 StepFun 接受 `timestamp=true, return_url=true` 且返回 words
 * L2：单镜端到端（端到端 + 字幕）—— 验证 wordTimestamps 流过整个管线
 * L3：实测偏差 ≤0.2s（验收）—— ffmpeg silencedetect 对比 wordTimestamps[0].start
 *
 * 用法：
 *   VIDEO_AGENT_WORD_TIMESTAMPS=1 node e2e/probe-word-timestamps.mjs            # L1+L2+L3（默认 8790）
 *   VIDEO_AGENT_WORD_TIMESTAMPS=1 node e2e/probe-word-timestamps.mjs --l1-only  # 仅 L1
 *   VIDEO_AGENT_WORD_TIMESTAMPS=1 node e2e/probe-word-timestamps.mjs --raw      # L1 打到失败前打印 raw response
 *
 * 退出码：0 全部通过 / 1 任一关失败
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE_URL = process.env.PROBE_BASE_URL ?? "http://127.0.0.1:8790";
const L1_ONLY = process.argv.includes("--l1-only");
const RAW = process.argv.includes("--raw");
const RESULTS_DIR = path.resolve("e2e/results");

// ---- 配色（小工具） ----
const C = { ok: "\x1b[32m", warn: "\x1b[33m", err: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m" };
const log = (label, msg, color = "reset") => console.log(`${C.dim}[${label}]${C.reset} ${C[color]}${msg}${C.reset}`);
const fail = (label, msg) => { log(label, `❌ ${msg}`, "err"); process.exitCode = 1; };
const ok = (label, msg) => log(label, `✅ ${msg}`, "ok");

// ============================================================
// L1 · 纯 TTS 探针
// ============================================================
async function runL1() {
	log("L1", `纯 TTS 探针（验证 StepFun 接受 timestamp+return_url）`);
	const cfg = JSON.parse(readFileSync(".pi-studio/models.json", "utf-8"));
	const tts = cfg.media.find((m) => m.kind === "tts");
	if (!tts) throw new Error("models.json 找不到 tts 适配器");

	const apiKey = tts.apiKeyEnv ? process.env[tts.apiKeyEnv] ?? tts.apiKey : tts.apiKey;
	if (!apiKey) throw new Error("models.json 的 tts 适配器没 apiKey");

	const { createOpenAICompatibleAdapter } = await import("../pi/packages/coding-agent/examples/extensions/studio/media/openai-compatible.ts");
	const adapter = createOpenAICompatibleAdapter({
		id: tts.id, kind: "tts", type: "openai-compatible",
		baseUrl: tts.baseUrl, path: tts.path, model: tts.model, apiKey,
		voice: tts.voice,
	});

	const t0 = Date.now();
	const tmpDir = mkdtempSync(path.join(tmpdir(), "probe-l1-"));
	const result = await adapter.generate({
		kind: "tts", prompt: "你好世界，今天天气真不错，咱们去吃点东西吧。",
		params: { timestamp: true, return_url: true, voice: tts.voice, instruction: "中性自然" },
		outputBase: path.join(tmpDir, "tts-probe"),
		signal: new AbortController().signal,
	});
	const elapsed = Date.now() - t0;
	log("L1", `请求耗时 ${elapsed}ms`);

	// ---- 判读 ----
	if (!result.meta) {
		fail("L1", "响应没有 meta 字段（StepFun 没回 JSON，可能仍是二进制流）");
		return null;
	}
	const wt = result.meta.wordTimestamps;
	if (!Array.isArray(wt) || wt.length === 0) {
		fail("L1", `wordTimestamps 缺失或为空数组：${JSON.stringify(wt)}`);
		return null;
	}
	const bad = wt.filter((w) => !Number.isFinite(w.start) || !Number.isFinite(w.end) || !w.text);
	if (bad.length > 0) {
		fail("L1", `有 ${bad.length} 项非法（NaN/缺字段）：${JSON.stringify(bad)}`);
		return null;
	}
	ok("L1", `返回 ${wt.length} 个词时间戳，时间范围 [${wt[0].start.toFixed(2)}s, ${wt[wt.length - 1].end.toFixed(2)}s]`);

	const audioSize = statSync(result.filePath).size;
	ok("L1", `音频文件 ${(audioSize / 1024).toFixed(1)} KB（${result.filePath.split(/[\\/]/).pop()}）`);

	if (!L1_ONLY) {
		log("L1", `保存 TTS 产物供 L3 silencedetect 对比`);
		writeFileSync(path.join(tmpDir, "l1-wordtimestampts.json"), JSON.stringify(wt, null, 2));
		return { wt, audioPath: result.filePath };
	}
	rmSync(tmpDir, { recursive: true, force: true });
	return null;
}

// ============================================================
// L2 · 单镜端到端（HTTP /api/generate + /api/runs/:id）
// ============================================================
async function runL2() {
	log("L2", `单镜端到端（POST ${BASE_URL}/api/generate）`);

	// 最小 brief：1 镜 + 1 台词镜，避免浪费配额
	const brief = {
		logline: "测试台词字幕起止对齐",
		generationOptions: {
			resolution: "720p", aspectRatio: "16:9",
			shotCount: 1, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: false,
			promptLanguage: "zh", negativePrompt: "",
			audioDrive: "dialogue",
		},
		coSpace: {
			characters: [{ name: "测试员", description: "30 岁男性测试员，灰 T 恤" }],
			scenes: [{ name: "测试场景", description: "白墙干净室内" }],
		},
	};

	// 1. 提交
	const submitResp = await fetch(`${BASE_URL}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(brief),
	});
	if (!submitResp.ok) {
		fail("L2", `POST /api/generate 失败 HTTP ${submitResp.status}: ${(await submitResp.text()).slice(0, 200)}`);
		return null;
	}
	const submitJson = await submitResp.json();
	const runId = submitJson.runId ?? submitJson.id;
	if (!runId) {
		fail("L2", `响应里没有 runId：${JSON.stringify(submitJson)}`);
		return null;
	}
	ok("L2", `runId=${runId}`);

	// 2. 轮询（最长 10 分钟）
	const t0 = Date.now();
	let finalRun = null;
	while (Date.now() - t0 < 10 * 60 * 1000) {
		await new Promise((r) => setTimeout(r, 5000));
		const resp = await fetch(`${BASE_URL}/api/runs/${runId}`);
		if (!resp.ok) continue;
		const run = await resp.json();
		const status = run.status ?? run.stage;
		const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
		log("L2", `状态=${status} (${elapsed}s)`);
		if (status === "done" || status === "completed") { finalRun = run; break; }
		if (status === "failed" || status === "error") {
			fail("L2", `run 失败：${JSON.stringify(run).slice(0, 400)}`);
			return null;
		}
	}
	if (!finalRun) {
		fail("L2", `轮询超时（10 分钟）`);
		return null;
	}
	ok("L2", `run 完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

	// 3. 找产物目录
	const candidates = [];
	try {
		const entries = readFileSync(path.join(".pi-studio", "video-agent-runs", "_runs.json"), "utf-8");
		candidates.push(...JSON.parse(entries));
	} catch {}
	try {
		const entries = readFileSync(path.join(".pi-studio", "video-agent-runs", "_runs.json"), "utf-8");
		const r = JSON.parse(entries).runs ?? [];
		candidates.push(...r);
	} catch {}

	let runDir = candidates.find((r) => r.id === runId)?.dir ?? candidates.find((r) => r.runId === runId)?.dir;
	if (!runDir) {
		// fallback: 找最新 results 目录
		const fs = await import("node:fs/promises");
		try {
			const dirs = (await fs.readdir(RESULTS_DIR)).map((d) => ({ d, t: require("node:fs").statSync(path.join(RESULTS_DIR, d)).mtimeMs })).sort((a, b) => b.t - a.t);
			if (dirs.length > 0) runDir = path.join(RESULTS_DIR, dirs[0].d);
		} catch {}
	}
	if (!runDir) {
		fail("L2", `找不到 runDir for ${runId}`);
		return null;
	}
	ok("L2", `runDir=${path.relative(".", runDir)}`);

	// 4. 判读：script.json 里 dialogue.wordTimestamps
	const scriptPath = path.join(runDir, "script.json");
	if (!existsSync(scriptPath)) {
		fail("L2", `script.json 不存在：${scriptPath}`);
		return null;
	}
	const script = JSON.parse(readFileSync(scriptPath, "utf-8"));
	const dlg = script.shots?.[0]?.dialogue;
	if (!dlg) {
		fail("L2", `第一镜没有 dialogue 字段`);
		return null;
	}
	const wt = dlg.wordTimestamps;
	if (!Array.isArray(wt) || wt.length === 0) {
		fail("L2", `dialogue.wordTimestamps 缺失或空（说明 VIDEO_AGENT_WORD_TIMESTAMPS=1 没传给 TTS，或 TTS 没回 words）`);
		return null;
	}
	ok("L2", `script.json: dialogue.wordTimestamps = ${wt.length} 项，首词 "${wt[0].text}" @ ${wt[0].start.toFixed(3)}s`);

	// 5. 判读：subs.ass 里 Dialogue 行 Start 与 wordTimestamps[0].start 对齐
	const assPath = path.join(runDir, "assets", "subs.ass");
	if (!existsSync(assPath)) {
		log("L2", `⚠️  subs.ass 不存在（run 可能没走到 export）`, "warn");
		return { runDir, dlg, wt, audioPath: path.join(runDir, "assets", `tts-dialogue-${dlg.id || "SH01"}.mp3`) };
	}
	const assText = readFileSync(assPath, "utf-8");
	const dialogueLines = assText.split(/\r?\n/).filter((l) => l.startsWith("Dialogue:"));
	log("L2", `subs.ass 共 ${dialogueLines.length} 行 Dialogue`);
	if (dialogueLines.length > 0) {
		const firstLine = dialogueLines[0];
		const fields = firstLine.split(",");
		// 字段 1 = Start (h:mm:ss.cs)
		const startField = fields[1];
		const assStart = parseAssTimestamp(startField);
		log("L2", `第一行字幕 Start=${startField} (${assStart.toFixed(3)}s)`);
		const expectedStart = wt[0].start; // 本镜首词起点（已加 shotStart）
		const diff = Math.abs(assStart - expectedStart);
		if (diff <= 0.2) {
			ok("L2", `字幕起 vs wordTimestamps[0].start 偏差 ${diff.toFixed(3)}s ≤ 0.2s ✓`);
		} else {
			fail("L2", `字幕起 vs wordTimestamps[0].start 偏差 ${diff.toFixed(3)}s > 0.2s（ROADMAP 验收失败）`);
		}
	}
	return { runDir, dlg, wt, audioPath: path.join(runDir, "assets", `tts-dialogue-${dlg.id || "SH01"}.mp3`) };
}

function parseAssTimestamp(s) {
	const m = s.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
	if (!m) return NaN;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

// ============================================================
// L3 · ffmpeg silencedetect vs wordTimestamps[0].start
// ============================================================
async function runL3(l2Result) {
	log("L3", `ffmpeg silencedetect 实测 vs wordTimestamps[0].start`);
	if (!l2Result?.audioPath || !existsSync(l2Result.audioPath)) {
		fail("L3", `TTS 音频不存在：${l2Result?.audioPath}`);
		return;
	}

	const ff = spawnSync("ffmpeg", [
		"-i", l2Result.audioPath,
		"-af", "silencedetect=noise=-30dB:d=0.05",
		"-f", "null", "-",
	], { encoding: "utf-8", timeout: 30_000 });
	if (ff.status !== 0) {
		fail("L3", `ffmpeg 失败 exit=${ff.status}: ${ff.stderr.slice(-200)}`);
		return;
	}
	// 找首个 silence_end（= 语音段起点）
	const match = ff.stderr.match(/silence_end: ([0-9.]+)/);
	if (!match) {
		fail("L3", `没找到 silence_end（音频可能是纯语音或纯静音）`);
		return;
	}
	const measuredStart = Number(match[1]);
	const expectedStart = l2Result.wt[0].start;
	const diff = Math.abs(measuredStart - expectedStart);
	log("L3", `ffmpeg 实测人声起点 = ${measuredStart.toFixed(3)}s`);
	log("L3", `wordTimestamps[0].start = ${expectedStart.toFixed(3)}s`);
	if (diff <= 0.2) {
		ok("L3", `偏差 ${diff.toFixed(3)}s ≤ 0.2s · ROADMAP N1 验收达成 ✓`);
	} else {
		fail("L3", `偏差 ${diff.toFixed(3)}s > 0.2s · 字幕与人声存在可见不同步`);
	}
}

// ============================================================
// main
// ============================================================
(async () => {
	console.log(`${C.bold}=== N1 词级时间戳探针 ===${C.reset}`);
	console.log(`BASE_URL=${BASE_URL}  L1_ONLY=${L1_ONLY}`);

	const l1 = await runL1();
	if (L1_ONLY) {
		console.log(`\n${C.dim}--l1-only 指定，跳过 L2/L3${C.reset}`);
		process.exit(process.exitCode ?? 0);
	}
	if (process.exitCode) {
		console.log(`\n${C.err}L1 失败，跳过 L2/L3${C.reset}`);
		process.exit(1);
	}
	const l2 = await runL2();
	if (!l2 || process.exitCode) {
		console.log(`\n${C.err}L2 失败，跳过 L3${C.reset}`);
		process.exit(1);
	}
	await runL3(l2);

	console.log(`\n${C.bold}=== 结论 ===${C.reset}`);
	if (process.exitCode) {
		console.log(`${C.err}有失败项，请按上面 ❌ 行修复后重试${C.reset}`);
		process.exit(1);
	}
	console.log(`${C.ok}三关全过，可以上线。${C.reset}`);
	console.log(`${C.dim}下一步：去掉 env gate 默认开启（dialogue-audio.ts 改 1 行）${C.reset}`);
})().catch((e) => {
	console.error(`${C.err}未捕获异常：${e.stack ?? e}${C.reset}`);
	process.exit(1);
});
