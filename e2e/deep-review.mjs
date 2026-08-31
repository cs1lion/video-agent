#!/usr/bin/env node
/**
 * 整片深审（一次性脚本）：成片视频(base64) + 剧本设计预期 + 审阅要求 → step-3.7-flash
 * 视频理解 → 问题清单。不抽帧，直接发视频让模型看完挑问题。
 *
 * v2（2026-08-31）：双轮独立评审取交集——同一部片并行跑两轮评审，问题按
 * 「aspect 相同 && 时间点（四舍五入到 2s 粒度）相等」取交集标 confirmed: true；
 * 单轮独有问题降为 confirmed: false（观察项，不进修复清单）。
 * 动机：S2 同片两审 90 vs 7 的方差（采样波动 + 不可控项过判），交集显著降误修率。
 *
 * 用法：node e2e/deep-review.mjs <批次目录>
 * 产物：各用例 07-qa/deep-review.json（含 secondPass / confirmedCount / problems[].confirmed）
 *
 * 坑位（历史教训，勿回退）：
 * - step-3.7-flash 是推理模型：max_tokens 必须 ≥16000（reasoning 吃配额，给小了结论被截断）；
 * - 推理模型的结论可能落在 msg.reasoning 尾部：先取 content，空则从 reasoning 提取最后一个 JSON；
 * - 本文件曾用 bash heredoc 写入，`\r\n` 被写成真实控制字节——务必用 Write 工具整文件写入。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const API_URL = "https://api.stepfun.com/step_plan/v1/chat/completions";
const MODEL = "step-3.7-flash";
const MAX_TOKENS = 16000;
const TIME_BUCKET_SEC = 2; // 两轮评审允许的时间定位漂移（±2s 视为同处）

const KEY = JSON.parse(fs.readFileSync(".pi-studio/models.json", "utf-8")).vision.apiKey;
const batchDir = process.argv[2];
if (!batchDir) {
	console.error("用法：node e2e/deep-review.mjs <批次目录>");
	process.exit(1);
}

const runs = JSON.parse(fs.readFileSync(path.join(batchDir, "summary.json"), "utf-8")).results;

const requirements = `你是一名严格的成片审校。下面给你【设计预期 JSON】与【成片视频】。请逐项核对成片是否兑现设计，找出所有可观察到的问题：
1. 台词：人物说出的话是否与设计台词一致、是否清晰可懂（有无含糊吞字/胡言乱语/说着与字幕无关的内容）；
2. 字幕：字幕文本是否与所说台词/旁白对应，有无错别字、乱码，出现与消失时机是否自然；
3. 声音：旁白与对白是否清晰，有无突然的长时间死寂、重复声、异常噪声或嘶嘶声；
4. 口型：说话镜头里人物口型是否在动、大致与所说内容匹配；
5. 人物一致性：同一角色跨镜的性别/年龄/服装/发型是否一致，是否符合设计里的角色描述；
6. 物理与画面：肢体手指畸形、面部崩坏、物体形变穿模、与设定无关的画面内容；
7. 剪辑节奏：切换是否自然，有无大段无意义的静止或死寂，转场是否克制。
严重度规则：画面内精确元素（钟表指针/文字标题/二维码/品牌软广）是生成模型不可控项，一律标 low；score 按可控问题扣分。
每个问题给出出现的时间点（秒）与证据描述；没有问题的项也要说明"核对通过"。`;

/** 时间点归一化：提取首个秒数并四舍五入到 2s 粒度（"7.91s"/"SH03@8s" → 桶值） */
function timeBucket(at) {
	const m = /(\d+(?:\.\d+)?)\s*s?/.exec(String(at ?? ""));
	if (!m) return String(at ?? "");
	return String(Math.round(parseFloat(m[1]) / TIME_BUCKET_SEC) * TIME_BUCKET_SEC);
}

/** 交集键：aspect + 时间桶。两轮同键 = confirmed */
const keyOf = (p) => `${String(p.aspect ?? "?")}@${timeBucket(p.at)}`;

/** 宽容 JSON 解析：剥 ```json 围栏 + 截取首尾大括号（模型偶尔输出围栏或前后缀文本） */
function parseJsonLoose(raw) {
	let s = String(raw ?? "").trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
	if (fence) s = fence[1].trim();
	const start = s.indexOf("{");
	const end = s.lastIndexOf("}");
	if (start >= 0 && end > start) s = s.slice(start, end + 1);
	return JSON.parse(s);
}

