#!/usr/bin/env node
/**
 * video-agent · 《青羽的1mm》15秒冬季克制特写 · 端到端生产脚本
 *
 * 工作流：
 *   1) 健康检查 → 启动管线（POST /api/generate）
 *   2) 轮询闸门 A（设计图确认）→ 自动放行（仅 silent 镜，无对话）
 *   3) 轮询闸门 B（关键帧确认）→ 自动放行所有镜头
 *   4) 轮询成片 → 产出 final-9x16.mp4
 *   5) 可选：自动质检-修复闭环（fail/warn+前缀自动补拍）
 *
 * 用法：
 *   node e2e/run-winter-portrait.mjs                          # 默认连 http://127.0.0.1:8790
 *   node e2e/run-winter-portrait.mjs --base=http://host:port  # 自定义地址
 *   node e2e/run-winter-portrait.mjs --dry-run                # 不烧钱，只验证流程
 *   node e2e/run-winter-portrait.mjs --timeout=1800000        # 单次超时（默认 30 分钟）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(HERE, "winter-portrait", "00-input");
const OUTPUT_DIR = path.join(HERE, "winter-portrait");
const RUNS_DIR = path.join(HERE, "winter-portrait", "runs");

// ----- CLI -----
function parseArgs(argv) {
	const args = {
		base: process.env.VIDEO_AGENT_BASE ?? "http://127.0.0.1:8790",
		timeout: Number(process.env.E2E_TIMEOUT_MS ?? 30 * 60 * 1000),
		poll: Number(process.env.E2E_POLL_MS ?? 5000),
		dryRun: false,
	};
	for (const a of argv.slice(2)) {
		const [k, v = "true"] = a.replace(/^--/, "").split("=");
		if (k === "base") args.base = v;
		else if (k === "timeout") args.timeout = Number(v);
		else if (k === "poll") args.poll = Number(v);
		else if (k === "dry-run") args.dryRun = v !== "false";
	}
	return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toLocaleTimeString("zh-CN")}] ${msg}`);

// ----- HTTP 客户端（与 server 契约对齐） -----
async function request(base, method, path, body, timeoutMs = 30000) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: ctrl.signal,
		});
		const text = await res.text();
		let json;
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			json = { raw: text };
		}
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}: ${json?.error ?? text.slice(0, 200)}`);
		}
		return json;
	} finally {
		clearTimeout(t);
	}
}

const api = {
	health: (base) => request(base, "GET", "/api/health"),
	generate: (base, body) => request(base, "POST", "/api/generate", body, 60000),
	getRun: (base, id) => request(base, "GET", `/api/runs/${encodeURIComponent(id)}`),
	resume: (base, id, confirmedShotIds) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(id)}/resume`, {
			...(confirmedShotIds ? { confirmedShotIds } : {}),
		}),
	artifacts: (base, id) => request(base, "GET", `/api/runs/${encodeURIComponent(id)}/artifacts`),
	reshot: (base, id, shotId, instruction) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(id)}/reshot`, { shotId, instruction }),
	metrics: (base, id) => request(base, "GET", `/api/runs/${encodeURIComponent(id)}/metrics`).catch(() => null),
};

// ----- 文件 IO -----
function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
	return p;
}

function readJson(p) {
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeJson(p, data) {
	ensureDir(path.dirname(p));
	fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, "\t"), "utf-8");
}

// ----- 闸门处理 -----
async function handleGate(base, runId, run, args, logsDir) {
	if (run.status !== "awaiting") return;
	if (run.gate === "design") {
		log(`🅰️  闸门 A：美术设计已完成 → 自动放行（silent 镜无对白对话风险）`);
		await api.resume(base, runId);
		writeJson(path.join(logsDir, "gate-design-passed.json"), { at: new Date().toISOString() });
		return;
	}
	if (run.gate === "keyframes") {
		const arts = await api.artifacts(base, runId).catch(() => null);
		const frames = arts?.keyframes?.frames ?? [];
		const ids = frames.filter((f) => f.status === "done" && f.file && (f.staleRefs ?? []).length === 0).map((f) => f.shotId);
		if (ids.length === 0) {
			log(`⚠️  闸门 B：所有关键帧都未就绪（${frames.length} 镜全部 failed）→ 取消 run`);
			await request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/cancel`, {});
			writeJson(path.join(logsDir, "gate-keyframes-failed.json"), { at: new Date().toISOString(), frames });
			return;
		}
		log(`🅱️  闸门 B：关键帧 ${ids.length} 镜已就绪 → 自动放行全部`);
		await api.resume(base, runId, ids);
		writeJson(path.join(logsDir, "gate-keyframes-passed.json"), { at: new Date().toISOString(), confirmedShotIds: ids });
		return;
	}
	if (run.gate) {
		log(`⚠️  未知闸门 ${run.gate} → 尝试放行`);
		await api.resume(base, runId);
	}
}

// ----- 自动质检-修复（仅在 AUTO_REPAIR=1 时启用，呼应 server 设计） -----
async function autoRepairIfEnabled(base, runId, args, logsDir, log) {
	if (process.env.VIDEO_AGENT_AUTO_REPAIR !== "1") return [];
	const run = await api.getRun(base, runId);
	const shots = run.verdict?.shots ?? [];
	const targets = shots.filter((s) => s.verdict === "fail" || (s.verdict === "warn" && /^(人物|物理):/.test(s.reason ?? ""))).slice(0, 2);
	const repairs = [];
	for (const t of targets) {
		const instruction = `${t.id} 镜需要更精准的情绪微动作；当前问题：${t.reason ?? "未说明"}。请保持人物一致性（黑色长直发、左眼泪痣、JK制服、白色围巾）、保持锁死50mm镜头、保持富士胶卷蓝调；只补正问题点。`;
		log(`🔧 自动补拍 ${t.id}（${t.verdict}）…`);
		await api.reshot(base, runId, t.id, instruction);
		repairs.push({ shotId: t.id, verdict: t.verdict, reason: t.reason });
	}
	if (repairs.length) writeJson(path.join(logsDir, "auto-repair.json"), repairs);
	return repairs;
}

// ----- 主流程 -----
async function main() {
	const args = parseArgs(process.argv);
	log(`启动《青羽的1mm》生产 base=${args.base} timeout=${args.timeout}ms dryRun=${args.dryRun}`);

	// 1) 读取输入
	const brief = readJson(path.join(INPUT_DIR, "brief.json"));
	const options = readJson(path.join(INPUT_DIR, "options.json"));
	const coSpace = readJson(path.join(INPUT_DIR, "coSpace.json"));

	const payload = { brief, options, coSpace };
	writeJson(path.join(OUTPUT_DIR, "00-input", "request.json"), payload);

	// 2) dry-run 模式
	if (args.dryRun) {
		log(`🔍 dry-run：仅打印 payload 与预估成本，不烧钱`);
		console.log(`\n📦 Payload 摘要：`);
		console.log(`  · logline: ${brief.logline.slice(0, 80)}…`);
		console.log(`  · keyMessage: ${brief.keyMessage}`);
		console.log(`  · 镜数: ${options.shotCount} × ${options.clipDurationSec}s = ${options.shotCount * options.clipDurationSec}s`);
		console.log(`  · 画幅: ${options.aspectRatio} · ${options.resolution} · ${options.fps}fps`);
		console.log(`  · 音频: ${options.audioDrive}（silent 镜纯环境音）`);
		console.log(`  · 角色: ${coSpace.characters.map((c) => c.name).join(" / ")}`);
		console.log(`  · 场景: ${coSpace.scenes.map((s) => s.name).join(" / ")}`);
		console.log(`  · 剧情节拍: ${coSpace.ideas.length} 条`);
		console.log(`  · scriptIntent: ${coSpace.scriptIntent.shots.length} 镜 [${coSpace.scriptIntent.shots.map((s) => s.id).join(", ")}]`);
		console.log(`  · audioMode: [${coSpace.scriptIntent.shots.map((s) => s.audioMode).join(", ")}]`);
		console.log(`\n📝 Shot visuals 长度（字符）：`);
		for (const shot of coSpace.scriptIntent.shots) {
			console.log(`  · ${shot.id}: ${shot.visual.length} chars · ${shot.durationSec}s`);
		}
		console.log(`\n💾 完整 payload 已落盘 ${path.join(OUTPUT_DIR, "00-input", "request.json")}`);
		return;
	}

	// 3) 健康检查
	try {
		const h = await api.health(args.base);
		log(`✅ 服务健康 ${h.ok ? "" : "(degraded)"} features=${(h.features ?? []).length}`);
	} catch (e) {
		log(`❌ 服务不可达：${e.message}`);
		log(`   请先在 pi/packages/video-agent-server 下启动服务（PORT=8790 npm run dev）`);
		log(`   或运行：node e2e/winter-portrait/start-all.mjs 一键启动并执行`);
		process.exit(2);
	}

	// 4) 启动管线
	const { runId } = await api.generate(args.base, payload);
	const runDir = ensureDir(path.join(RUNS_DIR, runId));
	const logsDir = ensureDir(path.join(runDir, "logs"));
	log(`🎬 runId=${runId} → ${runDir}`);

	// 5) 轮询
	const t0 = Date.now();
	let lastStatus = "";
	const deadline = t0 + args.timeout;
	const eventLog = [];

	while (Date.now() < deadline) {
		const run = await api.getRun(args.base, runId);
		for (const e of run.events ?? []) eventLog.push(e);

		if (run.status !== lastStatus) {
			log(`status=${run.status}${run.gate ? ` gate=${run.gate}` : ""} stages=${run.stages.map((s) => `${s.id}:${s.status[0]}`).join(" ")}`);
			lastStatus = run.status;
		}

		if (run.status === "awaiting") {
			await handleGate(args.base, runId, run, args, logsDir);
		}

		if (["done", "failed", "cancelled"].includes(run.status)) break;
		await sleep(args.poll);
	}

	const finalRun = await api.getRun(args.base, runId);
	const finalArts = await api.artifacts(args.base, runId).catch(() => null);

	writeJson(path.join(logsDir, "run-final.json"), finalRun);
	writeJson(path.join(logsDir, "events.json"), eventLog);
	if (finalArts) writeJson(path.join(logsDir, "artifacts-snapshot.json"), finalArts);

	// 6) 自动质检-修复
	if (finalRun.status === "done") {
		await autoRepairIfEnabled(args.base, runId, args, logsDir, log);
	}

	// 7) 度量 + 报告
	const metrics = await api.metrics(args.base, runId).catch(() => null);
	if (metrics) writeJson(path.join(logsDir, "metrics.json"), metrics);

	const elapsedMs = Date.now() - t0;
	const report = {
		runId,
		title: "《青羽的1mm》· 15秒冬季克制特写",
		status: finalRun.status,
		verdict: finalRun.verdict ?? null,
		elapsedMs,
		elapsedMin: Math.round(elapsedMs / 60000),
		finalVideoUrl: finalRun.videoUrl ?? null,
		finalFile: finalRun.finalFile ?? null,
		exportAspectRatio: finalRun.exportAspectRatio ?? null,
		shots: finalRun.verdict?.shots ?? [],
		metrics: metrics ?? null,
		autoRepair: fs.existsSync(path.join(logsDir, "auto-repair.json"))
			? JSON.parse(fs.readFileSync(path.join(logsDir, "auto-repair.json"), "utf-8"))
			: [],
		stages: finalRun.stages,
	};

	writeJson(path.join(OUTPUT_DIR, "report.json"), report);
	log(`\n=========================================`);
	log(`📊 ${finalRun.status === "done" ? "✅ 成片" : "❌ 失败"}  用时 ${Math.round(elapsedMs / 60000)} 分钟`);
	log(`🎥 成片地址：${finalRun.videoUrl ?? "(未生成)"}`);
	log(`📁 报告：${path.join(OUTPUT_DIR, "report.json")}`);
	log(`=========================================`);

	if (finalRun.status !== "done") process.exitCode = 1;
}

await main();