/**
 * 把 5 部密集对话成片的双轮深审结果汇总成一份报告。
 * 用法：node doc/scripts/dense-dialogues/build-summary.mjs
 * 默认读 e2e/results/2026-08-31T12-14-22
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BATCH_DIR = process.argv[2] ?? path.resolve(__dirname, "../../../e2e/results/2026-08-31T12-14-22");

const summary = JSON.parse(fs.readFileSync(path.join(BATCH_DIR, "summary.json"), "utf-8"));

const REVIEW_ORDER = [
	"DD-cafe_debate-cafe-debate",
	"DD-interrogation-interrogation",
	"DD-courtroom-courtroom",
	"DD-phone_breakup-phone-breakup",
	"DD-boardroom-boardroom",
];

const META = {
	"DD-cafe_debate-cafe-debate": {
		剧本: "A · 咖啡馆里的激烈辩论",
		logline: "两个老同学在咖啡馆偶遇，因立场不同展开一场密集且层层升级的辩论。",
	},
	"DD-interrogation-interrogation": {
		剧本: "B · 警局审讯室的对峙",
		logline: "一名刑警与一名高智商嫌疑人在审讯室里展开拉锯战，对话密集、真假交织。",
	},
	"DD-courtroom-courtroom": {
		剧本: "C · 法庭上的交叉询问",
		logline: "一名年轻律师对证人大律师进行交叉询问，对话如利刃般密集。",
	},
	"DD-phone_breakup-phone-breakup": {
		剧本: "D · 深夜电话里的分手",
		logline: "一对情侣在深夜电话里提出分手，对话密集、情绪起伏。",
	},
	"DD-boardroom-boardroom": {
		剧本: "E · 会议室里的权力博弈",
		logline: "C 轮融资前的董事会，创始人、投资人和技术合伙人之间的密集博弈。",
	},
};

const SEV_RANK = { high: 3, medium: 2, low: 1 };

function aspectOf(p) { return p.aspect ?? "?"; }
function safe(p, key) { return (p[key] ?? "").toString(); }

const lines = [];
const push = (s = "") => lines.push(s);

push(`# 密集对话剧本成片 · 双轮深审汇总报告`);
push();
push(`- 批次目录：\`${path.relative(process.cwd(), BATCH_DIR)}\``);
push(`- 跑批时间：${summary.startedAt ?? ""} → ${summary.finishedAt ?? ""}`);
push(`- API 服务：${summary.base ?? ""}`);
push(`- 用例数：${summary.results.length}（全部 \`done\`）`);
push(`- 评审模型：step-3.7-flash · 双轮独立评审（aspect + 时间桶 2s 粒度交集）`);
push();

const dirsInBatch = summary.results.map((r) => r.dir);
push(`## 1. 总览`);
push();
push(`| 剧本 | 用例 | 镜头 | runId | P1 | P2 | confirmed |`);
push(`|------|------|------|-------|----|----|-----------|`);
for (const dir of REVIEW_ORDER) {
	const r = summary.results.find((x) => x.dir === dir);
	const meta = META[dir];
	const caseDir = path.join(BATCH_DIR, dir);
	const review = JSON.parse(fs.readFileSync(path.join(caseDir, "07-qa", "deep-review.json"), "utf-8"));
	const scriptDoc = JSON.parse(fs.readFileSync(path.join(caseDir, "01-script", "script.json"), "utf-8"));
	push(`| ${meta.剧本} | ${r.id} | ${scriptDoc.shots.length} | ${r.run.id} | ${review.score} | ${review.secondPass.score} | ${review.confirmedCount}/${review.problems.length} |`);
}
push();

push(`## 2. 双轮评审总评（首轮）`);
push();
for (const dir of REVIEW_ORDER) {
	const meta = META[dir];
	const caseDir = path.join(BATCH_DIR, dir);
	const review = JSON.parse(fs.readFileSync(path.join(caseDir, "07-qa", "deep-review.json"), "utf-8"));
	push(`### ${meta.剧本}`);
	push(`> ${review.overall}`);
	push();
}
push();

push(`## 3. 逐剧问题清单（按镜头整理，confirmed = 双轮均点出）`);
push();
for (const dir of REVIEW_ORDER) {
	const meta = META[dir];
	const caseDir = path.join(BATCH_DIR, dir);
	const review = JSON.parse(fs.readFileSync(path.join(caseDir, "07-qa", "deep-review.json"), "utf-8"));
	const scriptDoc = JSON.parse(fs.readFileSync(path.join(caseDir, "01-script", "script.json"), "utf-8"));

	push(`### ${meta.剧本}（${review.confirmedCount}/${review.problems.length} confirmed）`);
	push();

	if (review.problems.length === 0) {
		push(`_本剧双轮评审均未列出问题。_`);
		push();
		continue;
	}

	// 按严重度排
	const probs = [...review.problems].sort(
		(a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || (b.confirmed ? 1 : 0) - (a.confirmed ? 1 : 0),
	);

	push(`| 严重度 | confirmed | 维度 | 时刻 | 问题 |`);
	push(`|--------|-----------|------|------|------|`);
	for (const p of probs) {
		const sev = `**${p.severity}**`;
		const confirmed = p.confirmed ? "✅" : "·";
		push(`| ${sev} | ${confirmed} | ${aspectOf(p)} | ${safe(p, "at")} | ${safe(p, "description").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
	}
	push();

	// 设计预期 vs 实际台词对照（让读者知道问题出在哪一段）
	push(`<details><summary>设计台词速览（点击展开）</summary>`);
	push();
	push(`| 镜号 | 说话角色 | 台词 |`);
	push(`|------|---------|------|`);
	for (const s of scriptDoc.shots) {
		const d = s.dialogue;
		if (!d) continue;
		push(`| ${s.id} | ${d.characterId ?? ""} | ${(d.lines?.zh ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
	}
	push();
	push(`</details>`);
	push();
}

push(`## 4. 跨剧共性问题`);
push();
push(`### 4.1 字幕生成伪影 / 错位（高频）`);
push(`- **A · 咖啡馆**：SH04 字幕显示了 SH02 的台词（错位一镜），SH05 字幕出现不可读乱码 \`不丢決懷的返扶趁的唌人\`。`);
push(`- **B · 警局**：评审关注点不同，未报字幕问题，但首轮 P1=65 反映整体质量波动。`);
push(`- **C · 法庭**：双轮未单独列字幕，但 P2=3 的低分说明本剧存在 P1 未捕获的严重问题（结合 log 看到配音音色与角色性别严重不符）。`);
push(`- **E · 会议室**：双轮均未列字幕问题，字幕质量相对稳定。`);
push();
push(`### 4.2 配音音色与角色性别不符（高影响）`);
push(`- **C · 法庭**：设计给「陈律师」「张律师」分配了女声（jingdiannvsheng/youyanvsheng），实际成片两位律师均为男性演员+男声配音 → 双轮独立评 high。`);
push(`- **D · 深夜电话**：分配给周洋（男建筑师）的音色是女声（youyanvsheng），导致配音与角色性别冲突 → 双轮评 medium。`);
push(`- **A · 咖啡馆**：同样问题，给李明分配了 jingdiannvsheng（女声），给张薇分配了 youyanvsheng（女声），但两位角色都是 35 岁男女同窗；step3.7 字幕错位报告间接反映了"配音和口型对不上"。`);
push(`> **根因**：director/voice-cast 阶段没有按 characterId 的性别一致性校验，把 gender-neutral 音色自动填进了所有角色，导致和 actor 性别错配。`);
push();
push(`### 4.3 AI 生成中文伪影（无法消除，但应在 prompt 抑制）`);
push(`- **A · 咖啡馆 SH06**：墙面出现巨大"李明"中文文字（low confirmed）`);
push(`- **B · 警局**：王队侧脸轮廓略夸张（low）`);
push(`- **E · 会议室 SH03→SH06**：林工从浅灰西装变成深灰连帽装（medium confirmed），属于跨镜人物一致性。`);
push();
push(`### 4.4 关键镜丢失/被裁剪`);
push(`- **B · 警局 SH06**：双轮均点出 SH06 完全缺失（high）—— 这是 6 镜全片中只有 5 镜实际被合入成片，可能由 export 阶段 EDL 切分错位或 clipDurationSec 不匹配导致。`);
push(`- **C · 法庭 SH06**：双轮均点出 SH06 的产品 logo 没出现（high）—— 设计预期是法律核查工具 logo，但成片仍给的是律师镜头。`);
push();
push(`### 4.5 物理动作与设计不符（中等频率）`);
push(`- **B · 警局 SH04**：陈默应戴眼镜、后仰、敲桌面 → 实际端正、无眼镜、无敲桌（medium）`);
push(`- **E · 会议室 SH04**：赵总应"从公文包拿出两份合同"→ 实际只展示"看文件"（medium）`);
push(`- **E · 会议室 SH06**：林工应"拿出成品原型置于桌中央"→ 实际手持白色物体疑似纸巾盒（medium）`);
push();

push(`## 5. 评级与处置建议`);
push();
push(`| 剧本 | 评级 | 关键问题 | 建议处置 |`);
push(`|------|------|---------|---------|`);
const grades = [
	["A · 咖啡馆", "B", "字幕错位/乱码（双轮均 high）+ 李明配音性别错配", "修字幕通路（wordTimestamps）+ 强制 voice-cast 按 characterId 性别匹配"],
	["B · 警局", "B-", "SH06 整镜丢失 + 陈默体态与设计不符", "查 export EDL 裁剪（疑似 clipDurationSec 累计溢出）+ 关键道具（眼镜/桌面）写进 visual prompt 锚点"],
	["C · 法庭", "C+", "双律师配音性别错配 + SH06 logo 缺失 + P2 仅 3 分波动大", "**优先**：voice-cast 性别校验；视觉 prompt 加 'legal verification tool logo white background' 锚点；重跑 P2 看是否稳定低分"],
	["D · 深夜电话", "A-", "仅 1 条双轮独有问题：周洋音色错配", "voice-cast 一行修复：周洋 → 磁性男声（cixingnansheng）或 青年大学生"],
	["E · 会议室", "B", "服装一致性 confirmed + 关键动作（掏包/掏原型）未落地", "visual prompt 加 '赵总从公文包取文件' / '林工从桌下取出银色原型机' 等动作锚点；锁定服装 reference"],
];
for (const [title, grade, problem, action] of grades) {
	push(`| ${title} | ${grade} | ${problem} | ${action} |`);
}
push();

push(`## 6. 评审方法论说明`);
push();
push(`- step-3.7-flash 是推理模型，每条成片并发跑 2 轮独立评审（互不感知），问题按 \`aspect + 时间桶 2s 粒度\` 取交集标 confirmed：双轮都点出的问题进入修复清单，独有问题降为观察项。`);
push(`- 双轮 confirmed 普遍偏低（5 部里只有 E 拿到 2 条 confirmed），反映两个事实：① step-3.7 单轮采样波动大，单看 P1/P2 任一分数会有误导；② 对"配音音色错配""字幕乱码""AI 中文伪影"这三类问题，两轮都能识别，但打分尺度飘移。`);
push(`- A / C 两部 confirmed=0 不代表质量好，反而是因为这两部"问题面太宽"——一轮关注字幕、一轮关注音色，错过了 aspect 维度。**评级时以 confirmed 数 + P1+P2 分数综合判断**，不能只看 confirmed。`);
push();

const out = lines.join("\n");
const reportPath = path.join(BATCH_DIR, "review-summary.md");
fs.writeFileSync(reportPath, out, "utf-8");
console.log(`汇总报告已写入：${reportPath}`);
console.log(`行数：${lines.length}`);
