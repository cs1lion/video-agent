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
import { estimateClipSeconds, videoAdapterOf, videoSubmitParams } from "../redo-adapters.ts";
import { VIDEO_QUOTA_POOL } from "../config.ts";
import type { ReserveResult } from "../quota.ts";
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
	// ---- 配额闸门（D5）：派发前先预留，挡住并发超发冲 429 ----
	const quota = sc.ctx.quota;
	const estimateSec = estimateClipSeconds(sc.ctx, opts);
	let quotaShortfall = false;
	/** 预算告警 + 本镜及剩余镜头记空位（配额不会凭空回来，继续派发必被拒，
	 *  继续循环只会白烧关键帧成本——escalate 而非硬撞） */
	const budgetAlert = (fromIndex: number): void => {
		quotaShortfall = true;
		for (let j = fromIndex; j < productionShots.length; j += 1) clipFiles.push(null);
		const remaining = quota?.remainingSec(VIDEO_QUOTA_POOL) ?? 0;
		const skipped = productionShots.length - fromIndex;
		appendSpan(
			run,
			{
				stage: "clips",
				name: `镜头 ${productionShots[fromIndex]!.id} 配额预留`,
				kind: "media",
				status: "error",
				output: `配额不足（剩 ${remaining.toFixed(0)}s < 预估 ${estimateSec}s/镜），跳过 ${skipped} 镜`,
			},
			Date.now(),
		);
		pushEvent(
			run,
			"producer",
			"client",
			"status",
			`⚠️ 预算告警：视频配额不足（剩 ${remaining.toFixed(0)}s，单镜预估 ${estimateSec}s），镜头 ${productionShots[fromIndex]!.id} 起 ${skipped} 镜未派发。建议减少镜头数或缩短镜长。`,
			{ stage: "clips", label: "查看分镜" },
		);
	};
	for (const [i, shot] of productionShots.entries()) {
		throwIfAborted(signal);
		const prompt = shotPrompts.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual;
		// 预检：配额明确不足 → 提前 escalate，连关键帧成本都不烧
		if (quota && (quota.remainingSec(VIDEO_QUOTA_POOL) ?? 0) < estimateSec) {
			budgetAlert(i);
			break;
		}
		// 关键帧先行：组图预览 + 图生视频首帧锚定（失败自动退回纯文生视频）
		const frame = await ensureKeyframe(sc, shot.id, prompt, bible, keyframes, shot);
		const imageDataUrl = frame.file ? await fileDataUrl(run.dir, frame.file) : null;
		// 配额预留：提交前同步扣减；RPM 令牌暂缺会等待补充后重试（可中止）
		let reservation = await reserveShotQuota(sc, shot.id, estimateSec, 0);
		if (!reservation) {
			budgetAlert(i);
			break;
		}
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
		let finished: { status: string; filePath?: string };
		try {
			finished = await sc.queue.awaitJob(submitClip(Boolean(imageDataUrl)).id, undefined, signal);
			// 图生视频整单失败 → 退还本次预留，降级文生视频重新预留（新 attempt = 新幂等键）
			if (!(finished.status === "done" && finished.filePath) && imageDataUrl) {
				releaseReservation(sc, reservation);
				pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 图生视频未成功，降级为文生视频重试。`);
				run.metrics.mediaCalls += 1;
				reservation = await reserveShotQuota(sc, shot.id, estimateSec, 1);
				if (!reservation) {
					budgetAlert(i);
					break;
				}
				finished = await sc.queue.awaitJob(submitClip(false).id, undefined, signal);
			}
		} catch (error) {
			// 中止/异常：未出片不消耗配额，归还预留
			if (reservation) releaseReservation(sc, reservation);
			throw error;
		}
		const ok = finished.status === "done" && finished.filePath;
		clipFiles.push(ok ? finished.filePath! : null);
		// P2：视频生成成功时探测实际时长，按 perSecond 计费 + 按实测结算配额
		if (ok && finished.filePath) {
			let dur: number | null = null;
			try {
				dur = await probeDuration(path.relative(run.dir, finished.filePath), run.dir);
				const adapter = videoAdapterOf(sc.ctx);
				if (adapter) trackMediaCost(run, sc.ctx, adapter, {}, dur ?? opts.clipDurationSec);
			} catch {
				const adapter = videoAdapterOf(sc.ctx);
				if (adapter) trackMediaCost(run, sc.ctx, adapter, {}, opts.clipDurationSec);
			}
			settleReservation(sc, reservation, dur ?? estimateSec);
		} else {
			// 生成失败：没有成片，时长配额未消耗，全额退还（RPM 令牌已在预留时消耗，如实反映）
			releaseReservation(sc, reservation);
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
		throw new Error(quotaShortfall ? "视频配额不足，未派发任何镜头（详见预算告警事件）" : "全部镜头生成失败（详见队列重试记录）");
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

type ShotReservation = Extract<ReserveResult, { ok: true }>;

/**
 * 镜头配额预留（D5 闸门）。时长配额不足返回 null（调用方发预算告警、停止派发）；
 * RPM 令牌暂缺则等补充后重试（可被 signal 中止）。
 * 幂等键 = `${runId}:${shotId}:a${attempt}`：同一 attempt 的重复提交被账本去重，
 * i2v→t2v 降级重试是新 attempt（新键、新令牌）。
 * 无账本（测试桩省略 ctx.quota）→ 占位预留 = 不设闸门（旧行为，降级优于阻断）。
 */
export async function reserveShotQuota(
	sc: StageCtx,
	shotId: string,
	estimateSec: number,
	attempt: number,
): Promise<ShotReservation | null> {
	const quota = sc.ctx.quota;
	if (!quota) return { ok: true, reservationId: "", reservedSec: estimateSec, reused: false };
	for (;;) {
		throwIfAborted(sc.signal);
		const r = quota.reserve(VIDEO_QUOTA_POOL, estimateSec, { idempotencyKey: `${sc.run.id}:${shotId}:a${attempt}` });
		if (r.ok) return r;
		if (r.reason === "rpm_exhausted") {
			const waitMs = quota.snapshot().find((p) => p.id === VIDEO_QUOTA_POOL)?.rpmWaitMs ?? 1000;
			await sleepAbortable(Math.min(waitMs + 100, 65_000), sc.signal);
			continue;
		}
		return null; // insufficient_quota / unknown_pool / invalid → 预算告警由调用方处理
	}
}

function releaseReservation(sc: StageCtx, reservation: ShotReservation): void {
	if (sc.ctx.quota && reservation.reservationId) sc.ctx.quota.release(reservation.reservationId);
}

function settleReservation(sc: StageCtx, reservation: ShotReservation, actualSec: number): void {
	if (sc.ctx.quota && reservation.reservationId) sc.ctx.quota.settle(reservation.reservationId, actualSec);
}

/** 可中止 sleep：abort 时立即 reject「已中止」（与管线其余中止路径同语义） */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("已中止"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("已中止"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
