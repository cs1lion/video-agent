/**
 * 修复循环（一次性脚本，跑完即删）：对五套样片的审核发现逐镜修复。
 * 每项：派发动作（retts/reshot）→ 等 run 空闲 → 采新 verdict/跟读值。
 */
import { api } from "./lib/api.mjs";

const BASE = "http://127.0.0.1:8790";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(runId, label) {
	const deadline = Date.now() + 12 * 60 * 1000;
	let run = await api.getRun(BASE, runId);
	while (run.status === "running" && Date.now() < deadline) {
		await sleep(8000);
		run = await api.getRun(BASE, runId);
	}
	const followSpans = [];
	try {
		const traces = await api.traces(BASE, runId);
		for (const t of traces ?? []) if ((t.name ?? "").includes("跟读校验")) followSpans.push(`${t.name}: ${t.output}`);
	} catch {}
	console.log(`[${label}] 完成 status=${run.status} | 跟读: ${followSpans.slice(-2).join(" / ") || "无"} | 质检=${run.verdict ? `${run.verdict.score}(${run.verdict.overall})` : "-"}`);
	return run;
}

async function fix(label, runId, action) {
	try {
		console.log(`\n== ${label}`);
		if (action.type === "retts") {
			const r = await api.retts(BASE, runId, action.shotId, action.instruction ?? "", action.voice);
			if (!r.ok) return console.log(`  被拒: ${r.error}`);
		} else if (action.type === "reshot") {
			const r = await api.reshot(BASE, runId, action.shotId, action.instruction ?? "");
			if (!r.ok) return console.log(`  被拒: ${r.error}`);
		}
		await waitIdle(runId, label);
	} catch (error) {
		console.log(`  异常: ${error.message}`);
	}
}

const JOBS = [
	// 台词跟读修复（新阈值 0.7 + 失败重试 + 原始声参考）
	{ label: "F2-SH01 台词重做(0.68)", runId: "run-mtfip962-2", action: { type: "retts", shotId: "SH01", instruction: "语气更沉稳清晰，语速放慢" } },
	{ label: "F3-SH01 台词重做(0.37)", runId: "run-mtfjh3xx-3", action: { type: "retts", shotId: "SH01", instruction: "语气克制平静" } },
	{ label: "F3-SH02 台词重做(0.38)", runId: "run-mtfjh3xx-3", action: { type: "retts", shotId: "SH02", instruction: "语气宽厚温和" } },
	{ label: "F4-SH02 台词重做(0.55)", runId: "run-mtfjyamj-4", action: { type: "retts", shotId: "SH02", instruction: "语气低沉短促" } },
	{ label: "F5-SH02 台词恢复(已降级)", runId: "run-mtfke2et-5", action: { type: "retts", shotId: "SH02", instruction: "低声温柔而坚定" } },
	// F4 审核发现：字幕错别字（copy-edit 改文案）+ 人物跳变最差镜补拍
	{ label: "F4-SH04 字幕错字修正", runId: "run-mtfjyamj-4", action: { type: "retts", shotId: "SH04", instruction: "把旁白中的「放弃」改为「放过」，其余不变" } },
	{ label: "F4-SH02 人物跳变补拍", runId: "run-mtfjyamj-4", action: { type: "reshot", shotId: "SH02", instruction: "右侧角色是 48 岁老枪手 Wade：鬓角花白、深棕色皮背心配白衬衫、眼神锐利，与 SH01 同一人同一套服装，面容更苍老" } },
	// F2 补拍两个生成失败镜（补齐全片）
	{ label: "F2-SH04 失败镜补拍", runId: "run-mtfip962-2", action: { type: "reshot", shotId: "SH04", instruction: "保持书生沈砚之形象：32 岁男性，天青色直裰，束发小冠，眉目清瘦；雨夜灯笼摊前避雨对饮" } },
	{ label: "F2-SH05 失败镜补拍", runId: "run-mtfip962-2", action: { type: "reshot", shotId: "SH05", instruction: "保持更夫老周形象：58 岁男性，灰褐色短褐衣，腰挂铜锣与灯笼，花白胡须；雨夜里提灯走石板路" } },
];

for (const job of JOBS) await fix(job.label, job.runId, job.action);
console.log("\n修复循环完成");
