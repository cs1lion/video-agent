/** 离线自检：用例定义 / WAV 合成 / 断言逻辑。不需要服务在跑。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CASES } from "./cases.mjs";
import { fileToDataUrl, synthesizeWav } from "./lib/wav.mjs";
import { assertCase } from "./lib/report.mjs";

console.log("cases:", CASES.map((c) => `${c.id}(${c.audioForm},${c.options.shotCount}镜)`).join(" "));

for (const c of CASES) {
	if (c.options.audioDrive !== "dialogue") throw new Error(`${c.id} 应为台词驱动（全台词方案）`);
	if (!c.coSpace) throw new Error(`${c.id} dialogue 缺 coSpace，会被 A1 闸门回落 off`);
	if (c.coSpace.characters?.length < 2) throw new Error(`${c.id} coSpace 应有 ≥2 个角色（对白需要说话人）`);
	if (!/写实|真人|纪录/.test(c.brief.logline)) throw new Error(`${c.id} brief 未钉死写实话术`);
	if (!/旁白/.test(c.brief.logline)) throw new Error(`${c.id} brief 应要求旁白+对白交织（保证字幕来源）`);
	if (!c.coSpace.characters.every((ch) => /男|女/.test(ch.description))) {
		throw new Error(`${c.id} 角色描述应写明性别（配音选角与人物一致性依赖）`);
	}
	if (!/anime|cartoon/.test(c.options.negativePrompt)) throw new Error(`${c.id} 负向词缺非写实排除项`);
	if (!/garbled text/.test(c.options.negativePrompt)) throw new Error(`${c.id} 负向词缺乱码文字排除项`);
	if (!c.expect.requireDialogueShots) throw new Error(`${c.id} 必须断言台词镜存在（全台词方案）`);
	if ((c.expect.minShots ?? 0) < 6) throw new Error(`${c.id} 压力轮镜数应 ≥6（多轮对话容量）`);
	if (c.options.clipDurationSec < 6) throw new Error(`${c.id} 压力轮单镜应 ≥6s（长镜对白）`);
	if (!c.brief.logline.includes("四轮") && !c.brief.logline.includes("五轮")) throw new Error(`${c.id} brief 应声明多轮对讲`);
	if (!c.expect.requireTtsAudio) throw new Error(`${c.id} 必须断言 TTS 音轨存在`);
	if (!c.expect.requireSubtitlesAudit) throw new Error(`${c.id} 必须断言字幕结构审核通过`);
	if (!c.expect.requireVoiceDistinction) throw new Error(`${c.id} 必须断言配音选角区分`);
	if (c.options.shotCount < 3 || c.options.shotCount > 30) throw new Error(`${c.id} 镜头数越界`);
	if (c.options.clipDurationSec < 3 || c.options.clipDurationSec > 12) throw new Error(`${c.id} 镜长越界`);
}

const seconds = 3;
const tmp = path.join(os.tmpdir(), "e2e-bgm-test.wav");
synthesizeWav({ seconds, outPath: tmp });
const buf = fs.readFileSync(tmp);
const riff = buf.toString("ascii", 0, 4);
const wave = buf.toString("ascii", 8, 12);
const rate = buf.readUInt32LE(24);
const bits = buf.readUInt16LE(34);
const dataSize = buf.readUInt32LE(40);
const expectSize = seconds * 44100 * 2;
console.log(`wav: ${riff}/${wave} rate=${rate} bits=${bits} data=${dataSize}B (expect ${expectSize}B)`);
if (riff !== "RIFF" || wave !== "WAVE" || rate !== 44100 || bits !== 16 || dataSize !== expectSize)
	throw new Error("WAV 头或数据长度不合法");
const dataUrl = fileToDataUrl(tmp);
if (!/^data:audio\/wav;base64,/.test(dataUrl)) throw new Error("dataUrl MIME 不合法");
console.log("dataUrl ok:", `${dataUrl.slice(0, 32)}...`);

const stages = ["script", "visual", "prompts", "keyframes", "audio", "clips", "export"].map((id) => ({
	id,
	status: "done",
	progress: 100,
}));
/** 七轴 verdict 夹具（与服务端 foldQaAxes 的轴集一致）+ 健康字幕审核 */
function healthyVerdict(score, subtitleIssues = []) {
	return {
		score,
		overall: score >= 80 && subtitleIssues.length === 0 ? "pass" : "warn",
		axes: [
			{ id: "briefFit", score },
			{ id: "visualConsistency", score: score - 2 },
			{ id: "pacing", score: score - 4 },
			{ id: "physicalAccuracy", score: score - 3 },
			{ id: "characterConsistency", score: score - 1 },
			{ id: "audioSync", score: 100 },
			{ id: "textQuality", score: score - 1 },
		],
		shots: [{ id: "SH01", verdict: "ok", reason: "通过" }],
		subtitles: { present: true, lines: 2, issues: subtitleIssues },
	};
}
function healthyAssets({ shots = 5, withBgm = false } = {}) {
	const list = [];
	for (let i = 1; i <= shots; i += 1) {
		const id = `SH${String(i).padStart(2, "0")}`;
		list.push({ name: `key-${id}.png` }, { name: `clip-${id}.mp4` }, { name: `tts-${id}.mp3` });
	}
	list.push({ name: "final.mp4" });
	if (withBgm) list.push({ name: "bgm.mp3" });
	return list;
}
const healthyVoiceCast = {
	narratorVoiceId: "jingdiannvsheng",
	characters: { "角色A": "cixingnansheng", "角色B": "linjiajiejie" },
	notes: [],
};
const dialogueRun = (score, shotCount, subtitleIssues = []) => ({
	status: "done",
	stages,
	productionShots: shotCount,
	dialogueShotCount: Math.max(1, shotCount - 1),
	verdict: healthyVerdict(score, subtitleIssues),
});
const baseCase = (extra = {}) => ({
	voiceCast: healthyVoiceCast,
	audioForm: "dialogue",
	finalBytes: 3_000_000,
	collected: { files: { "06-export": ["final.mp4"] }, assets: healthyAssets() },
	...extra,
});

