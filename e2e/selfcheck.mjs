/** 离线自检：用例定义 / WAV 合成 / 断言逻辑。不需要服务在跑。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CASES } from "./cases.mjs";
import { fileToDataUrl, synthesizeWav } from "./lib/wav.mjs";
import { assertCase } from "./lib/report.mjs";

console.log("cases:", CASES.map((c) => `${c.id}(${c.audioForm},${c.options.shotCount}镜)`).join(" "));

for (const c of CASES) {
	if (c.options.audioDrive === "dialogue" && !c.coSpace)
		throw new Error(`${c.id} dialogue 缺 coSpace，会被 A1 闸门回落 off`);
	if (!/写实|真人|纪录/.test(c.brief.logline)) throw new Error(`${c.id} brief 未钉死写实话术`);
	if (!/anime|cartoon/.test(c.options.negativePrompt)) throw new Error(`${c.id} 负向词缺非写实排除项`);
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

const stages = ["script", "visual", "prompts", "keyframes", "clips", "audio", "export"].map((id) => ({
	id,
	status: "done",
	progress: 100,
}));
/** 造一份"健康"的资产清单：5 镜全齐（关键帧 + 片段 + 旁白 + 成片） */
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

const good = assertCase({
	expect: CASES[1].expect, // C2：旁白形态，期望 ≥5 镜 + 旁白音轨
	audioForm: "narration",
	finalBytes: 2 * 1024 * 1024,
	run: {
		status: "done",
		stages,
		productionShots: 5,
		verdict: { score: 80, overall: "warn", axes: [{ id: "briefFit", score: 80 }] },
		dialogueShotCount: 0,
	},
	collected: { files: { "06-export": ["final.mp4"] }, assets: healthyAssets() },
});
console.log("healthy run ->", good.verdict, "| 失败项:", good.failed.length ? good.failed.join("; ") : "无");
if (good.verdict !== "PASS") throw new Error("健康用例应判 PASS");

// C3：纯 BGM 形态（有 bgm、无 tts 也算达标，因为 expect.requireNarrationAudio=false）
const bgmCase = assertCase({
	expect: CASES[2].expect,
	audioForm: "bgm",
	finalBytes: 1_500_000,
	run: {
		status: "done",
		stages,
		productionShots: 6,
		verdict: { score: 82, overall: "pass", axes: [{ id: "briefFit", score: 82 }] },
		dialogueShotCount: 0,
	},
	collected: { files: { "06-export": ["final.mp4"] }, assets: healthyAssets({ shots: 6, withBgm: true }) },
});
console.log("bgm run ->", bgmCase.verdict, "| 失败项:", bgmCase.failed.length ? bgmCase.failed.join("; ") : "无");
if (bgmCase.verdict !== "PASS") throw new Error("纯 BGM 用例应判 PASS");

// C1 台词形态：台词镜 > 0 才算过（验证 A1 闸门未回落）
const dialogueCase = assertCase({
	expect: CASES[0].expect,
	audioForm: "dialogue",
	finalBytes: 3_000_000,
	run: {
		status: "done",
		stages,
		productionShots: 5,
		dialogueShotCount: 3,
		verdict: { score: 78, overall: "warn", axes: [{ id: "briefFit", score: 78 }] },
	},
	collected: { files: { "06-export": ["final.mp4"] }, assets: healthyAssets() },
});
console.log("dialogue run ->", dialogueCase.verdict, "| 失败项:", dialogueCase.failed.length ? dialogueCase.failed.join("; ") : "无");
if (dialogueCase.verdict !== "PASS") throw new Error("台词用例应判 PASS");

const bad = assertCase({
	expect: CASES[0].expect,
	audioForm: "dialogue",
	finalBytes: 1024,
	run: { status: "failed", stages, dialogueShotCount: 0 },
	collected: { files: {}, assets: [] },
});
console.log("broken run ->", bad.verdict, "| 失败项数:", bad.failed.length);
if (bad.verdict !== "FAIL") throw new Error("异常用例应判 FAIL");