/** 单轮评审：返回解析后的 {overall, score, problems[]} */
async function reviewOnce(finalPath, design, pass) {
	const user = [
		{ type: "video_url", video_url: { url: `data:video/mp4;base64,${fs.readFileSync(finalPath).toString("base64")}` } },
		{
			type: "text",
			text: `${requirements}\n\n（第 ${pass} 轮独立评审，与其他轮次无关联，请独立判断）\n\n【设计预期 JSON】\n${JSON.stringify(design, null, 1)}\n\n只输出 JSON: {"overall":"一句话总评","score":0,"problems":[{"aspect":"台词|字幕|声音|口型|人物|物理|剪辑","severity":"high|medium|low","at":"时间点/镜号","description":"…"}]}`,
		},
	];
	const res = await fetch(API_URL, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: user }], max_tokens: MAX_TOKENS }),
	});
	const body = await res.json();
	const msg = body.choices?.[0]?.message ?? {};
	let parsed = null;
	if (msg.content) {
		try {
			parsed = parseJsonLoose(msg.content);
		} catch {
			// content 不可解析时回落 reasoning
		}
	}
	if (!parsed && msg.reasoning) {
		// 推理模型可能把结论落在思考尾部：提取最后一个 JSON 对象
		const m = msg.reasoning.match(/\{[\s\S]*\}/);
		if (m) parsed = parseJsonLoose(m[0]);
	}
	if (!parsed) throw new Error(`模型无结论：${JSON.stringify(body).slice(0, 300)}`);
	return parsed;
}

/** 双轮交集：两轮同键 → confirmed: true；任一轮独有 → confirmed: false（观察项） */
function intersectReviews(a, b) {
	const bKeys = new Set((b ?? []).map(keyOf));
	const seen = new Set();
	const out = [];
	for (const p of a ?? []) {
		const k = keyOf(p);
		seen.add(k);
		out.push({ ...p, confirmed: bKeys.has(k) });
	}
	for (const p of b ?? []) {
		const k = keyOf(p);
		if (!seen.has(k)) out.push({ ...p, confirmed: false });
	}
	return out;
}

for (const r of runs) {
	const caseDir = path.join(batchDir, r.dir);
	const finalPath = path.join(caseDir, "06-export", "final.mp4");
	if (!fs.existsSync(finalPath)) continue;
	const script = JSON.parse(fs.readFileSync(path.join(caseDir, "01-script", "script.json"), "utf-8"));
	const brief = JSON.parse(fs.readFileSync(path.join(caseDir, "00-input", "brief.json"), "utf-8"));
	const vc = (() => {
		try {
			return JSON.parse(fs.readFileSync(path.join(caseDir, "05-audio", "voice-cast.json"), "utf-8"));
		} catch {
			return null;
		}
	})();

	const design = {
		logline: brief.logline,
		keyMessage: brief.keyMessage,
		shots: script.shots.map((s) => ({
			id: s.id,
			audioMode: s.audioMode,
			台词: s.dialogue?.lines?.zh ?? "",
			说话角色: s.dialogue?.characterId ?? "",
			旁白: s.narrationZh ?? "",
			画面设计: s.visual,
		})),
		音色分配: vc ? { 旁白: vc.narratorVoiceId, ...vc.characters } : undefined,
	};

	console.log(`\n===== ${r.id}（双轮独立评审） =====`);
	let pass1;
	let pass2;
	try {
		[pass1, pass2] = await Promise.all([reviewOnce(finalPath, design, 1), reviewOnce(finalPath, design, 2)]);
	} catch (error) {
		console.log(`双轮评审失败：${error.message}`);
		continue;
	}
	const problems = intersectReviews(pass1.problems, pass2.problems);
	const confirmedCount = problems.filter((p) => p.confirmed).length;
	const review = {
		overall: pass1.overall,
		score: pass1.score,
		secondPass: { overall: pass2.overall, score: pass2.score },
		confirmedCount,
		problems,
	};
	console.log(`总评 P1(${pass1.score}) P2(${pass2.score}) · confirmed ${confirmedCount}/${problems.length}`);
	for (const p of problems) {
		console.log(`  [${p.severity}${p.confirmed ? "·confirmed" : ""}] ${p.aspect} @${p.at}: ${p.description}`);
	}
	fs.writeFileSync(path.join(caseDir, "07-qa", "deep-review.json"), JSON.stringify(review, null, "\t"), "utf-8");
}

console.log("\n双轮深审完成");