// 三套压力片逐套断言（F3 带 BGM）
for (const [idx, c] of CASES.entries()) {
	const r = assertCase({
		...baseCase(),
		expect: c.expect,
		audioForm: c.audioForm,
		finalBytes: 5_000_000,
		run: dialogueRun(84, c.options.shotCount),
		collected: { files: { "06-export": ["final.mp4"] }, assets: healthyAssets({ shots: c.options.shotCount, withBgm: Boolean(c.bgm) }) },
	});
	console.log(`${c.id} ->`, r.verdict, "| 失败项:", r.failed.length ? r.failed.join("; ") : "无");
	if (r.verdict !== "PASS") throw new Error(`${c.id} 应判 PASS`);
}

// 审核轴缺失必须 FAIL
const noAuditAxes = assertCase({
	...baseCase(),
	expect: CASES[0].expect,
	run: {
		...dialogueRun(78, 3),
		verdict: { score: 78, overall: "warn", axes: [{ id: "briefFit", score: 78 }], subtitles: { present: true, lines: 2, issues: [] } },
	},
});
if (noAuditAxes.verdict !== "FAIL" || !noAuditAxes.failed.some((f) => f.includes("物理/人物/文字审核轴")))
	throw new Error("缺审核轴应显式 FAIL");
console.log("no audit axes ->", noAuditAxes.verdict, "| 失败项:", noAuditAxes.failed.join("; "));

// 旁白与角色撞声必须 FAIL（配音选角铁律）
const sameVoice = assertCase({
	...baseCase(),
	voiceCast: { narratorVoiceId: "cixingnansheng", characters: { "角色A": "cixingnansheng", "角色B": "qingchunshaonv" }, notes: [] },
	expect: CASES[0].expect,
	run: dialogueRun(78, 3),
});
if (sameVoice.verdict !== "FAIL" || !sameVoice.failed.some((f) => f.includes("旁白音色与角色错开")))
	throw new Error("旁白与角色撞声应显式 FAIL");
console.log("same narrator voice ->", sameVoice.verdict, "| 失败项:", sameVoice.failed.join("; "));

// 字幕结构问题必须 FAIL 并逐条留痕
const badSubs = assertCase({
	...baseCase(),
	expect: CASES[0].expect,
	run: dialogueRun(78, 3, ["字幕覆盖缺口：旁白 2 段，字幕只有 1 行"]),
});
if (badSubs.verdict !== "FAIL" || !badSubs.failed.some((f) => f.includes("字幕覆盖缺口")))
	throw new Error("字幕结构问题应显式 FAIL");
console.log("bad subtitles ->", badSubs.verdict, "| 失败项:", badSubs.failed.join("; "));

// 十套正片逐套断言（特殊覆盖：F2 自审 / F3 BGM；其余标准链路）
for (const [idx, c] of CASES.entries()) {
	if (idx === 0) continue; // F1 已断言
	const postFacts = c.expect.requireDesignReview
		? { designReview: { count: 4, fail: 0, warn: 1 }, keyframeReview: { count: 5, fail: 0, warn: 2 } }
		: {};
	const r = assertCase({
		...baseCase(),
		expect: c.expect,
		audioForm: c.audioForm,
		finalBytes: 4_000_000,
		run: dialogueRun(84, c.options.shotCount),
		collected: { files: { "06-export": ["final.mp4"] }, assets: healthyAssets({ shots: c.options.shotCount, withBgm: Boolean(c.bgm) }) },
		postFacts,
	});
	console.log(`${c.id} ->`, r.verdict, "| 失败项:", r.failed.length ? r.failed.join("; ") : "无");
	if (r.verdict !== "PASS") throw new Error(`${c.id} 应判 PASS`);
}


const bad = assertCase({
	...baseCase(),
	expect: CASES[0].expect,
	finalBytes: 1024,
	run: { status: "failed", stages, dialogueShotCount: 0 },
	collected: { files: {}, assets: [] },
});
console.log("broken run ->", bad.verdict, "| 失败项数:", bad.failed.length);
if (bad.verdict !== "FAIL") throw new Error("异常用例应判 FAIL");

// 用例矩阵自检：压力轮三套、id 唯一、结构合规
if (CASES.length !== 3) throw new Error(`本轮应为 3 套压力片，实际 ${CASES.length}`);
if (new Set(CASES.map((c) => c.id)).size !== CASES.length) throw new Error("用例 id 重复");
for (const c of CASES) {
	if (!Array.isArray(c.postActions)) throw new Error(`${c.id} 缺 postActions 数组`);
	if (c.bgm && typeof c.bgm.file !== "string") throw new Error(`${c.id} bgm 缺 file`);
	if (c.options.audioDrive === "dialogue" && !c.coSpace) throw new Error(`${c.id} dialogue 缺 coSpace`);
}
console.log(`cases ok: ${CASES.length} 套（古今中外 · 全台词驱动 · 分龄音色池），id 唯一，结构合规`);

console.log("SELFCHECK PASS");
