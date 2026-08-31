#!/usr/bin/env node
/**
 * video-agent 端到端流程测试（真实跑通：脚本 → 美术设计 → 关键帧 → 片段 → 音频 → 导出 → 质检）。
 *
 * 用法：
 *   node e2e/run-e2e.mjs                          # 跑全部用例（串行）
 *   node e2e/run-e2e.mjs --only=C4-smoke          # 只跑冒烟用例（先跑它验证环境）
 *   node e2e/run-e2e.mjs --base=http://127.0.0.1:8790 --timeout=1800000
 *   node e2e/run-e2e.mjs --dry-run                # 只打印将要提交的内容与配额预估，不烧钱
 *   node e2e/run-e2e.mjs --batch=2026-08-30T10-00-00 --only=C7-producer-multiformat
 *                                                   # 复用既有批次目录续跑（按用例 id 合并写回）
 *
 * 产物：e2e/results/<时间戳>/{C1-*, C2-*, ...}/{00-input...08-assets, logs, report.md} + 批次 summary
 *
 * 硬约束：串行执行（不同用例不并发），因为视频额度受 RPM/每日秒数限制。
 * 健壮性：每完成一个用例即合并写回 summary（进程被杀也不丢已完成用例；同目录可用 --batch 续跑）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { api } from "./lib/api.mjs";
import { collectRun } from "./lib/collect.mjs";
import { fileToDataUrl, synthesizeChordWav, synthesizeWav } from "./lib/wav.mjs";
import { assertCase, writeBatchReport, writeCaseReport } from "./lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
	const args = {
		base: process.env.VIDEO_AGENT_BASE ?? "http://127.0.0.1:8790",
		only: null,
		timeout: Number(process.env.E2E_TIMEOUT_MS ?? 25 * 60 * 1000), // 单用例上限：25 分钟
		poll: Number(process.env.E2E_POLL_MS ?? 5000),
		dryRun: false,
		out: path.join(HERE, "results"),
		batch: null,
	};
	for (const a of argv.slice(2)) {
		const [k, v = "true"] = a.replace(/^--/, "").split("=");
		if (k === "base") args.base = v;
		else if (k === "only") args.only = v.split(",").map((s) => s.trim());
		else if (k === "timeout") args.timeout = Number(v);
		else if (k === "poll") args.poll = Number(v);
		else if (k === "out") args.out = v;
		else if (k === "batch") args.batch = v;
		else if (k === "dry-run") args.dryRun = v !== "false";
	}
	return args;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const log = (msg) => console.log(`[${new Date().toLocaleTimeString("zh-CN")}] ${msg}`);

// ---------------------------------------------------------------- helpers

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
	return p;
}

function writeJson(p, data) {
	ensureDir(path.dirname(p));
	fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, "\t"), "utf-8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 事件流追加写（去重 by id），形成可回溯的团队频道时间线 */
function appendEvents(file, events, seen) {
	const lines = [];
	for (const e of events) {
		if (seen.has(e.id)) continue;
		seen.add(e.id);
		lines.push(`${JSON.stringify({ id: e.id, at: e.at, from: e.from, to: e.to, kind: e.kind, text: e.text })}\n`);
	}
	if (lines.length) fs.appendFileSync(file, lines.join(""), "utf-8");
}

/** 关键帧闸门：可放行的镜头（已生成 + 未过期）；过期镜必须重绘，不自动放行 */
function confirmableShotIds(artifacts) {
	const frames = artifacts?.keyframes?.frames ?? [];
	return frames
		.filter((f) => f.status === "done" && f.file && (f.staleRefs ?? []).length === 0)
		.map((f) => f.shotId);
}

/** 等待 run 离开 running（异步动作：reshot / retts / reexport 会重新进入 running） */
async function waitIdle(base, runId, args, log) {
	const deadline = Date.now() + Math.min(args.timeout, 10 * 60 * 1000);
	let run = await api.getRun(base, runId);
	while (run.status === "running" && Date.now() < deadline) {
		await sleep(args.poll);
		run = await api.getRun(base, runId);
	}
	if (run.status === "running") log("等待动作完成超时");
	return run;
}

/** 从质检裁决里挑一个最值得补拍的镜头（fail > warn > 第一镜） */
function pickWorstShot(run, script) {
	const shots = (run.verdict?.shots ?? []).length
		? run.verdict.shots
		: (script?.shots ?? []).map((s) => ({ id: s.id, verdict: "ok" }));
	const fail = shots.find((s) => s.verdict === "fail");
	if (fail) return fail.id;
	const warn = shots.find((s) => s.verdict === "warn");
	if (warn) return warn.id;
	return shots[0]?.id ?? null;
}

