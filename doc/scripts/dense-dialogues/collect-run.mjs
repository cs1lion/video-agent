/**
 * 给已 done 的 run 补抓所有资产到 caseDir
 * 用法：node doc/scripts/dense-dialogues/collect-run.mjs <runId> <caseDir>
 */

import * as fs from "node:fs";
import * as path from "node:path";

const API_BASE = process.env.VIDEO_AGENT_API ?? "http://127.0.0.1:8790";

const runId = process.argv[2];
const caseDir = path.resolve(process.argv[3]);
if (!runId || !caseDir) {
	console.error("用法：node doc/scripts/dense-dialogues/collect-run.mjs <runId> <caseDir>");
	process.exit(1);
}

const bucketOf = (name) => {
	if (/^design-/.test(name)) return "02-design";
	if (/^key-/.test(name)) return "03-keyframes";
	if (/^clip-/.test(name)) return "04-clips";
	if (/^tts-/.test(name)) return "05-audio";
	if (/^bgm/.test(name)) return "05-audio";
	if (/^shot-|^cut\d?-shot-/.test(name)) return "06-export";
	if (/^final|^cut\d+\.mp4$/.test(name)) return "06-export";
	if (/^qa-/.test(name) || /\.ass$/.test(name)) return "06-export";
	return "08-assets";
};

async function downloadFile(urlPath, targetPath) {
	const res = await fetch(`${API_BASE}${urlPath}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, buf);
	return buf.length;
}

const arts = await fetch(`${API_BASE}/api/runs/${encodeURIComponent(runId)}/artifacts`).then((r) => r.json());
const assets = arts.assets ?? [];
console.log(`assets count: ${assets.length}`);

let ok = 0, fail = 0;
for (const a of assets) {
	const bucket = bucketOf(a.name);
	try {
		await downloadFile(
			`/api/runs/${encodeURIComponent(runId)}/files/assets/${a.name}`,
			path.join(caseDir, bucket, a.name),
		);
		ok += 1;
	} catch (e) {
		fail += 1;
	}
}

// 兜底：voice-cast.json / transitions.json / consistency.json
for (const [bucket, name] of [
	["05-audio", "voice-cast.json"],
	["06-export", "transitions.json"],
	["07-qa", "consistency.json"],
	["07-qa", "run-state.json"],
	["07-qa", "verdict.json"],
]) {
	try {
		await downloadFile(
			`/api/runs/${encodeURIComponent(runId)}/files/${name}`,
			path.join(caseDir, bucket, name),
		);
		console.log(`  + ${name}`);
	} catch {}
}

// 文本产物
for (const [bucket, name, key] of [
	["01-script", "script.json", "script"],
	["01-script", "voice-directions.json", "voiceDirections"],
	["02-design", "visual-bible.json", "bible"],
	["02-design", "design-bible.json", "design"],
	["03-keyframes", "keyframes.json", "keyframes"],
	["03-keyframes", "prompts.json", "prompts"],
]) {
	try {
		const text = arts[key];
		if (text && typeof text === "object") {
			fs.mkdirSync(path.join(caseDir, bucket), { recursive: true });
			fs.writeFileSync(path.join(caseDir, bucket, name), JSON.stringify(text, null, "\t"), "utf-8");
			console.log(`  + ${name} (from artifacts)`);
		}
	} catch {}
}

console.log(`完成：${ok} 个资产，${fail} 个失败`);
