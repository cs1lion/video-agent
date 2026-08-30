/**
 * 产物归档：把一次 run 的「脚本 → 设计 → 关键帧 → 片段 → 音频 → 导出 → 质检」全部落地到用例目录。
 *
 * 目录约定（每个用例一个子文件夹）：
 *   00-input/     提交入参 + 环境快照 + 成本预估
 *   01-script/    script.json / voice-directions.json
 *   02-design/    visual-bible.json / design-bible.json / design-*.png
 *   03-keyframes/ keyframes.json / key-*.png / 参考板
 *   04-clips/     clip-*.mp4（含历史版本）
 *   05-audio/     tts-*.mp3（含历史版本）/ bgm.*
 *   06-export/    final.mp4 / shot-*.mp4 / transitions.json / subs.ass
 *   07-qa/        consistency.json / run-state.json / traces.ndjson / verdict.json
 *   08-assets/    assets 目录全量备份（兜底：任何未归类的中间产物都在这里）
 *   logs/         events.jsonl / gate-decisions.json / timings.json / api.log
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { api } from "./api.mjs";

const ARTIFACT_JSON = {
	"01-script": ["script.json", "voice-directions.json"],
	"05-audio": ["voice-cast.json"],
	"07-qa": ["run-state.json", "consistency.json", "traces.ndjson", "cuts.json", "budget-alerts.ndjson"],
	"06-export": ["transitions.json"],
	"02-design": ["visual-bible.json", "design-bible.json"],
	"03-keyframes": ["keyframes.json"],
};

function writeJson(dir, name, data) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), typeof data === "string" ? data : JSON.stringify(data, null, "\t"), "utf-8");
}

async function safeDownload(base, runId, rel, targetDir, label, log) {
	try {
		const buf = await api.downloadFile(base, runId, rel);
		if (!buf || buf.length === 0) return null;
		fs.mkdirSync(targetDir, { recursive: true });
		const name = path.basename(rel.replace(/[\\/]/g, path.sep));
		fs.writeFileSync(path.join(targetDir, name), buf);
		return { name, bytes: buf.length };
	} catch (error) {
		log?.(`[collect] ${label} 下载失败（跳过）: ${rel} - ${error.message}`);
		return null;
	}
}

/** 按资产类型归入对应子目录 */
function bucketOf(name) {
	if (/^design-/.test(name)) return "02-design";
	if (/^key-/.test(name)) return "03-keyframes";
	if (/^clip-/.test(name)) return "04-clips";
	if (/^tts-/.test(name)) return "05-audio";
	if (/^bgm/.test(name)) return "05-audio";
	if (/^shot-|^cut\d?-shot-/.test(name)) return "06-export";
	if (/^final|^cut\d+\.mp4$/.test(name)) return "06-export";
	if (/^qa-/.test(name) || /^subs\.ass$|^cut\d+-subs\.ass$/.test(name)) return "06-export";
	if (/\.ass$/.test(name)) return "06-export";
	return "08-assets";
}

/**
 * 收集一次 run 的全部产物。
 * @returns {Promise<{files: object, assets: any[], downloaded: number}>}
 */
export async function collectRun({ base, runId, caseDir, log = () => {} }) {
	const files = {};
	let downloaded = 0;

	// 1) JSON 产物（按固定清单下载，缺失跳过）
	for (const [dir, names] of Object.entries(ARTIFACT_JSON)) {
		for (const name of names) {
			const hit = await safeDownload(base, runId, name, path.join(caseDir, dir), "json", log);
			if (hit) {
				downloaded += 1;
				(files[dir] ??= []).push(hit.name);
			}
		}
	}

	// 2) artifacts 视图（结构化产物 + 资产清单）
	let artifacts = null;
	try {
		artifacts = await api.artifacts(base, runId);
	} catch (error) {
		log(`[collect] artifacts 读取失败: ${error.message}`);
	}

	// 文本产物另存一份（便于人读）
	if (artifacts) {
		if (artifacts.script) writeJson(path.join(caseDir, "01-script"), "artifacts-script.json", artifacts.script);
		if (artifacts.bible) writeJson(path.join(caseDir, "02-design"), "artifacts-bible.json", artifacts.bible);
		if (artifacts.design) writeJson(path.join(caseDir, "02-design"), "artifacts-design.json", artifacts.design);
		if (artifacts.keyframes)
			writeJson(path.join(caseDir, "03-keyframes"), "artifacts-keyframes.json", artifacts.keyframes);
		if (artifacts.prompts) writeJson(path.join(caseDir, "01-script"), "artifacts-prompts.json", artifacts.prompts);
	}

	// 3) 资产文件逐个下载（含 08-assets 兜底 + 同名全量备份）
	const assets = artifacts?.assets ?? [];
	for (const asset of assets) {
		const rel = `assets/${asset.name}`;
		const bucket = bucketOf(asset.name);
		const hit = await safeDownload(base, runId, rel, path.join(caseDir, bucket), "asset", log);
		if (hit) {
			downloaded += 1;
			(files[bucket] ??= []).push(hit.name);
			// 关键产物额外留一份到 08-assets（保持"原始目录"语义）
			if (bucket !== "08-assets") await safeDownload(base, runId, rel, path.join(caseDir, "08-assets"), "copy", log);
		}
	}

	return { files, assets, downloaded };
}