/** 挑一个适合重录的镜头：优先台词镜（走台词级联：重 TTS + 口型重生成），否则旁白镜 */
function pickRettsShot(script) {
	const shots = script?.shots ?? [];
	const dialogue = shots.find((s) => (s.dialogue?.lines?.zh ?? "").trim().length > 0);
	if (dialogue) return dialogue.id;
	return shots.find((s) => (s.narrationZh ?? "").trim().length > 0)?.id ?? shots[0]?.id ?? null;
}

/**
 * 成片之后的动作序列（覆盖重做 / 自审 / 制片主任 / 多画幅 / 组合出片 / 度量）。
 * 每个动作都容错：失败只记录，不中断整批。
 */
async function runPostActions({ testCase, base, runId, args, caseDir, script, log }) {
	const facts = {
		designReview: null,
		keyframeReview: null,
		reshotShots: [],
		rettsShots: [],
		composeCuts: [],
		portraitExports: [],
		kitchen: null,
		applied: [],
		metrics: null,
		errors: [],
	};
	const actions = testCase.postActions ?? [];
	if (actions.length === 0) return facts;

	for (const action of actions) {
		try {
			switch (action.type) {
				case "designReview": {
					const r = await api.designReview(base, runId);
					const reviewed = r.reviewed ?? [];
					facts.designReview = {
						count: reviewed.length,
						fail: reviewed.filter((e) => e.review?.verdict === "fail").length,
						warn: reviewed.filter((e) => e.review?.verdict === "warn").length,
					};
					log(`${testCase.id} 设计图自审：${reviewed.length} 张（fail ${facts.designReview.fail}）`);
					break;
				}
				case "keyframeReview": {
					const r = await api.keyframeReview(base, runId);
					const reviewed = r.reviewed ?? [];
					facts.keyframeReview = {
						count: reviewed.length,
						fail: reviewed.filter((f) => f.review?.verdict === "fail").length,
						warn: reviewed.filter((f) => f.review?.verdict === "warn").length,
					};
					log(`${testCase.id} 关键帧自审：${reviewed.length} 帧（fail ${facts.keyframeReview.fail}）`);
					break;
				}
				case "reshot": {
					const shotId = action.shotId ?? pickWorstShot(await api.getRun(base, runId), script);
					if (!shotId) throw new Error("无可补拍镜头");
					const r = await api.reshot(base, runId, shotId, action.instruction ?? "");
					if (!r.ok) throw new Error(r.error ?? "reshot 被拒");
					facts.reshotShots.push(shotId);
					log(`${testCase.id} 补拍 ${shotId} 已派发，等待完成…`);
					const after = await waitIdle(base, runId, args, log);
					facts.reshotResults = [...(facts.reshotResults ?? []), { shotId, status: after.status }];
					break;
				}
				case "retts": {
					const shotId = action.shotId ?? pickRettsShot(script);
					if (!shotId) throw new Error("无可重录镜头");
					const r = await api.retts(base, runId, shotId, action.instruction ?? "", action.voice);
					if (!r.ok) throw new Error(r.error ?? "retts 被拒");
					facts.rettsShots.push(shotId);
					log(`${testCase.id} 重录 ${shotId} 台词/旁白已派发，等待完成…`);
					const after = await waitIdle(base, runId, args, log);
					facts.rettsResults = [...(facts.rettsResults ?? []), { shotId, status: after.status }];
					break;
				}
				case "compose": {
					// 默认全选「最新版本」；selections 为空即取每镜最新
					const r = await api.compose(base, runId, action.selections ?? {});
					if (!r.ok) throw new Error(r.error ?? "compose 被拒");
					facts.composeCuts.push(r.file ?? null);
					log(`${testCase.id} 组合出片完成（${r.file ?? "未知产物"}），剩余次数 ${r.remaining ?? "-"}`);
					break;
				}
				case "reexport": {
					const r = await api.reexport(base, runId, action.aspectRatio);
					if (!r.ok) throw new Error(r.error ?? "reexport 被拒");
					log(`${testCase.id} 重导出 ${action.aspectRatio ?? "主画幅"} 已派发，等待完成…`);
					const after = await waitIdle(base, runId, args, log);
					facts.portraitExports.push({ aspectRatio: action.aspectRatio ?? "main", status: after.status });
					break;
				}
				case "kitchenObserve": {
					const r = await api.kitchenObserve(base, runId);
					const obs = r.observation ?? null;
					facts.kitchen = obs
						? { id: obs.id, suggestionCount: (obs.suggestions ?? []).length, suggestions: obs.suggestions ?? [] }
						: null;
					log(`${testCase.id} 制片主任观察：${facts.kitchen?.suggestionCount ?? 0} 条建议`);
					break;
				}
				case "kitchenApply": {
					// 没有观察过就先观察一次（保证 apply 能拿到 obsId/suggestionId）
					if (!facts.kitchen) {
						const r = await api.kitchenObserve(base, runId);
						const obs = r.observation ?? null;
						facts.kitchen = obs
							? { id: obs.id, suggestionCount: (obs.suggestions ?? []).length, suggestions: obs.suggestions ?? [] }
							: null;
					}
					const obsId = facts.kitchen?.id;
					const suggestionId = facts.kitchen?.suggestions?.[0]?.id;
					if (!obsId || !suggestionId) {
						facts.applied.push({ skipped: "本轮无可用建议（守卫拒绝或无需调度）" });
						break;
					}
					const r = await api.kitchenApply(base, runId, obsId, suggestionId);
					facts.applied.push({ obsId, suggestionId, result: r });
					log(`${testCase.id} 制片建议已执行：${suggestionId}`);
					break;
				}
				case "metrics": {
					facts.metrics = await api.metrics(base, runId).catch(() => null);
					break;
				}
				default:
					facts.errors.push(`未知动作类型：${action.type}`);
			}
		} catch (error) {
			facts.errors.push(`${action.type}: ${error.message}`);
			log(`${testCase.id} 动作 ${action.type} 失败：${error.message}`);
		}
	}

	writeJson(path.join(caseDir, "logs", "post-actions.json"), facts);
	return facts;
}

