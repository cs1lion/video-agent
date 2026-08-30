/**
 * runQa —— 视觉质检 + 物理错误/文字乱码审核。
 *
 * 每镜**两帧**（中段 + 后段，按实际时间轴）抽帧 → 视觉模型打 5 个视觉维度分 + 逐镜三态标注；
 * 后段帧专治"瞬时缺陷"：多指/肢体畸形、物体形变、乱码字形常只在中段帧之外出现，单帧抽检会漏。
 * audioSync 由 TTS 成功率确定性算。质检失败不拖垮成片：给保守 warn 结论并记录。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { type ScriptDoc } from "../prompts.ts";
import {
	appendSpan,
	throwIfAborted,
	type AxisId,
	type QaShotVerdict,
	type QaVerdict,
	type StageCtx,
} from "../pipeline.ts";
import { extractFrame } from "../ffmpeg.ts";
import { chatVisionJson } from "../llm.ts";
import { trackLlmCost } from "../pricing.ts";
import { type GenerationOptions } from "../../../video-agent/src/index.ts";

/** 视觉模型返回的原始维度分（宽容解析前） */
export interface QaVisionScores {
	briefFit?: unknown;
	visualConsistency?: unknown;
	pacing?: unknown;
	physicalAccuracy?: unknown;
	textQuality?: unknown;
}

/**
 * 纯函数：把视觉模型返回的维度分折叠成六轴（顺序即 UI 展示顺序）。
 * 非法值（NaN/负数/超界/缺字段）按 0 分保守处理——宁可低分暴露问题也不虚高。
 * audioSync 由调用方按 TTS 成功率确定性算好后传入。
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
		{ id: "audioSync", score: Math.max(0, Math.min(100, Math.round(audioSync))) },
		{ id: "textQuality", score: clamp(vision.textQuality) },
	];
}

/** 视觉质检：每镜两帧（中段+后段） → 模型打分 + 逐镜三态标注；audioSync 由 TTS 成功率算 */
export async function runQa(
	sc: StageCtx,
	keptShots: ScriptDoc["shots"],
	opts: GenerationOptions,
	finalPath: string,
	audioFiles: (string | null)[],
	midpoints: number[],
	lateTimes: number[] = [],
): Promise<QaVerdict> {
	const { run, ctx, signal } = sc;
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
			"physicalAccuracy: 物理正确性——重点排查肢体与手指畸形（多指/断肢/关节反折）、面部崩坏或五官漂移、",
			"物体形变/穿模/凭空出现消失、重力与透视失衡、人与物的接触关系不成立（完全正常=100，发现即大幅扣分）；",
			"textQuality: 画面中是否出现乱码文字/伪中文/变形字形/水印/logo（完全干净=100，出现即大幅扣分）。",
			"",
			"同时逐镜标注：verdict 取 ok（可用）/ warn（勉强）/ fail（明显不合格，如多指等肢体畸形、物体形变、",
			"乱码文字、画面崩坏、与需求严重不符），reason 用一句话说明（ok 可写「通过」；warn/fail 请点名具体问题，",
			"物理问题写「物理:」前缀、文字问题写「文字:」前缀）。",
			"",
			`只输出 JSON: {"briefFit": 0, "visualConsistency": 0, "pacing": 0, "physicalAccuracy": 0, "textQuality": 0, "shots": [{"id": "${keptShots[0]?.id ?? "SH01"}", "verdict": "ok", "reason": "…"}]}`,
		]
			.filter(Boolean)
			.join("\n");
		const vision = await chatVisionJson<QaVisionScores & { shots?: { id?: string; verdict?: string; reason?: string }[] }>(
			ctx.llm,
			qaPrompt,
			frames,
			signal,
		);
		run.metrics.llmCalls += 1;
		trackLlmCost(run, ctx, qaPrompt, JSON.stringify(vision), frames.length);
		const ttsOk = audioFiles.filter((f) => f !== null).length;
		const audioSync = audioFiles.length > 0 ? Math.round((ttsOk / audioFiles.length) * 100) : 100;
		const axes = foldQaAxes(vision, audioSync);
		const score = Math.round(axes.reduce((sum, a) => sum + a.score, 0) / axes.length);

		// 逐镜标注（宽容解析：字段缺失/未知 id 都容忍）
		const rawShots = Array.isArray(vision.shots) ? vision.shots : [];
		const byId = new Map(rawShots.map((s) => [String(s?.id ?? ""), s]));
		const shots: QaShotVerdict[] = keptShots.map((shot) => {
			const s = byId.get(shot.id);
			const v = s?.verdict === "ok" || s?.verdict === "warn" || s?.verdict === "fail" ? s.verdict : "ok";
			return { id: shot.id, verdict: v, reason: String(s?.reason ?? "").slice(0, 120) || "通过" };
		});

		// 三态多数决：LLM 的 0-100 分数是伪精确（同帧复评浮动 ±10 常见），分数只保留展示用途；
		// gate 决策以逐镜 verdict 为准——任一 fail 即 fail，warn 过半才 warn，否则 pass。
		const failCount = shots.filter((s) => s.verdict === "fail").length;
		const warnCount = shots.filter((s) => s.verdict === "warn").length;
		const overall = failCount > 0 ? "fail" : warnCount > shots.length - warnCount - failCount ? "warn" : "pass";
		appendSpan(
			run,
			{
				stage: "export",
				name: "审片质检（六轴 + 逐镜标注 + 物理/文字审核）",
				kind: "qa",
				status: failCount > 0 || overall === "fail" ? "semantic-fail" : "ok",
				input: `${keptShots.length} 镜 × 2 帧抽检`,
				output: `综合 ${score}（${overall}）；逐镜 ${shots.filter((s) => s.verdict === "ok").length} ok / ${shots.filter((s) => s.verdict === "warn").length} warn / ${failCount} fail；物理 ${axes.find((a) => a.id === "physicalAccuracy")?.score ?? "-"} / 文字 ${axes.find((a) => a.id === "textQuality")?.score ?? "-"}`,
			},
			t0,
		);
		return { overall, score, axes, shots };
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
		// 质检失败不拖垮成片：给保守 warn 结论并记录
		run.error = `质检阶段跳过: ${error instanceof Error ? error.message : String(error)}`;
		return { overall: "warn", score: 0, axes: [] };
	}
}
