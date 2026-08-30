/**
 * 一次性：用最新断言规则重算某用例的结论并重写 report.md + summary.json。
 * 用法：node e2e/reassert.mjs <批次目录> <用例目录名>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { assertCase, writeCaseReport } from "./lib/report.mjs";

const batch = process.argv[2];
const caseDirName = process.argv[3];
const caseDir = path.join(batch, caseDirName);
const runFinal = JSON.parse(fs.readFileSync(path.join(caseDir, "logs", "run-final.json"), "utf-8"));

// 从磁盘重建 collected 结构（目录 → 文件名列表；assets = 08-assets 清单）
const files = {};
const assets = [];
const buckets = ["00-input", "01-script", "02-design", "03-keyframes", "04-clips", "05-audio", "06-export", "07-qa", "08-assets"];
for (const b of buckets) {
	const dir = path.join(caseDir, b);
	if (!fs.existsSync(dir)) continue;
	const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
	files[b] = names;
	if (b === "08-assets") for (const n of names) assets.push({ name: n });
}

const postFacts = JSON.parse(fs.readFileSync(path.join(caseDir, "logs", "post-actions.json"), "utf-8")).errors
	? JSON.parse(fs.readFileSync(path.join(caseDir, "logs", "post-actions.json"), "utf-8"))
	: {};
const timings = JSON.parse(fs.readFileSync(path.join(caseDir, "logs", "timings.json"), "utf-8"));
const gates = JSON.parse(fs.readFileSync(path.join(caseDir, "logs", "gate-decisions.json"), "utf-8"));

// 期望从 summary 里原用例取
const summary = JSON.parse(fs.readFileSync(path.join(batch, "summary.json"), "utf-8"));
const prev = summary.results.find((r) => r.dir === caseDirName);
const { CASES } = await import("./cases.mjs");
const testCase = CASES.find((c) => c.id === prev.id);

let voiceCast = null;
try {
	voiceCast = JSON.parse(fs.readFileSync(path.join(caseDir, "05-audio", "voice-cast.json"), "utf-8"));
} catch {}

const finalAsset = (assets ?? []).find((a) => /^final.*\.mp4$/.test(a.name));
const finalBytes = finalAsset ? fs.statSync(path.join(caseDir, "06-export", finalAsset.name)).size : 0;

const assert = assertCase({
	expect: testCase.expect,
	run: runFinal,
	collected: { files, assets },
	finalBytes,
	audioForm: testCase.audioForm,
	postFacts,
	voiceCast,
});

writeCaseReport(caseDir, { testCase, run: runFinal, assert, timings, gates, collected: { files, assets }, finalBytes, postFacts, voiceCast });
prev.assert = assert;
prev.run = { ...prev.run, status: runFinal.status, verdict: runFinal.verdict };
prev.productionShots = runFinal.productionShots;
prev.dialogueShotCount = runFinal.dialogueShotCount;

// 重写 summary（复用 writeBatchReport 的 json 部分；index.html 由 summary 重建太重——保持原样，只更新 summary.json/md 的结论行）
summary.pass = summary.results.filter((r) => r.assert.verdict === "PASS").length;
fs.writeFileSync(path.join(batch, "summary.json"), JSON.stringify(summary, null, "\t"), "utf-8");
console.log(`${prev.id} 重算 → ${assert.verdict}（失败 ${assert.failed.length}）| 批次 PASS ${summary.pass}/${summary.total}`);