// ---------------------------------------------------------------- 单用例主流程

async function runCase(testCase, args, batchDir) {
	const caseDir = ensureDir(path.join(batchDir, `${testCase.id}-${testCase.slug}`));
	const logsDir = ensureDir(path.join(caseDir, "logs"));
	const eventsFile = path.join(logsDir, "events.jsonl");
	const apiLog = [];
	const gates = [];
	const seenEvents = new Set();
	const t0 = Date.now();

	writeJson(path.join(caseDir, "00-input", "brief.json"), testCase.brief);
	writeJson(path.join(caseDir, "00-input", "options.json"), testCase.options);
	if (testCase.coSpace) writeJson(path.join(caseDir, "00-input", "coSpace.json"), testCase.coSpace);

	const estimate = await api.estimate(args.base, testCase.options.shotCount, testCase.options.clipDurationSec);
	if (estimate) {
		writeJson(path.join(caseDir, "00-input", "cost-estimate.json"), estimate);
		log(`${testCase.id} 成本预估：${JSON.stringify(estimate.total ?? estimate)}`);
	}

	if (args.dryRun) {
		log(`${testCase.id} dry-run 跳过执行`);
		return {
			id: testCase.id,
			title: testCase.title,
			audioForm: testCase.audioForm,
			dir: path.basename(caseDir),
			run: { status: "dry-run", stages: [] },
			assert: { passed: ["dry-run"], failed: [], verdict: "PASS" },
			timings: { totalMs: 0, stages: [] },
		};
	}

	// 1) 启动
	const payload = {
		brief: testCase.brief,
		options: testCase.options,
		...(testCase.coSpace ? { coSpace: testCase.coSpace } : {}),
	};
	writeJson(path.join(caseDir, "00-input", "request.json"), payload);
	const created = await api.generate(args.base, payload);
	const runId = created.runId ?? created.id;
	apiLog.push({ at: new Date().toISOString(), action: "generate", runId, response: created });
	log(`${testCase.id} → runId=${runId}`);

	// 2) BGM：一开始上传，确保 export 阶段能吃到（纯音乐用例的验证点）
	if (testCase.bgm) {
		let dataUrl;
		let used = "synth";
		const local = testCase.bgm.file ? path.join(HERE, testCase.bgm.file) : null;
		if (local && fs.existsSync(local)) {
			dataUrl = fileToDataUrl(local);
			used = path.basename(local);
		} else {
			const tmp = path.join(logsDir, "bgm-placeholder.wav");
			synthesizeWav({ seconds: testCase.bgm.synthSeconds ?? 45, outPath: tmp });
			dataUrl = fileToDataUrl(tmp);
		}
		await api.uploadBgm(args.base, runId, testCase.bgm.name ?? "bgm.wav", dataUrl);
		apiLog.push({ at: new Date().toISOString(), action: "uploadBgm", source: used });
		log(`${testCase.id} BGM 已上传（${used}）`);
	}

	// 3) 轮询推进：等闸门 → 处理闸门 → 等完成
	let run = await api.getRun(args.base, runId);
	appendEvents(eventsFile, run.events ?? [], seenEvents);
	const stageSeen = new Map(); // id → { firstSeenAt, doneAt }
	const deadline = Date.now() + args.timeout;
	let lastStatus = "";

	while (Date.now() < deadline) {
		const now = Date.now();
		for (const s of run.stages) {
			const rec = stageSeen.get(s.id) ?? { firstSeenAt: now };
			if (s.status === "done" && !rec.doneAt) rec.doneAt = now;
			stageSeen.set(s.id, rec);
		}
		if (run.status !== lastStatus) {
			log(`${testCase.id} status=${run.status}${run.gate ? ` gate=${run.gate}` : ""} stages=${run.stages
				.map((s) => `${s.id}:${s.status[0]}`)
				.join(" ")}`);
			lastStatus = run.status;
		}

		if (run.status === "done" || run.status === "failed" || run.status === "cancelled") break;

		if (run.status === "awaiting") {
			if (run.gate === "design") {
				// 闸门 A：美术设计确认（设计图若有 fail，报告里留痕但不阻断）
				const arts = await api.artifacts(args.base, runId).catch(() => null);
				const failedDesign = (arts?.design ? [...arts.design.characters, ...arts.design.props, ...arts.design.scenes] : []).filter(
					(e) => e.status === "failed",
				);
				writeJson(path.join(caseDir, "02-design", "gate-design-snapshot.json"), arts?.design ?? null);
				gates.push({
					gate: "design",
					action: failedDesign.length ? `resume（${failedDesign.length} 张设计图失败，仍放行）` : "resume",
					at: new Date().toISOString(),
				});
				apiLog.push({ at: new Date().toISOString(), action: "resume", gate: "design", failedDesign: failedDesign.length });
				await api.resume(args.base, runId);
				log(`${testCase.id} 闸门 A 放行（失败设计图 ${failedDesign.length} 张）`);
			} else if (run.gate === "keyframes") {
				// 闸门 B：关键帧确认（只放行已生成且未过期的镜头）
				const arts = await api.artifacts(args.base, runId).catch(() => null);
				writeJson(path.join(caseDir, "03-keyframes", "gate-keyframes-snapshot.json"), arts?.keyframes ?? null);
				const ids = confirmableShotIds(arts);
				if (ids.length === 0) {
					gates.push({ gate: "keyframes", action: "无可放行关键帧，等待", at: new Date().toISOString() });
				} else {
					gates.push({ gate: "keyframes", action: `resume（确认 ${ids.length} 镜）`, at: new Date().toISOString() });
					apiLog.push({ at: new Date().toISOString(), action: "resume", gate: "keyframes", confirmedShotIds: ids });
					await api.resume(args.base, runId, ids);
					log(`${testCase.id} 闸门 B 放行 ${ids.length} 镜`);
				}
			} else {
				gates.push({ gate: run.gate ?? "unknown", action: "resume", at: new Date().toISOString() });
				await api.resume(args.base, runId);
			}
		}

		await sleep(args.poll);
		run = await api.getRun(args.base, runId);
		appendEvents(eventsFile, run.events ?? [], seenEvents);
	}

	if (!["done", "failed", "cancelled"].includes(run.status)) {
		log(`${testCase.id} 超时（${args.timeout}ms），末态=${run.status}`);
	}

	// 4) 成片之后的动作序列（重做 / 自审 / 制片主任 / 多画幅 / 组合出片 / 度量）
	const preScript = (await api.artifacts(args.base, runId).catch(() => null))?.script ?? null;
	const postFacts =
		run.status === "done"
			? await runPostActions({ testCase, base: args.base, runId, args, caseDir, script: preScript, log })
			: { skipped: `run 终态为 ${run.status}，跳过后续动作` };
	if (postFacts.skipped) writeJson(path.join(logsDir, "post-actions.json"), postFacts);

	// 5) 采集（放在动作之后：版本化片段 / cut-N / final-9x16 才能一并归档）
	const collected = await collectRun({ base: args.base, runId, caseDir, log });
	const arts = await api.artifacts(args.base, runId).catch(() => null);
	const traces = await api.traces(args.base, runId).catch(() => []);
	const consistency = await api.consistency(args.base, runId).catch(() => null);

	writeJson(path.join(caseDir, "07-qa", "traces.ndjson.json"), traces);
	if (consistency) writeJson(path.join(caseDir, "07-qa", "consistency.json"), consistency);
	if (run.verdict) writeJson(path.join(caseDir, "07-qa", "verdict.json"), run.verdict);

	// 自动质检-修复闭环留痕：从事件流提取触发记录，与最终逐镜裁决对齐。
	// 「补拍前」= 触发事件自带的问题快照（服务端派发事件含 fail/warn 与原因）；
	// 「复审后」= 最终 verdict 的逐镜裁决。落盘 07-qa/auto-repair.json 供报告与人工核查。
	const autoRepair = [];
	try {
		const evLines = fs.readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
		for (const line of evLines) {
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			const m = /自动质检-修复闭环：镜头 ([A-Za-z0-9_-]+)（(fail|warn)：([^）]*)）派发补拍重审/.exec(e.text ?? "");
			if (m) autoRepair.push({ shotId: m[1], preVerdict: m[2], preReason: m[3].trim(), at: e.at });
		}
	} catch {
		// 事件文件缺失（极早期失败）：留痕为空
	}
	if (autoRepair.length > 0) {
		const finalShots = run.verdict?.shots ?? [];
		for (const r of autoRepair) {
			const post = finalShots.find((s) => s.id === r.shotId);
			r.postVerdict = post?.verdict ?? null;
			r.postReason = post?.reason ?? null;
			// 改善判定：复审后 ok，或 fail 降为 warn（严重度下降）；同级换原因不算改善
			r.improved = r.postVerdict === "ok" || (r.preVerdict === "fail" && r.postVerdict === "warn");
		}
		writeJson(path.join(caseDir, "07-qa", "auto-repair.json"), autoRepair);
	}

	// 制作集 / 台词镜统计
	const script = arts?.script ?? null;
	const productionShots = arts?.keyframes?.confirmedShotIds?.length ?? script?.shots?.length ?? 0;
	const dialogueShotCount = (script?.shots ?? []).filter((s) => s.audioMode === "dialogue").length;
	run.productionShots = productionShots;
	run.dialogueShotCount = dialogueShotCount;

	// 成片体积
	const finalAsset = (collected.assets ?? []).find((a) => /^final.*\.mp4$/.test(a.name));
	let finalBytes = 0;
	if (finalAsset) {
		const p = path.join(caseDir, "06-export", finalAsset.name);
		if (fs.existsSync(p)) finalBytes = fs.statSync(p).size;
	}

	// 6) 断言 + 报告
	// 配音选角留痕（voice-cast.json）：旁白音色与角色音色的区分是硬断言的依据
	let voiceCast = null;
	try {
		voiceCast = JSON.parse(fs.readFileSync(path.join(caseDir, "05-audio", "voice-cast.json"), "utf-8"));
	} catch {
		voiceCast = null;
	}
	const assert = assertCase({
		expect: testCase.expect,
		run,
		collected,
		finalBytes,
		audioForm: testCase.audioForm,
		postFacts,
		voiceCast,
		autoRepair,
	});
	const timings = {
		totalMs: Date.now() - t0,
		stages: [...stageSeen.entries()].map(([id, r]) => ({
			id,
			status: run.stages.find((s) => s.id === id)?.status ?? "?",
			ms: (r.doneAt ?? Date.now()) - r.firstSeenAt,
		})),
	};
	writeJson(path.join(logsDir, "timings.json"), timings);
	writeJson(path.join(logsDir, "gate-decisions.json"), gates);
	writeJson(path.join(logsDir, "api.log.json"), apiLog);
	writeJson(path.join(logsDir, "run-final.json"), run);

	writeCaseReport(caseDir, { testCase, run, assert, timings, gates, collected, finalBytes, postFacts, voiceCast, autoRepair });
	log(`${testCase.id} 结论 ${assert.verdict}（失败项 ${assert.failed.length}）`);

	return {
		id: testCase.id,
		title: testCase.title,
		audioForm: testCase.audioForm,
		dir: path.basename(caseDir),
		run: { id: runId, status: run.status, verdict: run.verdict, stages: run.stages, productionShots, dialogueShotCount },
		assert,
		timings,
		collected: { files: collected.files },
		finalBytes,
	};
}

