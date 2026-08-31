/**
 * runQa —— 视觉质检 + 物理/文字/人物一致性审核 + 字幕结构审核。
 *
 * 每镜**两帧**（中段 + 后段，按实际时间轴）抽帧 → 视觉模型打 5 个视觉维度分 + 逐镜三态标注；
 * 后段帧专治"瞬时缺陷"：多指/肢体畸形、物体形变、乱码字形常只在中段帧之外出现，单帧抽检会漏。
 * audioSync 由调用方按「全语音镜语音就绪率」确定性算好传入（2026-08-31 口径修正：
 * 旧口径数旁白 TTS 成功率，台词镜对白走 dialogue-audio 链路恒为 null → G1 0/5=0 假象）；
 * 字幕另有一层**确定性结构审核**（qa/subtitles.ts，
 * 时间轴重叠/覆盖率/编码错乱是视觉模型看不准的）。质检失败不拖垮成片：给保守 warn 结论并记录。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { type ScriptDoc } from "../prompts.ts";
import {
	appendSpan,
	asQaShotCategory,
	throwIfAborted,
	type AxisId,
	type QaShotVerdict,
	type QaVerdict,
	type StageCtx,
} from "../pipeline.ts";
import { extractFrame } from "../ffmpeg.ts";
import { chatVisionJson } from "../llm.ts";
import { trackLlmCost } from "../pricing.ts";
import { auditSubtitles, type SubtitleAudit } from "./subtitles.ts";
import { type GenerationOptions } from "../../../video-agent/src/index.ts";

/** 视觉模型返回的原始维度分（宽容解析前） */
export interface QaVisionScores {
	briefFit?: unknown;
	visualConsistency?: unknown;
	pacing?: unknown;
	physicalAccuracy?: unknown;
	characterConsistency?: unknown;
	textQuality?: unknown;
}

/** runQa 的字幕审核输入（export 阶段写完 subs.ass 后传入） */
export interface QaSubtitleInput {
	/** subs.ass 全文 */
	assText: string;
	/** 期望字幕行数 = 有旁白文本的制作集镜头数（0 = 本片无字幕来源） */
	expectedLines: number;
}

/**
 * 纯函数：把视觉模型返回的维度分折叠成七轴（顺序即 UI 展示顺序）。
 * 非法值（NaN/负数/超界/缺字段）按 0 分保守处理——宁可低分暴露问题也不虚高。
 * audioSync 由调用方按「全语音镜语音就绪率」确定性算好后传入（口径见 export.ts 调用点）。
 */
export function foldQaAxes(
	vision: QaVisionScores,
	audioSync: number,
): { id: AxisId; score: number }[] {
	const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
	return [
		{ id: "briefFit", score: clamp(vision.briefFit) },
		{ id: "visualConsistency", score: clamp(vision.visualConsistency) },
		{ id: "pacing", score: clamp(vision.pacing) },
		{ id: "physicalAccuracy", score: clamp(vision.physicalAccuracy) },
		{ id: "characterConsistency", score: clamp(vision.characterConsistency) },
		{ id: "audioSync", score: Math.max(0, Math.min(100, Math.round(audioSync))) },
		{ id: "textQuality", score: clamp(vision.textQuality) },
	];
}

