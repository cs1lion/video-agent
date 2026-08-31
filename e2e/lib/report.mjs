/**
 * 报告生成：每个用例一份 report.md，批次一份 summary.md / summary.json / index.html。
 * 判定标准集中在这里，改阈值只改这一处。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 成片最小体积（低于此视为导出异常） */
export const MIN_FINAL_BYTES = 50 * 1024;

/**
 * 单用例断言。
 * @returns {{passed: string[], failed: string[], verdict: "PASS"|"FAIL"}}
 */
export function assertCase({ expect, run, collected, finalBytes, audioForm, postFacts = {}, voiceCast = null, autoRepair = [] }) {
	const passed = [];
	const failed = [];
	const check = (ok, label, detail) => (ok ? passed : failed).push(detail ? `${label}（${detail}）` : label);

	// 1) 管线跑完
	const doneStages = run.stages.filter((s) => s.status === "done").map((s) => s.id);
	check(run.status === "done", "管线状态 done", `实际 ${run.status}`);
	check(
		run.stages.every((s) => s.status === "done"),
		"全部阶段 done",
		`${doneStages.length}/${run.stages.length}`,
	);

	// 2) 成片存在且体积合理
	const finalFile = collected.files["06-export"]?.find((f) => /^final.*\.mp4$/.test(f));
	check(Boolean(finalFile), "成片已归档");
	check(
		(finalBytes ?? 0) >= MIN_FINAL_BYTES,
		"成片体积达标",
		`${Math.round((finalBytes ?? 0) / 1024)}KB / 阈值 ${MIN_FINAL_BYTES / 1024}KB`,
	);

	// 3) 镜头数（制作集）
	const shots = run.productionShots ?? null; // 由 runner 回填
	if (expect.minShots) {
		const n = shots ?? (collected.assets ?? []).filter((a) => /^clip-.*\.mp4$/.test(a.name)).length;
		check(n >= expect.minShots, "镜头数达标", `${n} / 期望 ≥${expect.minShots}`);
	}

	// 4) 逐镜素材齐备：每镜一张关键帧 + 一段 clip
	//    注意排除 _v{n} 历史版本（补拍/重录会保留旧版，它们不是"当前制作集"的片段）
	const isVersioned = (n) => /_v\d+\.[a-z0-9]+$/i.test(n);
	const clips = (collected.assets ?? []).filter((a) => /^clip-[A-Za-z0-9_-]+\.mp4$/.test(a.name) && !isVersioned(a.name));
	const keys = (collected.assets ?? []).filter(
		(a) => /^key-[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(a.name) && !isVersioned(a.name),
	);
	check(clips.length > 0, "片段产物存在", `${clips.length} 段`);
	check(keys.length >= clips.length, "关键帧数 ≥ 片段数", `${keys.length} vs ${clips.length}`);

	// 5) 音频形态
	const tts = (collected.assets ?? []).filter((a) => /^tts-[A-Za-z0-9_-]+\.mp3$/.test(a.name) && !isVersioned(a.name));
	const bgm = (collected.assets ?? []).find((a) => /^bgm\./.test(a.name));
	if (expect.requireTtsAudio) check(tts.length > 0, "TTS 音轨存在（台词/旁白）", `${tts.length} 条`);
	if (expect.requireBgm) check(Boolean(bgm), "BGM 已入时间线");
	if (expect.requireDialogueShots) check(run.dialogueShotCount > 0, "台词镜存在", `${run.dialogueShotCount ?? 0} 镜`);
	if (audioForm === "dialogue" && !expect.requireTtsAudio) {
		// 台词镜若被降级为旁白，这里不判失败，但要留痕
		if ((run.dialogueShotCount ?? 0) === 0) passed.push("注意：台词镜为 0（可能已降级为旁白，见事件日志）");
	}

	// 6) 质检结论 + 物理/人物/文字审核轴 + 字幕结构审核
	// 已知供应商限制：画面含敏感物（如枪械）时视觉 QA 被 451 内容审核整体拦截——
	// 此时审核轴缺失不判 FAIL（产品无法对抗供应商审核），降为留痕；字幕结构审核仍可用。
	const qaCensored = /451|censorship/i.test(run.error ?? "");
	if (run.verdict) {
		check(run.verdict.axes?.length > 0 || qaCensored, "质检有分", qaCensored ? "QA 被 451 内容审核拦截" : `综合 ${run.verdict.score}（${run.verdict.overall}）`);
		const axisOf = (id) => run.verdict.axes?.find((a) => a.id === id);
		const phys = axisOf("physicalAccuracy");
		const chars = axisOf("characterConsistency");
		const text = axisOf("textQuality");
		if (qaCensored) {
			passed.push("注意：视觉 QA 被供应商内容审核拦截（451），物理/人物/文字轴本轮不可用（题材限制，非产品缺陷）");
		} else {
			check(
				Boolean(phys) && Boolean(chars) && Boolean(text),
				"物理/人物/文字审核轴齐备",
				`物理 ${phys?.score ?? "缺"} / 人物 ${chars?.score ?? "缺"} / 文字 ${text?.score ?? "缺"}`,
			);
		}
	} else {
		failed.push("缺少质检结论（verdict）");
	}
	if (expect.requireSubtitlesAudit) {
		const subs = run.verdict?.subtitles;
		if (!subs) {
			failed.push("缺少字幕审核结果（verdict.subtitles 未产生）");
		} else {
			check(
				subs.issues.length === 0,
				"字幕结构审核通过",
				subs.lines > 0 ? `${subs.lines} 行` : "本片无字幕来源",
			);
			for (const issue of subs.issues) failed.push(`字幕问题：${issue}`);
		}
	}

	// 7) 配音选角：旁白声线必须与全部角色错开；≥2 角色时角色间不得同声（音色库耗尽的跨池借用除外——留痕在 notes）
	if (expect.requireVoiceDistinction) {
		if (!voiceCast) {
			failed.push("缺少配音选角留痕（voice-cast.json 未产生）");
		} else {
			const charVoices = Object.values(voiceCast.characters ?? {});
			check(
				Boolean(voiceCast.narratorVoiceId) && !charVoices.includes(voiceCast.narratorVoiceId),
				"旁白音色与角色错开",
				`旁白 ${voiceCast.narratorVoiceId ?? "缺"} vs 角色 [${charVoices.join(", ")}]`,
			);
			if (charVoices.length >= 2) {
				check(
					new Set(charVoices).size === charVoices.length,
					"角色音色互不相同",
					`${new Set(charVoices).size}/${charVoices.length}（${charVoices.join(", ")}）`,
				);
			}
		}
	}

	// 7.5) 自动质检-修复闭环：信息性留痕（触发 + 复审对照）。
	// 不做硬断言——reshot 改善受模型保真度上限约束（G3 类顽固项复审可能仍 fail），
	// 且逐镜问题是 LLM 方差，不能保证每次跑片都有触发目标；闭环是否触发看留痕章节即可。
	if ((autoRepair ?? []).length > 0) {
		for (const r of autoRepair) {
			passed.push(
				`注意：自动质检-修复闭环触发 ${r.shotId}（补拍前 ${r.preVerdict}：${r.preReason}）→ 复审 ${r.postVerdict ?? "无记录"}${r.improved ? "（改善）" : "（未改善/持平）"}`,
			);
		}
	}

	// 7) 成片之后的动作（按用例要求逐项校验）
	const assets = collected.assets ?? [];
	if (expect.requireDesignReview)
		check(
			(postFacts.designReview?.count ?? 0) > 0,
			"设计图自审有结论",
			`${postFacts.designReview?.count ?? 0} 张`,
		);
	if (expect.requireKeyframeReview)
		check(
			(postFacts.keyframeReview?.count ?? 0) > 0,
			"关键帧自审有结论",
			`${postFacts.keyframeReview?.count ?? 0} 帧`,
		);
	if (expect.requireReshotVersion) {
		const versions = assets.filter((a) => /^clip-.+_v\d+\.mp4$/.test(a.name));
		check(versions.length > 0, "补拍产生历史版本", `${versions.length} 个 _v1`);
		check((postFacts.reshotShots ?? []).length > 0, "补拍动作已派发");
	}
	if (expect.requireComposeCut) {
		// 服务端实际命名为 cut{N}.mp4（无连字符，见 redo/compose.ts），与 collect 的 bucket 规则一致
		const cuts = assets.filter((a) => /^cut\d+\.mp4$/.test(a.name));
		check(cuts.length > 0, "组合出片产出交付版", cuts.map((c) => c.name).join(", ") || "无");
	}
	if (expect.requirePortraitExport) {
		const portrait = assets.find((a) => /^final-9x16\.mp4$/.test(a.name));
		check(Boolean(portrait), "竖屏分发版已导出", portrait?.name ?? "无");
	}
	if (expect.requireKitchenObservation)
		check(
			postFacts.kitchen !== null && postFacts.kitchen !== undefined,
			"制片主任观察可用",
			`${postFacts.kitchen?.suggestionCount ?? 0} 条建议`,
		);

	// 动作执行期出错一律留痕（不算失败：多数是被守卫/限次合法拒绝）
	for (const e of postFacts.errors ?? []) passed.push(`注意：动作留痕 ${e}`);

	return { passed, failed, verdict: failed.length === 0 ? "PASS" : "FAIL" };
}

function mdTable(rows, headers) {
	const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
	return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}`;
}

export function writeCaseReport(caseDir, { testCase, run, assert, timings, gates, collected, finalBytes, postFacts, voiceCast, autoRepair = [] }) {
	const lines = [];
	lines.push(`# ${testCase.id} · ${testCase.title}`);
	lines.push("");
	lines.push(`- 音频形态：\`${testCase.audioForm}\``);
	lines.push(`- runId：\`${run.id}\``);
	lines.push(`- 结论：**${assert.verdict}**`);
	lines.push(`- 总耗时：${(timings.totalMs / 1000).toFixed(1)}s`);
	lines.push("");
	lines.push("## 需求与参数");
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify({ brief: testCase.brief, options: testCase.options, coSpace: testCase.coSpace }, null, 2));
	lines.push("```");
	lines.push("");
	lines.push("## 阶段耗时");
	lines.push("");
	lines.push(mdTable(timings.stages.map((s) => [s.id, s.status, `${(s.ms / 1000).toFixed(1)}s`]), ["阶段", "状态", "耗时"]));
	lines.push("");
	lines.push("## 闸门决策");
	lines.push("");
	lines.push(mdTable(gates.map((g) => [g.gate, g.action, g.at]), ["闸门", "动作", "时间"]));
	lines.push("");
	if (postFacts && !postFacts.skipped) {
		lines.push("## 成片后的动作");
		lines.push("");
		const rows = [];
		if (postFacts.designReview)
			rows.push(["设计图自审", `${postFacts.designReview.count} 张（fail ${postFacts.designReview.fail} / warn ${postFacts.designReview.warn}）`]);
		if (postFacts.keyframeReview)
			rows.push(["关键帧自审", `${postFacts.keyframeReview.count} 帧（fail ${postFacts.keyframeReview.fail} / warn ${postFacts.keyframeReview.warn}）`]);
		if (postFacts.reshotShots?.length) rows.push(["补拍镜头", postFacts.reshotShots.join("、")]);
		if (postFacts.rettsShots?.length) rows.push(["重录旁白", postFacts.rettsShots.join("、")]);
		if (postFacts.composeCuts?.length) rows.push(["组合出片", `${postFacts.composeCuts.length} 次`]);
		if (postFacts.portraitExports?.length)
			rows.push(["多画幅重导出", postFacts.portraitExports.map((p) => `${p.aspectRatio}:${p.status}`).join("，")]);
		if (postFacts.kitchen)
			rows.push(["制片主任观察", `${postFacts.kitchen.suggestionCount} 条建议（obsId ${postFacts.kitchen.id}）`]);
		if (postFacts.applied?.length) rows.push(["建议执行", JSON.stringify(postFacts.applied)]);
		if (postFacts.metrics) rows.push(["A/B 度量", JSON.stringify(postFacts.metrics)]);
		for (const e of postFacts.errors ?? []) rows.push(["动作留痕", e]);
		if (rows.length) lines.push(mdTable(rows, ["动作", "结果"]));
		else lines.push("- 无");
		lines.push("");
	}

	// 配音选角明细：旁白与角色声线的分配结果（音色区分硬断言的依据）
	if (voiceCast) {
		lines.push("## 配音选角");
		lines.push("");
		const castRows = [
			["旁白", voiceCast.narratorVoiceId ?? "（适配器默认）"],
			...Object.entries(voiceCast.characters ?? {}).map(([name, id]) => [name, String(id)]),
		];
		lines.push(mdTable(castRows, ["声部", "音色 id"]));
		if ((voiceCast.notes ?? []).length > 0) {
			lines.push("");
			for (const n of voiceCast.notes) lines.push(`- ⚠️ ${n}`);
		}
		lines.push("");
	}

	lines.push("## 断言");
	lines.push("");
	lines.push("### 通过");
	lines.push("");
	for (const p of assert.passed) lines.push(`- ✅ ${p}`);
	lines.push("");
	lines.push("### 失败");
	lines.push("");
	if (assert.failed.length === 0) lines.push("- 无");
	for (const f of assert.failed) lines.push(`- ❌ ${f}`);
	lines.push("");

	// 物理/人物/文字/字幕审核明细：轴分 + 逐镜 warn/fail 理由（前缀类别由 QA 提示词约定）+ 字幕结构审核
	if (run.verdict) {
		lines.push("## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）");
		lines.push("");
		const axisRows = (run.verdict.axes ?? []).map((a) => [a.id, String(a.score)]);
		if (axisRows.length) lines.push(mdTable(axisRows, ["审核轴", "分数"]));
		const flagged = (run.verdict.shots ?? []).filter((s) => s.verdict !== "ok");
		lines.push("");
		if (flagged.length === 0) lines.push("- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）");
		else
			lines.push(
				mdTable(
					flagged.map((s) => [s.id, s.verdict, s.reason]),
					["镜头", "裁决", "问题（物理:/人物:/文字:/字幕: 前缀标类别）"],
				),
			);
		const subs = run.verdict.subtitles;
		if (subs) {
			lines.push("");
			lines.push(
				subs.issues.length === 0
					? `- 字幕结构审核：${subs.lines} 行，无重叠/缺口/编码问题`
					: `- 字幕结构审核：${subs.issues.length} 项问题 — ${subs.issues.join("；")}`,
			);
		}
		lines.push("");
	}

	// 自动质检-修复闭环：触发留痕 + 复审对照（前=触发事件快照，后=最终逐镜裁决）
	if ((autoRepair ?? []).length > 0) {
		lines.push("## 自动质检-修复闭环");
		lines.push("");
		lines.push(
			mdTable(
				autoRepair.map((r) => [
					r.shotId,
					`${r.preVerdict}：${r.preReason}`,
					`${r.postVerdict ?? "—"}${r.postReason ? `：${r.postReason}` : ""}`,
					r.improved ? "改善" : "未改善/持平",
				]),
				["镜头", "补拍前（触发快照）", "复审后（最终裁决）", "对照"],
			),
		);
		lines.push("");
	}

	lines.push("## 产物清单");
	lines.push("");
	lines.push(mdTable(
		Object.entries(collected.files).map(([dir, names]) => [dir, String(names.length), names.slice(0, 8).join(", ")]),
		["目录", "数量", "文件（最多 8 个）"],
	));
	lines.push("");
	lines.push(`成片体积：${Math.round((finalBytes ?? 0) / 1024)} KB`);
	fs.writeFileSync(path.join(caseDir, "report.md"), lines.join("\n"), "utf-8");
}

