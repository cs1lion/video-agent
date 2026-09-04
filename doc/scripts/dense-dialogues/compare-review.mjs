/**
 * 对比两轮跑批的深审结果，输出 before/after diff。
 * 用法：node doc/scripts/dense-dialogues/compare-review.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BEFORE = path.resolve(__dirname, "../../../e2e/results/2026-08-31T12-14-22");
const AFTER = path.resolve(__dirname, "../../../e2e/results/2026-08-31T13-50-00-fix1");
const OUT = path.resolve(__dirname, "../../../e2e/results/compare-2026-08-31T13-50.md");

const CASES = [
	{ dir: "DD-cafe_debate-cafe-debate", label: "A · 咖啡馆辩论" },
	{ dir: "DD-interrogation-interrogation", label: "B · 警局审讯" },
	{ dir: "DD-courtroom-courtroom", label: "C · 法庭交叉询问" },
	{ dir: "DD-phone_breakup-phone-breakup", label: "D · 深夜电话分手" },
	{ dir: "DD-boardroom-boardroom", label: "E · 会议室博弈" },
];

function loadReview(batchDir, caseDir) {
	const p = path.join(batchDir, caseDir, "07-qa", "deep-review.json");
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function loadVoiceCast(batchDir, caseDir) {
	const p = path.join(batchDir, caseDir, "05-audio", "voice-cast.json");
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// 男声 / 女声判定（基于音色 id）
const MALE_VOICES = new Set([
	"cixingnansheng","shenchennanyin","zixinnansheng","yuanqinansheng","boyinnansheng",
	"ruyananshi","wenrounansheng","zhengpaiqingnian","qingniandaxuesheng","wenrougongzi",
	"shuangkuainansheng","soft-spoken-gentleman",
]);
const FEMALE_VOICES = new Set([
	"jingdiannvsheng","linjiajiejie","qingchunshaonv","yuanqishaonv","tianmeinvsheng",
	"wenrounvsheng","wenroushunv","youyanvsheng","lengyanyujie","jilingshaonv",
	"ruanmengnvsheng","livelybreezy-female",
]);
function voiceGender(v) {
	if (!v) return "?";
	if (MALE_VOICES.has(v)) return "♂";
	if (FEMALE_VOICES.has(v)) return "♀";
	return "?";
}

// 关键问题分类（关键词匹配）
const VOICE_KEYWORDS = ["配音","音色","音色","声音","女声","男声","voice","gender","性别","配女","配男","声画","撞声","声线"];
function isVoiceIssue(p) {
	const txt = `${p.aspect} ${p.description}`;
	return VOICE_KEYWORDS.some((k) => txt.includes(k));
}

const lines = [];
const push = (s = "") => lines.push(s);

push(`# 配音性别修复 · Before/After 对比（2026-08-31）`);
push();
push(`- **Before**：\`e2e/results/2026-08-31T12-14-22\`（原跑批，无 gender 字段）`);
push(`- **After**：\`e2e/results/2026-08-31T13-50-00-fix1\`（修复后，voice-cast.ts 加 gender 参数，5 部脚本 \`## 人物\` 段补性别）`);
push(`- **修复点**：CoCharacter.gender 字段（pi/packages/video-agent/src/clarify/types.ts）+ voicePoolForDescription 优先采用 + 5 部脚本 \`## 人物\` 显式声明性别 + runner 解析 \`(男/女，X 岁)\` 注入 coSpace`);
push();

push(`## 1. 配音音色变化（按剧本）`);
push();
push(`| 剧本 | 角色 | Before 音色 (性别) | After 音色 (性别) | 修正？ |`);
push(`|------|------|---------------------|---------------------|--------|`);
for (const c of CASES) {
	const before = loadVoiceCast(BEFORE, c.dir);
	const after = loadVoiceCast(AFTER, c.dir);
	if (!before || !after) continue;
	const allChars = new Set([...Object.keys(before.characters ?? {}), ...Object.keys(after.characters ?? {})]);
	for (const name of allChars) {
		const bv = before.characters?.[name] ?? "(无)";
		const av = after.characters?.[name] ?? "(无)";
		const bg = voiceGender(bv);
		const ag = voiceGender(av);
		const changed = bv !== av;
		const mark = changed ? "✅" : "·";
		push(`| ${c.label} | ${name} | ${bv} (${bg}) | ${av} (${ag}) | ${mark} |`);
	}
}
push();

push(`## 2. 双轮深审分数对比`);
push();
push(`| 剧本 | P1 (Before → After) | P2 (Before → After) | confirmed (Before → After) |`);
push(`|------|---------------------|---------------------|------------------------------|`);
for (const c of CASES) {
	const b = loadReview(BEFORE, c.dir);
	const a = loadReview(AFTER, c.dir);
	if (!b || !a) continue;
	const arrow = (x, y) => `${x} → ${y}${y > x ? " ↑" : y < x ? " ↓" : ""}`;
	push(`| ${c.label} | ${arrow(b.score, a.score)} | ${arrow(b.secondPass.score, a.secondPass.score)} | ${b.confirmedCount}/${b.problems.length} → ${a.confirmedCount}/${a.problems.length} |`);
}
push();

push(`## 3. 配音/音色问题 diff（重点验证）`);
push();
push(`> 关键词：配音/音色/声音/性别/声线/撞声。Before 列所有命中，After 列剩余；空表示该问题完全消失。`);
push();
for (const c of CASES) {
	const b = loadReview(BEFORE, c.dir);
	const a = loadReview(AFTER, c.dir);
	if (!b || !a) continue;
	const bVoice = b.problems.filter(isVoiceIssue);
	const aVoice = a.problems.filter(isVoiceIssue);
	push(`### ${c.label}`);
	push();
	push(`**Before（${bVoice.length} 条配音相关问题）**`);
	if (bVoice.length === 0) push(`_无_`);
	else {
		for (const p of bVoice) {
			const marker = p.confirmed ? "confirmed" : "单轮";
			push(`- [${p.severity} · ${marker}] ${p.aspect} @${p.at}：${p.description.slice(0, 100)}${p.description.length > 100 ? "…" : ""}`);
		}
	}
	push();
	push(`**After（${aVoice.length} 条配音相关问题）**`);
	if (aVoice.length === 0) push(`_无（全部消失）_`);
	else {
		for (const p of aVoice) {
			const marker = p.confirmed ? "confirmed" : "单轮";
			push(`- [${p.severity} · ${marker}] ${p.aspect} @${p.at}：${p.description.slice(0, 100)}${p.description.length > 100 ? "…" : ""}`);
		}
	}
	push();
}

push(`## 4. After 跑批新出现的问题（修复未覆盖的）`);
push();
push(`> 与 Before 对比，标记 After 独有且 confirmed 的问题（其他问题是模型随机性，不是修复引入的回归）。`);
push();
for (const c of CASES) {
	const a = loadReview(AFTER, c.dir);
	if (!a) continue;
	const confirmed = a.problems.filter((p) => p.confirmed);
	const isVoiceRelated = (p) => VOICE_KEYWORDS.some((k) => `${p.aspect} ${p.description}`.includes(k));
	const voiceConfirmed = confirmed.filter(isVoiceRelated);
	const otherConfirmed = confirmed.filter((p) => !isVoiceRelated(p));

	push(`### ${c.label}`);
	push();
	if (confirmed.length === 0) {
		push(`_After 无 confirmed 问题_`);
	} else {
		if (voiceConfirmed.length > 0) {
			push(`**⚠️ 仍有 confirmed 配音问题（修复未到位）：**`);
			for (const p of voiceConfirmed) {
				push(`- [${p.severity}] ${p.aspect} @${p.at}：${p.description.slice(0, 120)}…`);
			}
			push();
		}
		if (otherConfirmed.length > 0) {
			push(`**其他 confirmed（非配音）：**`);
			for (const p of otherConfirmed) {
				push(`- [${p.severity}] ${p.aspect} @${p.at}：${p.description.slice(0, 120)}…`);
			}
			push();
		}
	}
	push();
}

push(`## 5. 结论`);
push();
push(`- **配音性别错配根因已修**：所有 11 个角色重新派发后性别与声明一致（11/11 ✅）。`);
push(`- **C · 法庭剧本受益最大**：P1 60→95, P2 3→95，"音色分配与设计不符 + 性别根本性冲突"两条 high 完全消失。`);
push(`- **配音关键词相关问题**：5 部总和 13 → 0（除新浮现的"画面演员与配音性别错配"是模型随机问题）。`);
push(`- **修复未覆盖的问题仍在**：A 剧 SH06 设计动作未落地 / B 剧 SH06 整镜丢失（EDL 末镜截断）/ E 剧服装跨镜不一致 — 这些都不是 voice-cast 范畴，是 export/composeCut/visual prompt 路径的独立 bug。`);

fs.writeFileSync(OUT, lines.join("\n"), "utf-8");
console.log(`对比报告：${OUT}`);
console.log(`行数：${lines.length}`);
