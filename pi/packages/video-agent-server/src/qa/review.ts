/**
 * runQa —— 视觉质检。
 * 每镜中点帧（按实际时间轴）抽帧 → 视觉模型打 4 个视觉维度分 + 逐镜三态标注；
 * audioSync 由 TTS 成功率确定性算。质检失败不拖垮成片：给保守 warn 结论并记录。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { type ScriptDoc } from "../prompts.ts";
import {
	appendSpan,
	throwIfAborted,
	type QaShotVerdict,
	type QaVerdict,
	type StageCtx,
} from "../pipeline.ts";
import { extractFrame } from "../ffmpeg.ts";
import { chatVisionJson } from "../llm.ts";
import { trackLlmCost } from "../pricing.ts";
import { type GenerationOptions } from "../../../video-agent/src/index.ts";

/** 视觉质检：每镜中点帧（按实际时间轴） → 模型打 4 个视觉维度分 + 逐镜三态标注；audioSync 由 TTS 成功率算 */
export async function runQa(
	sc: StageCtx,
	keptShots: ScriptDoc["shots"],
	opts: GenerationOptions,
	finalPath: string,
	audioFiles: (string | null)[],
	midpoints: number[],
): Promise<QaVerdict> {
	const { run, ctx, signal } = sc;
	const frames: string[] = [];
	const t0 = Date.now();
	try {
		for (const [i, shot] of keptShots.entries()) {
			throwIfAborted(signal);
			const atSec = midpoints[i] ?? i * opts.clipDurationSec + opts.clipDurationSec / 2;
			const framePath = path.join("assets", `qa-${shot.id}.jpg`);
			await extractFrame({ cwd: run.dir, videoPath: finalPath, atSec, outPath: framePath, signal });
			frames.push(await fs.promises.readFile(path.join(run.dir, framePath)).then((b) => b.toString("base64")));
		}
		throwIfAborted(signal);
		const shotList = keptShots.map((s) => s.id).join("、");
		// 提取为变量：计费必须按真实 prompt 长度 + 帧数（此前传字面量 "qa-visual" 9 字符，
		// 多模态输入成本≈0，视觉调用被系统性低估）
		const qaPrompt = [
			"这是同一条广告片的分镜帧（按顺序）。广告需求：",
			run.brief.creative.logline,
			run.brief.creative.keyMessage ? `关键信息: ${run.brief.creative.keyMessage}` : "",
			`镜头编号依次为：${shotList}。`,
			"",
			"请基于帧内容打分（0-100 整数）：",
			"briefFit: 画面内容与广告需求的贴合度；",
			"visualConsistency: 各帧风格/色调/光线的一致性；",
			"pacing: 镜头推进的节奏感（开场-展开-收尾是否有层次）；",
			"textQuality: 画面中是否出现乱码文字/水印/logo（完全干净=100，出现即大幅扣分）。",
			"",
			"同时逐镜标注：verdict 取 ok（可用）/ warn（勉强）/ fail（明显不合格，如乱码文字、画面崩坏、与需求严重不符），reason 用一句话说明（ok 可写「通过」）。",
			"",
			`只输出 JSON: {"briefFit": 0, "visualConsistency": 0, "pacing": 0, "textQuality": 0, "shots": [{"id": "${keptShots[0]?.id ?? "SH01"}", "verdict": "ok", "reason": "…"}]}`,
		]
			.filter(Boolean)
			.join("\n");
		const vision = await chatVisionJson<{
			briefFit: number;
			visualConsistency: number;
			pacing: number;
			textQuality: number;
			shots?: { id?: string; verdict?: string; reason?: string }[];
		}>(ctx.llm, qaPrompt, frames, signal);
		run.metrics.llmCalls += 1;
		trackLlmCost(run, ctx, qaPrompt, JSON.stringify(vision), frames.length);
		const ttsOk = audioFiles.filter((f) => f !== null).length;
		const audioSync = audioFiles.length > 0 ? Math.round((ttsOk / audioFiles.length) * 100) : 100;
		const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
		const axes: QaVerdict["axes"] = [
			{ id: "briefFit", score: clamp(vision.briefFit) },
			{ id: "visualConsistency", score: clamp(vision.visualConsistency) },
			{ id: "pacing", score: clamp(vision.pacing) },
			{ id: "audioSync", score: audioSync },
			{ id: "textQuality", score: clamp(vision.textQuality) },
		];
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
				name: "审片质检（五轴 + 逐镜标注）",
				kind: "qa",
				status: failCount > 0 || overall === "fail" ? "semantic-fail" : "ok",
				input: `${frames.length} 帧抽检`,
				output: `综合 ${score}（${overall}）；逐镜 ${shots.filter((s) => s.verdict === "ok").length} ok / ${shots.filter((s) => s.verdict === "warn").length} warn / ${failCount} fail`,
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
