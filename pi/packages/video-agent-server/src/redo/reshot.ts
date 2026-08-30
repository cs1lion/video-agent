/**
 * reshotRun —— 镜头级重做（视频 + 可选关键帧级联重绘）。
 *
 * 关键设计：
 * 1. 同步占位 + bail：第一个 await 前进入运行态，消除双提交竞态窗口
 * 2. withVersionedAsset：视频片段 backup→generate→rollback 走公共抽象
 * 3. 关键帧级联重绘：若反馈涉及外观（QA/一致性/客户指令），先重绘关键帧再图生视频，
 *    避免旧关键帧外观压过新指令（"重做了但画面没变"陷阱）
 * 4. i2v→t2v 自动回退：图生视频失败时降级为文生视频
 * 5. run.metrics.mediaCalls：每次视频调用都计费，无论成功失败
 * 6. 自动 reshot 后调 executeStages(["export"]) 重装配 + 复审 + 拉新 verdict 快照
 * 7. P2+派发后回灌：动作前快照 verdict，重做后比评分变化（仅退步/裁决变化时推）
 * 8. B1 redo 路径接账本：提交前预留，出片后按实测结算，失败/降级退还（D5）
 *
 * 调用方：POST /api/runs/:id/reshot
 * 依赖：pipeline.ts 的 stageXxx / runQa / executeStages + asset-version.ts + redo-adapters.ts
 */

import * as path from "node:path";
import { GenerationQueue } from "../../../coding-agent/examples/extensions/studio/media/queue.ts";
import { probeDuration } from "../ffmpeg.ts";
import { withVersionedAsset, fileDataUrl } from "../asset-version.ts";
import { estimateClipSeconds, videoAdapterOf, videoSubmitParams } from "../redo-adapters.ts";
import { trackMediaCost } from "../pricing.ts";
import { reserveShotQuota } from "../stages/clips.ts";
import type { ReserveResult } from "../quota.ts";
import { imageSizeFor } from "../pipeline.ts";
import { keyframePrompt } from "../prompts.ts";
import {
	MAX_RESHOT_PER_SHOT,
	type RedoActive,
	type RunRecord,
	appendSpan,
	computeQaRegressionText,
	executeStages,
	generateImage,
	type StageCtx,
	optionsOf,
	persistRun,
	pushEvent,
	pushLastAction,
	readArtifact,
	readKeyframes,
	setStage,
	snapshotShotVerdict,
	stage,
	writeJson,
} from "../pipeline.ts";
import { designAnchorsOf } from "../pipeline.ts";
import type { ServerContext } from "../config.ts";
import type { ScriptDoc, ShotPromptDoc, VisualBible } from "../prompts.ts";
import { pixelDimensions } from "../../../video-agent/src/index.ts";

// ---------------------------------------------------------------------------
// B1 redo 路径配额接线（本地定义，避免与 stages/clips.ts 形成循环依赖）
// ---------------------------------------------------------------------------

type ShotReservation = Extract<ReserveResult, { ok: true }>;

/**
 * 配额预留统一走 `stages/clips.ts` 的 `reserveShotQuota`——那里是**唯一的选池决策点**
 * （每 key 一池，`quota.pickPool()` 选当前可用池）。
 *
 * 此前本文件有一份硬编码 `VIDEO_QUOTA_POOL` 的复制实现，多 key 并发改造下会导致
 * reshot 路径永远只走固定那一个池，白瞎其余 key 的额度。删掉副本改为复用，
 * 顺带消除"预留/结算/退还散在多处"的重复隐患（见 08-29 评审报告 B1 节）。
 */

function releaseReservation(quota: ServerContext["quota"], reservation: ShotReservation | null): void {
	if (quota && reservation?.reservationId) quota.release(reservation.reservationId);
}

function settleReservation(quota: ServerContext["quota"], reservation: ShotReservation | null, actualSec: number): void {
	if (quota && reservation?.reservationId) quota.settle(reservation.reservationId, actualSec);
}

/**
 * 镜头级重做（POST /api/runs/:id/reshot 入口）
 * 护栏：每镜上限 MAX_RESHOT_PER_SHOT；生成失败自动回滚旧版本。
 */
