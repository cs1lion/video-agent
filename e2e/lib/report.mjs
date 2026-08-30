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
export function assertCase({ expect, run, collected, finalBytes, audioForm, postFacts = {} }) {
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
	if (expect.requireNarrationAudio) check(tts.length > 0, "旁白音轨存在", `${tts.length} 条`);
	if (expect.requireBgm) check(Boolean(bgm), "BGM 已入时间线");
	if (expect.requireDialogueShots) check(run.dialogueShotCount > 0, "台词镜存在", `${run.dialogueShotCount ?? 0} 镜`);
	if (audioForm === "dialogue" && !expect.requireNarrationAudio) {
		// 台词镜若被降级为旁白，这里不判失败，但要留痕
		if ((run.dialogueShotCount ?? 0) === 0) passed.push("注意：台词镜为 0（可能已降级为旁白，见事件日志）");
	}

	// 6) 质检结论
	if (run.verdict) {
		check(run.verdict.axes?.length > 0, "五轴质检有分", `综合 ${run.verdict.score}（${run.verdict.overall}）`);
	} else {
		failed.push("缺少质检结论（verdict）");
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

export function writeCaseReport(caseDir, { testCase, run, assert, timings, gates, collected, finalBytes, postFacts }) {
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