/** 视觉质检：每镜两帧（中段+后段） → 模型打分 + 逐镜三态标注；audioSync 由调用方确定性传入 */
export async function runQa(
	sc: StageCtx,
	keptShots: ScriptDoc["shots"],
	opts: GenerationOptions,
	finalPath: string,
	audioSync: number,
	midpoints: number[],
	lateTimes: number[] = [],
	subtitleInput?: QaSubtitleInput,
): Promise<QaVerdict> {
	const { run, ctx, signal } = sc;
	// 字幕结构审核（确定性层）：与视觉审核并行不悖——重叠/覆盖率/编码错乱它看帧看不准
	let subtitleAudit: SubtitleAudit | undefined;
	if (subtitleInput) {
		subtitleAudit = auditSubtitles(subtitleInput.assText, subtitleInput.expectedLines, opts.promptLanguage);
	}
	const frames: string[] = [];
	const t0 = Date.now();
	try {
		for (const [i, shot] of keptShots.entries()) {
			throwIfAborted(signal);
			const atSec = midpoints[i] ?? i * opts.clipDurationSec + opts.clipDurationSec / 2;
			// 后段帧缺省回落：call 方未提供时用镜长 85% 处（与中点至少拉开 1/3 镜长）
			const lateSec = lateTimes[i] ?? atSec + opts.clipDurationSec * 0.35;
			const midPath = path.join("assets", `qa-${shot.id}.jpg`);
			const latePath = path.join("assets", `qa-${shot.id}-late.jpg`);
			await extractFrame({ cwd: run.dir, videoPath: finalPath, atSec, outPath: midPath, signal });
			frames.push(await fs.promises.readFile(path.join(run.dir, midPath)).then((b) => b.toString("base64")));
			await extractFrame({ cwd: run.dir, videoPath: finalPath, atSec: lateSec, outPath: latePath, signal });
			frames.push(await fs.promises.readFile(path.join(run.dir, latePath)).then((b) => b.toString("base64")));
		}
		throwIfAborted(signal);
		const shotList = keptShots.map((s) => s.id).join("、");
		// 提取为变量：计费必须按真实 prompt 长度 + 帧数（此前传字面量 "qa-visual" 9 字符，
		// 多模态输入成本≈0，视觉调用被系统性低估）
		const subtitleRule =
			subtitleInput && subtitleInput.expectedLines > 0
				? `画面底部居中的白字黑边条是成片自带的烧录字幕（本片应有 ${subtitleInput.expectedLines} 条）——**它不算画面文字问题**；但要审核字幕本身：乱码字符/错别字/被截断/重叠遮挡（问题写进对应镜头的 reason，「字幕:」前缀）。`
				: "本片没有烧录字幕——若画面底部出现成排白字黑边条（疑似字幕渲染残留），按「字幕:」前缀记录。";
		const qaPrompt = [
			"这是同一条短片的分镜抽帧（按顺序），每镜两帧：先中段帧、再后段帧。剧情需求：",
			run.brief.creative.logline,
			run.brief.creative.keyMessage ? `关键信息: ${run.brief.creative.keyMessage}` : "",
			`镜头编号依次为：${shotList}（即 ${keptShots[0]?.id ?? "SH01"} 两帧、${keptShots[1]?.id ?? "SH02"} 两帧……）。`,
			"",
			"请基于帧内容打分（0-100 整数）：",
			"briefFit: 画面内容与剧情需求的贴合度；",
			"visualConsistency: 各帧风格/色调/光线的一致性；",
			"pacing: 镜头推进的节奏感（开场-展开-收尾是否有层次）；",
			"physicalAccuracy: 物理正确性——重点排查肢体与手指畸形（多指/断肢/关节反折）、面部崩坏、",
			"物体形变/穿模/凭空出现消失、重力与透视失衡（完全正常=100，发现即大幅扣分）；",
			"characterConsistency: 人物一致性——同一个角色跨镜比对脸型/发型发色/服装/年龄段/体型是否保持，",
			"多角色同框时是否互相串脸或与设定描述错位（完全一致=100，每次明显跳变大幅扣分）；",
			"textQuality: 画面内文字质量——招牌/UI/水印上的乱码文字、伪中文、变形字形（完全干净=100）。",
			subtitleRule,
			"",
			"同时逐镜标注：verdict 取 ok（可用）/ warn（勉强）/ fail（明显不合格），reason 用一句话说明",
			"（ok 可写「通过」；warn/fail 点名具体问题并加前缀：「物理:」「人物:」「文字:」「字幕:」）。",
			"category 为问题类别，取「人物/物理/文字/字幕/其他」之一：warn/fail 必填且与 reason 前缀保持一致，ok 一律「其他」。",
			"",
			`只输出 JSON: {"briefFit": 0, "visualConsistency": 0, "pacing": 0, "physicalAccuracy": 0, "characterConsistency": 0, "textQuality": 0, "shots": [{"id": "${keptShots[0]?.id ?? "SH01"}", "verdict": "ok", "category": "其他", "reason": "…"}]}`,
		]
			.filter(Boolean)
			.join("\n");
		// 451 内容审核会确定性拦下含剧情文本的 prompt（复现于个别题材）——
		// 降级为「纯技术审核」重试一次：剥离全部剧情文本，只审画面四类缺陷与评分。
		const technicalFallback = (error: unknown): boolean =>
			error instanceof Error && /451|censorship/i.test(error.message);
		let vision: Awaited<ReturnType<typeof chatVisionJson<QaVisionScores & { shots?: { id?: string; verdict?: string; category?: string; reason?: string }[] }>>>;
		try {
			vision = await chatVisionJson(ctx.llm, qaPrompt, frames, signal);
		} catch (error) {
			if (signal?.aborted || !technicalFallback(error)) throw error;
			appendSpan(
				run,
				{
					stage: "export",
					name: "审片质检（剧情文本被审核拦截）",
					kind: "qa",
					status: "ok",
					output: "451 → 降级纯技术审核（不含剧情文本）",
				},
				Date.now(),
			);
			vision = await chatVisionJson(
				ctx.llm,
				[
					"这是同一部影视短片的分镜抽帧（按顺序），每镜两帧。只做画面技术审核，不要猜测剧情：",
					`镜头编号依次为：${shotList}。`,
					"打分（0-100 整数）：briefFit（画面专业完成度）/ visualConsistency（风格色调一致性）/ pacing（节奏层次）/",
					"physicalAccuracy（肢体手指畸形/面部崩坏/物体形变穿模/重力透视）/ characterConsistency（同一人物跨镜脸型发型服装一致）/",
					"textQuality（画面内乱码文字/伪中文/变形字形/水印）。底部烧录字幕不算画面文字，但审其乱码/错字/截断。",
					"逐镜标注 verdict（ok/warn/fail）、category（人物/物理/文字/字幕/其他，ok 用「其他」）与一句 reason（前缀「物理:」「人物:」「文字:」「字幕:」，须与 category 一致）。",
					`只输出 JSON: {"briefFit": 0, "visualConsistency": 0, "pacing": 0, "physicalAccuracy": 0, "characterConsistency": 0, "textQuality": 0, "shots": [{"id": "${keptShots[0]?.id ?? "SH01"}", "verdict": "ok", "category": "其他", "reason": "…"}]}`,
				].filter(Boolean).join("\n"),
				frames,
				signal,
			);
		}
		run.metrics.llmCalls += 1;
		trackLlmCost(run, ctx, qaPrompt, JSON.stringify(vision), frames.length);
		// audioSync 由调用方按「全语音镜语音就绪率」确定性算好传入（export.ts）
		const axes = foldQaAxes(vision, audioSync);
		const score = Math.round(axes.reduce((sum, a) => sum + a.score, 0) / axes.length);

		// 逐镜标注（宽容解析：字段缺失/未知 id 都容忍；category 缺失时从 reason 前缀回落——
		// 旧产物/模型可能不带字段，前缀仍是有效信号）
		const rawShots = Array.isArray(vision.shots) ? vision.shots : [];
		const byId = new Map(rawShots.map((s) => [String(s?.id ?? ""), s]));
		const shots: QaShotVerdict[] = keptShots.map((shot) => {
			const s = byId.get(shot.id);
			const v = s?.verdict === "ok" || s?.verdict === "warn" || s?.verdict === "fail" ? s.verdict : "ok";
			const reason = String(s?.reason ?? "").slice(0, 120) || "通过";
			const category = asQaShotCategory(s?.category) ?? (/^(人物|物理|文字|字幕):/.test(reason) ? (reason.slice(0, 2) as QaShotVerdict["category"]) : v === "ok" ? "其他" : undefined);
			return { id: shot.id, verdict: v, reason, ...(category ? { category } : {}) };
		});
		// 字幕结构性缺陷合入逐镜标注尾部（不带镜头定位的结构问题挂到标注首镜，不静默）
		if (subtitleAudit && subtitleAudit.issues.length > 0 && shots.length > 0) {
			const first = shots[0]!;
			if (first.verdict === "ok") first.verdict = "warn";
			first.reason = `字幕审核: ${subtitleAudit.issues[0]}${first.reason && first.reason !== "通过" ? `；${first.reason}` : ""}`.slice(0, 120);
			first.category = "字幕";
		}

		// 三态多数决：LLM 的 0-100 分数是伪精确（同帧复评浮动 ±10 常见），分数只保留展示用途；
		// gate 决策以逐镜 verdict 为准——任一 fail 即 fail，warn 过半才 warn，否则 pass。
		const failCount = shots.filter((s) => s.verdict === "fail").length;
		const warnCount = shots.filter((s) => s.verdict === "warn").length;
		const overall = failCount > 0 ? "fail" : warnCount > shots.length - warnCount - failCount ? "warn" : "pass";
		appendSpan(
			run,
			{
				stage: "export",
				name: "审片质检（七轴 + 逐镜标注 + 物理/人物/文字/字幕审核）",
				kind: "qa",
				status: failCount > 0 || overall === "fail" ? "semantic-fail" : "ok",
				input: `${keptShots.length} 镜 × 2 帧抽检${subtitleAudit ? ` · 字幕 ${subtitleAudit.lines} 行` : ""}`,
				output: `综合 ${score}（${overall}）；逐镜 ${shots.filter((s) => s.verdict === "ok").length} ok / ${warnCount} warn / ${failCount} fail；人物 ${axes.find((a) => a.id === "characterConsistency")?.score ?? "-"} / 物理 ${axes.find((a) => a.id === "physicalAccuracy")?.score ?? "-"} / 文字 ${axes.find((a) => a.id === "textQuality")?.score ?? "-"}${subtitleAudit ? ` / 字幕问题 ${subtitleAudit.issues.length}` : ""}`,
			},
			t0,
		);
		return {
			overall,
			score,
			axes,
			shots,
			...(subtitleAudit ? { subtitles: subtitleAudit } : {}),
		};
	} catch (error) {
		if (signal.aborted) throw error;
		appendSpan(
			run,
			{
				stage: "export",
				name: "审片质检",
				kind: "qa",
				status: "error",
				output: error instanceof Error ? error.message : String(error),
			},
			t0,
		);
		// 质检失败不拖垮成片：给保守 warn 结论并记录（字幕结构审核结果仍如实带出）
		run.error = `质检阶段跳过: ${error instanceof Error ? error.message : String(error)}`;
		return {
			overall: "warn",
			score: 0,
			axes: [],
			...(subtitleAudit ? { subtitles: subtitleAudit } : {}),
		};
	}
}