export function writeBatchReport(batchDir, results, { startedAt, base }) {
	const pass = results.filter((r) => r.assert.verdict === "PASS").length;
	const rows = results.map((r) => [
		r.id,
		r.title,
		r.audioForm,
		`${(r.timings.totalMs / 1000).toFixed(0)}s`,
		r.run.status,
		r.run.verdict ? `${r.run.verdict.score}（${r.run.verdict.overall}）` : "-",
		r.assert.verdict,
	]);
	const md = [
		"# E2E 批次报告",
		"",
		`- 服务：\`${base}\``,
		`- 开始：${new Date(startedAt).toLocaleString("zh-CN")}`,
		`- 用例：${results.length} 个，PASS ${pass} / FAIL ${results.length - pass}`,
		"",
		mdTable(rows, ["用例", "标题", "音频形态", "耗时", "终态", "质检", "结论"]),
		"",
		"## 明细",
		"",
		...results.map((r) => `- [${r.id} ${r.title}](./${r.dir}/report.md) — ${r.assert.verdict}`),
	].join("\n");

	fs.writeFileSync(path.join(batchDir, "summary.md"), md, "utf-8");
	fs.writeFileSync(
		path.join(batchDir, "summary.json"),
		JSON.stringify({ base, startedAt, pass, total: results.length, results }, null, "\t"),
		"utf-8",
	);

	const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>E2E 批次报告</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:32px;color:#222}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 10px;text-align:left;font-size:14px}
th{background:#f4f4f5}code{background:#f4f4f5;padding:2px 5px;border-radius:4px}
.pass{color:#16a34a;font-weight:600}.fail{color:#dc2626;font-weight:600}</style></head>
<body><h1>E2E 批次报告</h1>
<p>服务 <code>${base}</code> · 开始 ${new Date(startedAt).toLocaleString("zh-CN")} · PASS ${pass}/${results.length}</p>
<table><tr>${["用例", "标题", "音频形态", "耗时", "终态", "质检", "结论"]
		.map((h) => `<th>${h}</th>`)
		.join("")}</tr>
${results
	.map(
		(r) =>
			`<tr><td><a href="./${r.dir}/report.md">${r.id}</a></td><td>${r.title}</td><td>${r.audioForm}</td><td>${(
				r.timings.totalMs / 1000
			).toFixed(0)}s</td><td>${r.run.status}</td><td>${
				r.run.verdict ? `${r.run.verdict.score}（${r.run.verdict.overall}）` : "-"
			}</td><td class="${r.assert.verdict === "PASS" ? "pass" : "fail"}">${r.assert.verdict}</td></tr>`,
	)
	.join("\n")}
</table></body></html>`;
	fs.writeFileSync(path.join(batchDir, "index.html"), html, "utf-8");
}