// C5：长片 + 双向出图自审
const reviewCase = assertCase({
	expect: CASES[4].expect,
	audioForm: "narration",
	finalBytes: 5_000_000,
	run: {
		status: "done",
		stages,
		productionShots: 10,
		verdict: { score: 84, overall: "pass", axes: [{ id: "briefFit", score: 84 }] },
	},
	collected: { files: { "06-export": ["final.mp4"] }, assets: healthyAssets({ shots: 10 }) },
	postFacts: { designReview: { count: 6, fail: 0, warn: 1 }, keyframeReview: { count: 10, fail: 1, warn: 2 } },
});
console.log("longfilm+review ->", reviewCase.verdict, "| 失败项:", reviewCase.failed.length ? reviewCase.failed.join("; ") : "无");
if (reviewCase.verdict !== "PASS") throw new Error("长片自审用例应判 PASS");

// C6：重做链路（补拍产生 _v1 + 组合出片 cut1；服务端命名无连字符，见 redo/compose.ts）
const redoAssets = [...healthyAssets(), { name: "clip-SH03_v1.mp4" }, { name: "tts-SH02_v1.mp3" }, { name: "cut1.mp4" }];
const redoCase = assertCase({
	expect: CASES[5].expect,
	audioForm: "narration",
	finalBytes: 3_500_000,
	run: {
		status: "done",
		stages,
		productionShots: 5,
		verdict: { score: 79, overall: "warn", axes: [{ id: "briefFit", score: 79 }] },
	},
	collected: { files: { "06-export": ["final.mp4"] }, assets: redoAssets },
	postFacts: { reshotShots: ["SH03"], composeCuts: [null] },
});
console.log("redo chain ->", redoCase.verdict, "| 失败项:", redoCase.failed.length ? redoCase.failed.join("; ") : "无");
if (redoCase.verdict !== "PASS") throw new Error("重做链路用例应判 PASS");

// C7：制片主任 + 竖屏多画幅（含"被守卫合法拒绝"的留痕不应判失败）
const multiAssets = [...healthyAssets({ withBgm: true }), { name: "final-9x16.mp4" }];
const multiCase = assertCase({
	expect: CASES[6].expect,
	audioForm: "bgm",
	finalBytes: 2_800_000,
	run: {
		status: "done",
		stages,
		productionShots: 5,
		verdict: { score: 81, overall: "warn", axes: [{ id: "briefFit", score: 81 }] },
	},
	collected: { files: { "06-export": ["final.mp4", "final-9x16.mp4"] }, assets: multiAssets },
	postFacts: {
		kitchen: { id: "obs-1", suggestionCount: 2, suggestions: [{ id: "s1" }] },
		portraitExports: [{ aspectRatio: "9:16", status: "done" }],
		errors: ["kitchenApply: 建议被 L2 守卫拒绝（冷却期内）"],
	},
});
console.log("producer+multiformat ->", multiCase.verdict, "| 失败项:", multiCase.failed.length ? multiCase.failed.join("; ") : "无");
if (multiCase.verdict !== "PASS") throw new Error("制片主任/多画幅用例应判 PASS");

// 用例矩阵自检：七套、id 唯一、结构合规
if (CASES.length !== 7) throw new Error(`用例应为 7 套，实际 ${CASES.length}`);
if (new Set(CASES.map((c) => c.id)).size !== CASES.length) throw new Error("用例 id 重复");
for (const c of CASES) {
	if (!Array.isArray(c.postActions)) throw new Error(`${c.id} 缺 postActions 数组`);
	if (c.bgm && typeof c.bgm.file !== "string") throw new Error(`${c.id} bgm 缺 file`);
	if (c.options.audioDrive === "dialogue" && !c.coSpace) throw new Error(`${c.id} dialogue 缺 coSpace`);
}
console.log(`cases ok: ${CASES.length} 套，id 唯一，postActions / bgm / coSpace 结构合规`);

console.log("SELFCHECK PASS");