export async function reshotRun(
	ctx: ServerContext,
	run: RunRecord,
	shotId: string,
	instruction: string,
): Promise<{ ok: boolean; error?: string }> {
	const prevStatus = run.status;
	if (prevStatus === "running") return { ok: false, error: "管线运行中，请稍候" };
	// 同步占位：在首个 await 前进入运行态，消除双提交竞态窗口；校验失败恢复原状态
	run.status = "running";
	const bail = (error: string): { ok: false; error: string } => {
		run.status = prevStatus;
		return { ok: false, error };
	};
	if (stage(run, "clips").status !== "done") return bail("镜头生成尚未完成，无法逐镜重做");

	let script: ScriptDoc;
	try {
		script = await readArtifact<ScriptDoc>(run, "script.json");
	} catch {
		return bail("剧本产物缺失，无法定位镜头");
	}
	const shot = script.shots.find((s) => s.id === shotId);
	if (!shot) return bail(`镜头 ${shotId} 不存在`);

	const attempts = (run.shotAttempts[shotId] ?? 0) + 1;
	if (attempts > MAX_RESHOT_PER_SHOT) {
		return bail(
			`镜头 ${shotId} 已重做 ${MAX_RESHOT_PER_SHOT} 次达上限。建议在「分镜提示词」阶段微调后整体重跑，或人工确认当前版本。`,
		);
	}
	// P2+派发后回灌：动作前快照 QA verdict，动作完成后对比
	const beforeSnapshot = snapshotShotVerdict(run, shotId);
	run.shotAttempts[shotId] = attempts;

	// 提示词 = 原分镜提示词 + 角色锚点 + 质检/一致性反馈回灌 + 客户指令
	const shotPrompts = await readArtifact<ShotPromptDoc>(run, "prompts.json").catch(() => null);
	const basePrompt = shotPrompts?.prompts.find((p) => p.shotId === shotId)?.prompt ?? shot.visual;
	const qaNote = run.verdict?.shots?.find((s) => s.id === shotId)?.reason;
	const consistencyNote = (
		await readArtifact<{ shots?: { shotId: string; issues?: string[] }[] }>(run, "consistency.json").catch(() => null)
	)?.shots
		?.find((s) => s.shotId === shotId)
		?.issues?.join("；");
	const anchors = await designAnchorsOf(run);
	const prompt = [
		basePrompt,
		anchors ? `【角色锚点】人物外观必须严格遵循，不得漂移：${anchors}` : "",
		qaNote && qaNote !== "通过" ? `【质检反馈】上一版本问题：${qaNote}。请规避该问题。` : "",
		consistencyNote ? `【一致性反馈】跨镜不一致：${consistencyNote}。请修正为与其他镜头一致。` : "",
		instruction ? `【客户指令】${instruction}` : "",
	]
		.filter(Boolean)
		.join("\n");

	pushEvent(run, "producer", "client", "user", `请求重做镜头 ${shotId}${instruction ? `：${instruction}` : "。"}`);
	pushEvent(
		run,
		"director",
		"tech",
		"director",
		`安排补拍镜头 ${shotId}（第 ${attempts}/${MAX_RESHOT_PER_SHOT} 轮）。${qaNote && qaNote !== "通过" ? `修复问题：${qaNote}。` : ""}旧片段将备份为历史版本，新片段替换主版本后重新装配。`,
	);

	// 回退导出态，进入运行
	setStage(run, "export", "pending", 0);
	run.verdict = undefined;
	run.videoUrl = undefined;
	run.status = "running";
	const redoActive: RedoActive = { kind: "reshot", shotId, label: `补拍镜头 ${shotId}` };
	run.redoActive = redoActive;
	persistRun(run);

	void (async () => {
		const queue = new GenerationQueue(ctx.mediaConfig);
		const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
		const opts = optionsOf(run);
		const estimateSec = estimateClipSeconds(sc.ctx, opts);

		// B1 redo 路径接账本：提交前先预留；RPM 暂缺可等，配额不足直接 bail
		let reservation = await reserveShotQuota(sc, shotId, estimateSec, 0);
		if (!reservation) {
			run.status = "failed";
			run.error = "视频配额不足，无法补拍。建议缩短镜长或等待配额恢复。";
			run.redoActive = null;
			pushEvent(
				run,
				"producer",
				"client",
				"status",
				`镜头 ${shotId} 补拍配额不足 ⚠️，未派发。建议缩短镜长或等待配额恢复。`,
			);
			persistRun(run);
			return;
		}

		try {
			// 1. 外观类反馈（客户指令/质检/一致性）→ 先重绘关键帧再图生视频：
			//    视频以首帧锚定时，旧关键帧的外观（如发色年龄）会压过文本指令，
			//    旧实现直接复用旧首帧导致"重做了但画面没变"。
			//    顺序约束：必须先于视频生成的 withVersionedAsset——其 generate 闭包
			//    要用重绘后的 kfDataUrl 与 width/height（此前顺序颠倒导致 TDZ 崩溃）。
			const { width, height } = pixelDimensions(opts.resolution, opts.aspectRatio);
			const kfDoc = await readKeyframes(run);
			const kf = kfDoc.frames.find((f) => f.shotId === shotId);
			const appearanceFeedback = [instruction, qaNote && qaNote !== "通过" ? qaNote : "", consistencyNote ?? ""]
				.filter(Boolean)
				.join("；");
			if (kf?.status === "done" && kf.file && appearanceFeedback) {
				pushEvent(
					run,
					"storyboard",
					"tech",
					"redo",
					`外观反馈涉及镜头 ${shotId}，先重绘关键帧（${appearanceFeedback.slice(0, 60)}…）再补拍，避免旧首帧锚定导致重做无效。`,
				);
				const bible = await readArtifact<VisualBible>(run, "visual-bible.json").catch(
					() => ({ styleKeywords: [], palette: [], lighting: "", grade: "" }) as VisualBible,
				);
				// 先备份旧图、再生成：生成写入同名主文件，若先生成后备份，
				// 备份旧图再生成（顺序反了会把新图误挪进版本库）。kf.versions 可能为 undefined（旧 run）。
				const kfVersions = kf.versions ?? [];
				const vRelPath = `assets/key-${shotId}_v${kfVersions.length + 1}${path.extname(kf.file)}`;
				const { file: newKf } = await withVersionedAsset({
					run,
					mainRelPath: kf.file,
					versions: (kf.versions = kfVersions),
					backupRelPath: vRelPath,
					generate: () =>
						generateImage(
							sc,
							`${keyframePrompt(basePrompt, bible, anchors)}, adjustment: ${appearanceFeedback}`,
							`key-${shotId}`,
							imageSizeFor(opts.aspectRatio),
						),
				});
				if (newKf) {
					kf.file = newKf;
					await writeJson(run, "keyframes.json", kfDoc);
				}
				if (!newKf) {
					pushEvent(
						run,
						"storyboard",
						"tech",
						"status",
						`镜头 ${shotId} 关键帧重绘未成功 ⚠️，本次仍按旧首帧补拍。`,
					);
				}
			}
			const kfDataUrl = kf?.status === "done" && kf.file ? await fileDataUrl(run.dir, kf.file) : null;
			pushEvent(
				run,
				"tech",
				"producer",
				"status",
				`镜头 ${shotId} 重新提交生成（第 ${attempts} 轮${kfDataUrl ? " · 关键帧锚定" : ""}）。`,
			);

			// 2. 备份现有片段（版本化：clip-SHxx_v{n}.mp4）。使用 withVersionedAsset
			//    抽出"备份→生成→回滚"公共模式，i2v→t2v 回退放在 generate 内部。
			//    withVersionedAsset 返回 { file }，generate 写入的是主名（相对 run.dir），
			//    因此这里用主名反算绝对路径。
			run.shotVersions[shotId] = run.shotVersions[shotId] ?? [];
			const versions = run.shotVersions[shotId];
			const { file: okRel } = await withVersionedAsset({
				run,
				mainRelPath: `assets/clip-${shotId}.mp4`,
				versions,
				backupRelPath: `assets/clip-${shotId}_v${versions.length + 1}.mp4`,
				generate: async () => {
					const i2vJob = queue.submit(
						{
							roleName: "video-agent",
							kind: "video",
							// 多 key 并发：任务投给预留所在池绑定的 adapter（不传则走默认解析）
							adapterId: reservation?.adapterId,
							prompt,
							params: videoSubmitParams(sc.ctx, opts, width, height, kfDataUrl),
							outputName: `clip-${shotId}`,
						},
						run.dir,
					);
					run.metrics.mediaCalls += 1;
					const i2v = await queue.awaitJob(i2vJob.id, undefined, sc.signal);
					if (i2v.status === "done" && i2v.filePath) {
						return path.relative(run.dir, i2v.filePath);
					}
					// 图生视频失败：退还本次预留，降级文生视频重新预留（新 attempt = 新幂等键）
					releaseReservation(sc.ctx.quota, reservation);
					reservation = await reserveShotQuota(sc, shotId, estimateSec, 1);
					if (!reservation) {
						pushEvent(
							run,
							"tech",
							"producer",
							"status",
							`镜头 ${shotId} 文生视频配额不足，已退还图生视频预留。`,
						);
						return null;
					}
					// 图生视频退化为文生视频（同一份输出名，会覆盖主文件）
					const t2vJob = queue.submit(
						{
							roleName: "video-agent",
							kind: "video",
							// 多 key 并发：任务投给预留所在池绑定的 adapter（不传则走默认解析）
							adapterId: reservation?.adapterId,
							prompt,
							params: videoSubmitParams(sc.ctx, opts, width, height, null),
							outputName: `clip-${shotId}`,
						},
						run.dir,
					);
					run.metrics.mediaCalls += 1;
					const t2v = await queue.awaitJob(t2vJob.id, undefined, sc.signal);
					return t2v.status === "done" && t2v.filePath ? path.relative(run.dir, t2v.filePath) : null;
				},
			});
			const ok = Boolean(okRel);
			const finished = okRel ? { status: "done" as const, filePath: path.join(run.dir, okRel) } : null;
			const t0 = Date.now();
			// P2：重做镜头成功后按实际时长计费 + B1 配额结算
			if (ok && finished) {
				try {
					const dur = await probeDuration(path.relative(run.dir, finished.filePath), run.dir);
					const adapter = videoAdapterOf(sc.ctx);
					if (adapter) trackMediaCost(run, sc.ctx, adapter, {}, dur ?? opts.clipDurationSec);
					settleReservation(sc.ctx.quota, reservation, dur ?? estimateSec);
				} catch {
					const adapter = videoAdapterOf(sc.ctx);
					if (adapter) trackMediaCost(run, sc.ctx, adapter, {}, opts.clipDurationSec);
					settleReservation(sc.ctx.quota, reservation, estimateSec);
				}
			} else {
				releaseReservation(sc.ctx.quota, reservation);
			}
			appendSpan(
				run,
				{
					stage: "reshot",
					name: `镜头 ${shotId} 重做（第 ${attempts} 轮）`,
					kind: "media",
					status: ok ? "ok" : "error",
					input: prompt.slice(0, 120),
					output: ok && finished ? path.basename(finished.filePath) : `队列状态 ${finished?.status ?? "error"}`,
				},
				t0,
			);
			if (!ok) {
				// withVersionedAsset 已自动回滚（还有可重试机会、版本数 PUSH/POP 原子）。
				pushEvent(run, "tech", "producer", "status", `镜头 ${shotId} 重做失败 ⚠️，已恢复旧版本。可稍后重试。`);
				throw new Error(`镜头 ${shotId} 重做失败（旧版本已回滚）`);
			}

			// 3. 重新装配 + 质检（stageExport 从磁盘读取 assets 内片段）
			pushEvent(
				run,
				"tech",
				"editor",
				"handoff",
				`镜头 ${shotId} 新片段就位 ✅（旧版本备份为 ${versions[versions.length - 1] ?? "无"}）。剪辑师重新装配时间线与字幕，随后复审。`,
				{ stage: "generate", focus: shotId, label: "查看新片段" },
			);
			await executeStages(ctx, run, ["export"], { fromResume: true });
			run.redoActive = null;
			pushLastAction(run, {
				kind: "reshot",
				shotId,
				label: `补拍镜头 ${shotId}`,
				at: new Date().toISOString(),
			});
			persistRun(run);

			// P2+派发后回灌：对比新旧 verdict，告诉用户这次重做是改善了还是退步了
			const afterSnapshot = snapshotShotVerdict(run, shotId);
			const deltaText = computeQaRegressionText(shotId, beforeSnapshot, afterSnapshot);
			if (deltaText) {
				pushEvent(run, "producer", "client", "redo", deltaText, { stage: "review", focus: shotId });
			}
		} catch (error) {
			releaseReservation(sc.ctx.quota, reservation);
			if (sc.signal.aborted) {
				run.status = "cancelled";
				run.redoActive = null;
				persistRun(run);
				return;
			}
			const current = run.stages.find((s) => s.status === "running");
			if (current) current.status = "failed";
			run.status = "failed";
			run.error = error instanceof Error ? error.message : String(error);
			run.redoActive = null;
			pushEvent(run, "producer", "client", "status", `镜头重做受阻 ⚠️：${run.error}`);
			persistRun(run);
		}
	})();
	return { ok: true };
}
