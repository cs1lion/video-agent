/**
 * 跨 run 质量统计报告（quality-report）：
 * 聚合 video-agent-runs 下全部 run 的质量信号，回答"模板/流程改动后变好了没"。
 *
 * 用法：npx tsx src/quality-report.ts [runsRoot]
 *   runsRoot 缺省 = <studioRoot>/.pi-studio/video-agent-runs
 * 输出 markdown 表格到 stdout（可重定向存档）。
 *
 * 覆盖信号：
 *   - prompts.json.promptVersion   提示词模板版本（v5 起记录）
 *   - run-state.json verdict       QA 五轴总分 + 逐镜裁决
 *   - consistency.json             跨镜一致性跳变数（低噪声二元指标）
 *   - deliberations.json           审议轮次 / 采纳数
 *   - preferences.jsonl            偏好记录条数
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findStudioRoot } from "./config.ts";

interface RunStats {
	dir: string;
	name: string;
	status: string;
	promptVersion: number | null;
	qaScore: number | null;
	shotVerdicts: { ok: number; warn: number; fail: number };
	consistencyIssues: number | null;
	consistencyCheckedAt: string | null;
	delibRounds: number;
	delibAdopted: number;
	preferences: number;
	mediaCalls: number;
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

function collectRun(dir: string): RunStats | null {
	const statePath = path.join(dir, "run-state.json");
	if (!fs.existsSync(statePath)) return null;
	const state = readJson<{
		id?: string;
		status?: string;
		verdict?: { score?: number; shots?: { verdict: string }[] };
		metrics?: { mediaCalls?: number };
	}>(statePath);
	if (!state?.id) return null;

	const prompts = readJson<{ promptVersion?: number }>(path.join(dir, "prompts.json"));
	const consistency = readJson<{ shots?: { issues: string[] }[]; checkedAt?: string }>(
		path.join(dir, "consistency.json"),
	);
	const consistencyIssueCount = consistency?.shots
		? consistency.shots.reduce((sum, s) => sum + s.issues.length, 0)
		: null;
	const deliberations = readJson<{ rounds?: { adopted?: unknown }[] }>(path.join(dir, "deliberations.json"));
	let preferences = 0;
	try {
		preferences = fs
			.readFileSync(path.join(dir, "preferences.jsonl"), "utf-8")
			.split("\n")
			.filter((l) => l.trim()).length;
	} catch {
		// 无偏好记录
	}

	const verdictShots = state.verdict?.shots ?? [];
	return {
		dir,
		name: path.basename(dir),
		status: state.status ?? "?",
		promptVersion: prompts?.promptVersion ?? null,
		qaScore: typeof state.verdict?.score === "number" ? state.verdict.score : null,
		shotVerdicts: {
			ok: verdictShots.filter((s) => s.verdict === "ok").length,
			warn: verdictShots.filter((s) => s.verdict === "warn").length,
			fail: verdictShots.filter((s) => s.verdict === "fail").length,
		},
		consistencyIssues: consistencyIssueCount,
		consistencyCheckedAt: consistency?.checkedAt ?? null,
		delibRounds: deliberations?.rounds?.length ?? 0,
		delibAdopted: (deliberations?.rounds ?? []).filter((r) => r.adopted).length,
		preferences,
		mediaCalls: state.metrics?.mediaCalls ?? 0,
	};
}

function main(): void {
	const runsRoot = process.argv[2] ?? path.join(findStudioRoot(process.cwd()), ".pi-studio", "video-agent-runs");
	if (!fs.existsSync(runsRoot)) {
		console.error(`runs 目录不存在: ${runsRoot}`);
		process.exit(1);
	}
	const runs = fs
		.readdirSync(runsRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => collectRun(path.join(runsRoot, e.name)))
		.filter((r): r is RunStats => r !== null)
		.sort((a, b) => a.name.localeCompare(b.name));

	if (runs.length === 0) {
		console.error("没有任何 run");
		process.exit(1);
	}

	const lines: string[] = [];
	lines.push("# 跨 run 质量统计");
	lines.push("");
	lines.push(`生成时间: ${new Date().toISOString()}  ·  样本: ${runs.length} runs  ·  来源: ${runsRoot}`);
	lines.push("");
	lines.push(
		"| run | 状态 | prompt版本 | QA分 | 逐镜 ok/warn/fail | 一致性跳变 | 审议轮/采纳 | 偏好记录 | 媒体调用 |",
	);
	lines.push("|---|---|---|---|---|---|---|---|---|");
	for (const r of runs) {
		const short = r.name.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-/, "").slice(0, 28);
		lines.push(
			`| ${short} | ${r.status} | ${r.promptVersion ? `v${r.promptVersion}` : "≤v4"} | ${r.qaScore ?? "—"} | ${r.shotVerdicts.ok}/${r.shotVerdicts.warn}/${r.shotVerdicts.fail} | ${r.consistencyIssues ?? "未检"} | ${r.delibRounds}/${r.delibAdopted} | ${r.preferences} | ${r.mediaCalls} |`,
		);
	}

	// 按 prompt 版本聚合（模板改动的效果对比；v≤4 无版本记录）
	const byVersion = new Map<string, { n: number; qa: number[]; issues: number[] }>();
	for (const r of runs) {
		const key = r.promptVersion ? `v${r.promptVersion}` : "≤v4";
		const agg = byVersion.get(key) ?? { n: 0, qa: [], issues: [] };
		agg.n += 1;
		if (r.qaScore !== null) agg.qa.push(r.qaScore);
		if (r.consistencyIssues !== null) agg.issues.push(r.consistencyIssues);
		byVersion.set(key, agg);
	}
	lines.push("");
	lines.push("## 按提示词模板版本聚合");
	lines.push("");
	lines.push("| 版本 | runs | QA 均分 | QA 中位 | 一致性跳变均 | 一致性跳变中位 |");
	lines.push("|---|---|---|---|---|---|");
	for (const [key, agg] of [...byVersion.entries()].sort()) {
		const median = (arr: number[]): number | null => {
			if (arr.length === 0) return null;
			const s = [...arr].sort((a, b) => a - b);
			return s[Math.floor(s.length / 2)]!;
		};
		const avg = (arr: number[]): number | null => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
		const qaAvg = avg(agg.qa);
		const qaMed = median(agg.qa);
		const issAvg = avg(agg.issues);
		const issMed = median(agg.issues);
		lines.push(
			`| ${key} | ${agg.n} | ${qaAvg === null ? "—" : qaAvg.toFixed(1)} | ${qaMed === null ? "—" : qaMed} | ${issAvg === null ? "—" : issAvg.toFixed(1)} | ${issMed === null ? "—" : issMed} |`,
		);
	}

	// 审议闭环健康度
	const totalRounds = runs.reduce((s, r) => s + r.delibRounds, 0);
	const totalAdopted = runs.reduce((s, r) => s + r.delibAdopted, 0);
	const checked = runs.filter((r) => r.consistencyIssues !== null);
	const flaggedRuns = checked.filter((r) => (r.consistencyIssues ?? 0) > 0).length;
	lines.push("");
	lines.push("## 闭环健康度");
	lines.push("");
	lines.push(
		`- 审议: 共 ${totalRounds} 轮，采纳提案 ${totalAdopted} 个（采纳率 ${totalRounds ? Math.round((totalAdopted / totalRounds) * 100) : 0}%）`,
	);
	lines.push(`- 一致性预检: ${checked.length}/${runs.length} runs 已检查，其中 ${flaggedRuns} 个存在跳变`);
	lines.push(`- 偏好记录: 共 ${runs.reduce((s, r) => s + r.preferences, 0)} 条（成对选择，DPO 原料）`);

	console.log(lines.join("\n"));
}

main();
