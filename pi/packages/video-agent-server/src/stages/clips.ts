/**
 * stageClips —— 镜头生成阶段（图生视频，含 i2v→t2v 退降）。
 * 逐镜提交视频队列：关键帧先行做首帧锚定（有关键帧则图生视频，失败退文生视频）。
 * 部分确认：只把用户放行的镜头交生成，未勾选镜头不消耗额度。
 */

import * as path from "node:path";
import { type ScriptDoc, type ShotPromptDoc, type VisualBible } from "../prompts.ts";
import {
	appendSpan,
	ensureKeyframe,
	optionsOf,
	pushEvent,
	readArtifact,
	readKeyframes,
	setStage,
	throwIfAborted,
	type StageCtx,
} from "../pipeline.ts";
import { fileDataUrl } from "../asset-version.ts";
import { trackMediaCost } from "../pricing.ts";
import { probeDuration } from "../ffmpeg.ts";
import { videoAdapterOf, videoSubmitParams } from "../redo-adapters.ts";
import { pixelDimensions } from "../../../video-agent/src/index.ts";

/** 镜头生成阶段：图生视频（含 i2v→t2v 退降） */
export async function stageClips(
	sc: StageCtx,
	script?: ScriptDoc,
): Promise<{ script: ScriptDoc; clipFiles: (string | null)[] }> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	const shotPrompts = await readArtifact<ShotPromptDoc>(run, "prompts.json");
	const bible = await readArtifact<VisualBible>(run, "visual-bible.json").catch(
		() => ({ styleKeywords: [], palette: [], lighting: "", grade: "" }) as VisualBible,
	);
	const keyframes = await readKeyframes(run);
	setStage(run, "clips", "running", 0);
	// 部分确认：只把用户明确放行的关键帧交给视频队列；未勾选镜头不消耗额度。
	// 返回过滤后的 script，使 audio/export 与“实际制作集”保持同一顺序与同一长度。
	// 关键区分：undefined 是旧 run / 未确认；空数组是显式清空（禁止），有值则严格按清单。
	const hasRecordedSelection = Array.isArray(keyframes.confirmedShotIds);
	const productionShots = hasRecordedSelection
		? scriptDoc.shots.filter((shot) => keyframes.confirmedShotIds?.includes(shot.id))
		: scriptDoc.shots;
	const { width, height } = pixelDimensions(opts.resolution, opts.aspectRatio);
	const clipFiles: (string | null)[] = [];
	for (const [i, shot] of productionShots.entries()) {
		throwIfAborted(signal);
		const prompt = shotPrompts.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual;
		// 关键帧先行：组图预览 + 图生视频首帧锚定（失败自动退回纯文生视频）
		const frame = await ensureKeyframe(sc, shot.id, prompt, bible, keyframes, shot);
		const imageDataUrl = frame.file ? await fileDataUrl(run.dir, frame.file) : null;
		pushEvent(
			run,
			"tech",
			"producer",
			"status",
			`镜头 ${shot.id} 提交生成（${opts.resolution} · ${opts.clipDurationSec}s · ${imageDataUrl ? "关键帧+提示词 图生视频" : "文生视频"}）：${prompt.slice(0, 60)}…`,
		);
		const t0 = Date.now();
		const submitClip = (withImage: boolean) =>
			sc.queue.submit(
				{
					roleName: "video-agent",
					kind: "video",
					prompt,
					// seed 不透传：未知参数可能被供应商 400 拒绝，仅在 options 中保留
					params: videoSubmitParams(sc.ctx, opts, width, height, withImage && imageDataUrl ? imageDataUrl : null),
					outputName: `clip-${shot.id}`,
				},
				run.dir,
			);
		run.metrics.mediaCalls += 1;
		let finished = await sc.queue.awaitJob(submitClip(Boolean(imageDataUrl)).id, undefined, signal);
		// 图生视频整单失败 → 降级为文生视频再试一次
		if (!(finished.status === "done" && finished.filePath) && imageDataUrl) {
			pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 图生视频未成功，降级为文生视频重试。`);
			run.metrics.mediaCalls += 1;
			finished = await sc.queue.awaitJob(submitClip(false).id, undefined, signal);
		}
		const ok = finished.status === "done" && finished.filePath;
		clipFiles.push(ok ? finished.filePath! : null);
		// P2：视频生成成功时探测实际时长，按 perSecond 计费
		if (ok && finished.filePath) {
			try {
				const dur = await probeDuration(path.relative(run.dir, finished.filePath), run.dir);
				const adapter = videoAdapterOf(sc.ctx);
				if (adapter) trackMediaCost(run, sc.ctx, adapter, {}, dur ?? opts.clipDurationSec);
			} catch {
				const adapter = videoAdapterOf(sc.ctx);
				if (adapter) trackMediaCost(run, sc.ctx, adapter, {}, opts.clipDurationSec);
			}
		}
		appendSpan(
			run,
			{
				stage: "clips",
				name: `镜头 ${shot.id} 生成`,
				kind: "media",
				status: ok ? "ok" : "error",
				input: `${imageDataUrl ? "[keyframe+i2v] " : ""}${prompt.slice(0, 120)}`,
				output: ok ? path.basename(finished.filePath!) : `队列状态 ${finished.status}`,
			},
			t0,
		);
		if (ok) {
			pushEvent(
				run,
				"tech",
				"editor",
				"status",
				`镜头 ${shot.id} 生成完成 ✅（${i + 1}/${productionShots.length}）`,
				{ stage: "generate", focus: shot.id, label: "查看片段" },
			);
		} else {
			pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 生成失败 ⚠️，已跳过并由剪辑师在时间线上补位。`, {
				stage: "generate",
				focus: shot.id,
				label: "查看该镜",
			});
		}
		setStage(run, "clips", "running", Math.round(((i + 1) / productionShots.length) * 100));
	}
	const okCount = clipFiles.filter((f) => f !== null).length;
	if (okCount === 0) {
		throw new Error("全部镜头生成失败（详见队列重试记录）");
	}
	setStage(run, "clips", "done", 100);
	pushEvent(
		run,
		"tech",
		"editor",
		"handoff",
		`镜头批次交付：${okCount}/${productionShots.length} 镜成功，移交剪辑师归一化与合成。`,
	);
	return { script: { ...scriptDoc, shots: productionShots }, clipFiles };
}
