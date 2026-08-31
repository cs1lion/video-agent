/**
 * 密集对话剧情脚本批量运行器
 *
 * ⚠️ **DEPRECATED**：本脚本有两个隐性 bug，跑批会永远停在 `awaiting gate=design/keyframes`
 *    然后超时（详见 `doc/reports/历史踩坑补遗-密集对话跑批-2026-08-31.md` §1）：
 *      1. 不处理闸门（需 POST /api/runs/:id/resume）
 *      2. 不注入 coSpace（Clarifier 会卡在澄清阶段）
 *    还有：产物下载路径与 `e2e/deep-review.mjs` 期望的子目录不兼容。
 *
 *    **请改用 `run-scripts-v2.mjs`**：自动 resume 闸门 + 解析人物/场景注入 coSpace +
 *    按 e2e 子目录分桶下载。已用 5 部片验证（5/5 done）。
 *
 * 原用法（仅留作历史参考，不再维护）：
 *   node doc/scripts/dense-dialogues/run-scripts.mjs
 *
 * 行为：
 *   - 读取 doc/scripts/dense-dialogues/ 下所有 script-*.md
 *   - 解析出 logline（第一行 # 标题）+ 镜头数
 *   - 依次 POST /api/generate 创建 run
 *   - 轮询每个 run 直到完成
 *   - 输出汇总报告
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, ".");
const API_BASE = process.env.VIDEO_AGENT_API ?? "http://127.0.0.1:8790";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseScript(filePath: string): { title: string; logline: string; shotCount: number } | null {
	const text = fs.readFileSync(filePath, "utf-8");
	const titleMatch = text.match(/^#\s+(.+)$/m);
	const loglineMatch = text.match(/## 一句话需求\s*\n(.+)/);
	const shotMatch = text.match(/## 镜头（(\d+) 镜/);
	if (!titleMatch || !loglineMatch || !shotMatch) return null;
	return {
		title: titleMatch[1]!.trim(),
		logline: loglineMatch[1]!.trim(),
		shotCount: Number(shotMatch[1]!),
	};
}

async function createRun(logline: string, shotCount: number): Promise<string> {
	const body = {
		brief: { logline, keyMessage: "密集对话驱动" },
		options: {
			resolution: "720p",
			aspectRatio: "16:9",
			shotCount,
			clipDurationSec: 5,
			fps: 24,
			motionIntensity: "medium",
			detailBoost: true,
			promptLanguage: "zh",
			audioDrive: "dialogue",
		},
	};
	const res = await fetch(`${API_BASE}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`创建 run 失败 HTTP ${res.status}: ${text}`);
	}
	const data = (await res.json()) as { runId: string };
	return data.runId;
}

async function waitForRun(runId: string, timeoutMs = 30 * 60 * 1000): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetch(`${API_BASE}/api/runs/${encodeURIComponent(runId)}`);
		if (!res.ok) {
			throw new Error(`查询 run 失败 HTTP ${res.status}`);
		}
		const data = (await res.json()) as { run: { status: string; finalFile?: string } };
		if (data.run.status === "done" || data.run.status === "failed" || data.run.status === "cancelled") {
			return data;
		}
		await sleep(5000);
	}
	throw new Error(`run ${runId} 超时`);
}

async function main() {
	const files = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.startsWith("script-") && f.endsWith(".md"));
	if (files.length === 0) {
		console.error("未找到脚本文件");
		process.exit(1);
	}
	const results: { file: string; title: string; logline: string; shotCount: number; runId?: string; status?: string; finalFile?: string; error?: string }[] = [];
	for (const file of files) {
		const parsed = parseScript(path.join(SCRIPTS_DIR, file));
		if (!parsed) {
			console.warn(`跳过无法解析的脚本: ${file}`);
			continue;
		}
		const entry = { file, title: parsed.title, logline: parsed.logline, shotCount: parsed.shotCount };
		results.push(entry);
		try {
			console.log(`\n>>> 启动: ${parsed.title}`);
			const runId = await createRun(parsed.logline, parsed.shotCount);
			entry.runId = runId;
			console.log(`    runId=${runId}`);
			const data = await waitForRun(runId) as { run: { status: string; finalFile?: string } };
			entry.status = data.run.status;
			entry.finalFile = data.run.finalFile;
			console.log(`    完成: ${entry.status} ${data.run.finalFile ?? ""}`);
		} catch (error) {
			entry.error = error instanceof Error ? error.message : String(error);
			console.error(`    失败: ${entry.error}`);
		}
	}
	console.log("\n========== 汇总 ==========");
	for (const r of results) {
		console.log(`${r.file}: ${r.title} | shots=${r.shotCount} | status=${r.status ?? "error"} | runId=${r.runId ?? "-"} | final=${r.finalFile ?? "-"} | error=${r.error ?? "-"}`);
	}
	const reportPath = path.join(SCRIPTS_DIR, "run-report.json");
	fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, "\t"));
	console.log(`\n报告已写入: ${reportPath}`);
}

main().catch((error) => {
	console.error("批量运行失败:", error);
	process.exit(1);
});