// ---------------------------------------------------------------- main

/** 批次报告合并写：按用例 id 与既有 summary 合并（新结果覆盖旧结果），可重复调用 */
function upsertBatchReport(batchDir, newResults, meta) {
	let existing = [];
	try {
		const prev = JSON.parse(fs.readFileSync(path.join(batchDir, "summary.json"), "utf-8"));
		if (Array.isArray(prev.results)) existing = prev.results;
	} catch {
		// 首次写入或旧 summary 损坏：重建
	}
	const byId = new Map(existing.map((r) => [r.id, r]));
	for (const r of newResults) byId.set(r.id, r);
	writeBatchReport(batchDir, [...byId.values()], meta);
}

async function main() {
	const args = parseArgs(process.argv);
	log(`E2E 启动 base=${args.base} timeout=${args.timeout}ms poll=${args.poll}ms dryRun=${args.dryRun}`);

	if (!args.dryRun) {
		let health;
		try {
			health = await api.health(args.base);
		} catch (error) {
			log(`服务不可达：${error.message}`);
			log("提示：先在 pi/packages/video-agent-server 下 npm run dev（或 PORT=8790 npm run dev）");
			process.exit(2);
		}
		// 特征一致性：degraded = 目标无 /api/health（旧代码服务）。C7 事故根因：
		// 用例打进旧服务，kitchen 动作 404，白烧 13 分钟配额还得误导 FAIL。
		const REQUIRED_FEATURES = ["kitchen", "kitchen-snapshot", "priority", "budget-alerts", "metrics"];
		if (health.degraded) {
			log(`预检失败：${args.base} 无 /api/health——是旧代码服务，不是当前代码库。`);
			log("提示：把 --base 指向当前代码库启动的服务（默认 http://127.0.0.1:8790）");
			process.exit(3);
		}
		const missing = REQUIRED_FEATURES.filter((f) => !(health.features ?? []).includes(f));
		if (missing.length > 0) {
			log(`预检失败：目标服务缺少能力 ${missing.join(",")}（代码版本落后于 e2e 用例）`);
			process.exit(3);
		}
	}

	const batchDir = ensureDir(path.join(args.out, args.batch ?? stamp));
	const batchStartedAt = Date.now();
	writeJson(path.join(batchDir, "env.json"), {
		base: args.base,
		startedAt: new Date().toISOString(),
		node: process.version,
		platform: process.platform,
		timeout: args.timeout,
		poll: args.poll,
		dryRun: args.dryRun,
	});

	const selected = args.only ? CASES.filter((c) => args.only.includes(c.id)) : CASES;
	if (selected.length === 0) {
		log(`没有匹配的用例：${args.only?.join(",")}`);
		process.exit(1);
	}

	const results = [];
	for (const testCase of selected) {
		let entry;
		try {
			entry = await runCase(testCase, args, batchDir);
		} catch (error) {
			log(`用例 ${testCase.id} 异常中断：${error.message}`);
			entry = {
				id: testCase.id,
				title: testCase.title,
				audioForm: testCase.audioForm,
				dir: `${testCase.id}-${testCase.slug}`,
				run: { status: "error", stages: [] },
				assert: { passed: [], failed: [`执行异常：${error.message}`], verdict: "FAIL" },
				timings: { totalMs: 0, stages: [] },
			};
		}
		results.push(entry);
		// 每完成一个用例立即合并写回：进程被杀/重跑都不丢已完成用例（22-51 批次 C1 丢失事故）
		upsertBatchReport(batchDir, [entry], { startedAt: batchStartedAt, base: args.base });
		// 用例之间留缓冲：避免上一轮的收尾事件与下一轮提交撞 RPM
		if (!args.dryRun && selected.indexOf(testCase) < selected.length - 1) await sleep(3000);
	}

	upsertBatchReport(batchDir, results, { startedAt: batchStartedAt, base: args.base });
	const pass = results.filter((r) => r.assert.verdict === "PASS").length;
	log(`批次完成：PASS ${pass}/${results.length} → ${batchDir}`);
	log(`报告：${path.join(batchDir, "index.html")}`);
	if (pass < results.length) process.exitCode = 1;
}

await main();
