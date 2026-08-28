/**
 * rettsRun —— 旁白重录（语音级重做）。
 *
 * 关键设计（与 reshotRun 镜像）：
 * 1. 同步占位 + bail：消除双提交竞态窗口
 * 2. withVersionedAsset：tts 备份→生成→rollback 走公共抽象
 * 3. voice 参数：label 或 id 均可，未知音色回退 adapter 默认
 * 4. run.metrics.mediaCalls：TTS 每次调用都计费
 * 5. 自动 retts 后调 executeStages(["export"]) 重装配（按新时长重排该镜）
 * 6. P2+派发后回灌：动作前快照 verdict，比较 audioSync 轴变化
 *
 * 调用方：POST /api/runs/:id/retts
 * 依赖：pipeline.ts 的 stageXxx / runQa / executeStages + asset-version.ts
 */

import * as path from "node:path";
import { GenerationQueue } from "../../../coding-agent/examples/extensions/studio/media/queue.ts";
import { chatJson } from "../llm.ts";
import { withVersionedAsset } from "../asset-version.ts";
import { ttsAdapterOf } from "../redo-adapters.ts";
import { trackMediaCost } from "../pricing.ts";
import { fallbackVoiceDirection, narrationFor, rettsNarrationMessages } from "../prompts.ts";
import {
	MAX_RETTS_PER_SHOT,
	type RunRecord,
	appendSpan,
	computeQaRegressionText,
	executeStages,
	optionsOf,
	persistRun,
	pushEvent,
	pushLastAction,
	readArtifact,
	readKeyframes,
	resolveVoice,
	setStage,
	snapshotShotVerdict,
	stage,
	type StageCtx,
	writeJson,
} from "../pipeline.ts";
import type { ScriptDoc } from "../prompts.ts";
import type { ServerContext } from "../config.ts";
import type { ServerContext as _ServerContext } from "../config.ts";

/**
 * 旁白重录（语音级重做）
 * 护栏：每镜上限 MAX_RETTS_PER_SHOT；生成失败自动回滚旧录音。
 */
export async function rettsRun(
	ctx: ServerContext,
	run: RunRecord,
	shotId: string,
	instruction: string,
	voice?: string,
): Promise<{ ok: boolean; error?: string }> {
	const resolvedVoice = resolveVoice(ctx, voice);
	const prevStatus = run.status;
	if (prevStatus === "running") return { ok: false, error: "管线运行中，请稍候" };
	// 同步占位：在首个 await 前进入运行态，消除双提交竞态窗口；校验失败恢复原状态
	run.status = "running";
	const bail = (error: string): { ok: false; error: string } => {
		run.status = prevStatus;
		return { ok: false, error };
	};
	if (stage(run, "audio").status !== "done") return bail("配音尚未完成，无法重录旁白");

	let script: ScriptDoc;
	try {
		script = await readArtifact<ScriptDoc>(run, "script.json");
	} catch {
		return bail("剧本产物缺失，无法定位镜头");
	}
	const shot = script.shots.find((s) => s.id === shotId);
	if (!shot) return bail(`镜头 ${shotId} 不存在`);
	const narration = narrationFor(shot, optionsOf(run).promptLanguage).trim();
	if (!narration) return bail(`镜头 ${shotId} 无旁白，无需重录`);

	const attempts = (run.ttsAttempts[shotId] ?? 0) + 1;
	if (attempts > MAX_RETTS_PER_SHOT) {
		return bail(
			`镜头 ${shotId} 旁白已重录 ${MAX_RETTS_PER_SHOT} 次达上限。建议在「剧本」阶段微调后整体重跑。`,
		);
	}
	run.ttsAttempts[shotId] = attempts;
	// P2+派发后回灌：动作前快照 verdict，retts 后 audioSync 可能有变化
	const beforeSnapshot = snapshotShotVerdict(run, shotId);

	// 指令解析：改写文案（copy-edit）或纯表演指导（voice-only）
	let scriptUpdated = false;
	if (instruction.trim()) {
		const t0 = Date.now();
		try {
			const parsed = await chatJson<{
				mode?: string;
				narrationZh?: string;
				narrationEn?: string;
				instruction?: string;
			}>(ctx.llm, rettsNarrationMessages(shot, instruction.trim(), optionsOf(run)));
			const mode = parsed.mode === "copy-edit" ? "copy-edit" : "voice-only";
			const newInstruction = typeof parsed.instruction === "string" ? parsed.instruction.trim().slice(0, 200) : "";
			if (mode === "copy-edit") {
				const zh = typeof parsed.narrationZh === "string" ? parsed.narrationZh.trim() : "";
				const en = typeof parsed.narrationEn === "string" ? parsed.narrationEn.trim() : "";
				if (zh && zh !== shot.narrationZh) {
					shot.narrationZh = zh.slice(0, 400);
					scriptUpdated = true;
				}
				if (en && en !== shot.narrationEn) {
					shot.narrationEn = en.slice(0, 400);
					scriptUpdated = true;
				}
			}
			if (newInstruction && newInstruction !== shot.ttsDirection) {
				shot.ttsDirection = newInstruction;
				scriptUpdated = true;
			}
		} catch {
			// 解析失败：忽略，沿用原文案与指导
		}
	}

	pushEvent(
		run,
		"producer",
		"sound",
		"user",
		`请求重录镜头 ${shotId} 旁白${instruction ? `：${instruction}` : "（原文重录）"}`,
	);
	pushEvent(
		run,
		"director",
		"sound",
		"redo",
		`安排重录镜头 ${shotId} 旁白（第 ${attempts}/${MAX_RETTS_PER_SHOT} 轮）${scriptUpdated ? "，文案已按指令调整" : ""}。旧录音备份为历史版本，新语音就位后该镜按新时长重排、重新混音并复审。`,
	);

	// 回退导出态，进入运行
	setStage(run, "export", "pending", 0);
	run.verdict = undefined;
	run.videoUrl = undefined;
	run.status = "running";
	run.redoActive = { kind: "retts", shotId, label: `重录 ${shotId} 旁白` };
	persistRun(run);

	void (async () => {
		const queue = new GenerationQueue(ctx.mediaConfig);
		const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
		try {
			// 1. 备份现有 TTS（版本化：tts-SHxx_v{n}.mp3）
			run.ttsVersions[shotId] = run.ttsVersions[shotId] ?? [];
			const versions = run.ttsVersions[shotId];
			const voiceDirection =
				shot.ttsDirection ?? fallbackVoiceDirection(run.brief);
			const { file: okRel } = await withVersionedAsset({
				run,
				mainRelPath: `assets/tts-${shotId}.mp3`,
				versions,
				backupRelPath: `assets/tts-${shotId}_v${versions.length + 1}.mp3`,
				generate: async () => {
					const job = queue.submit(
						{
							roleName: "video-agent",
							kind: "tts",
							prompt: narration,
							params: { instruction: voiceDirection, ...(resolvedVoice ? { voice: resolvedVoice } : {}) },
							outputName: `tts-${shotId}`,
						},
						run.dir,
					);
					run.metrics.mediaCalls += 1;
					const finished = await queue.awaitJob(job.id, undefined, sc.signal);
					return finished.status === "done" && finished.filePath
						? path.relative(run.dir, finished.filePath)
						: null;
				},
			});
			const ok = Boolean(okRel);

			// P2：旁白重录成功后按 prompt 字符数计费
			if (ok) {
				const adapter = ttsAdapterOf(sc.ctx);
				if (adapter) trackMediaCost(run, sc.ctx, adapter, { prompt: narration });
			}
			appendSpan(
				run,
				{
					stage: "reshot",
					name: `镜头 ${shotId} 旁白重录（第 ${attempts} 轮）`,
					kind: "media",
					status: ok ? "ok" : "error",
					input: narration.slice(0, 120),
					output: ok ? path.basename(okRel!) : `队列状态 error`,
				},
				Date.now(),
			);
			if (!ok) {
				// withVersionedAsset 已自动回滚（还有可重试机会、版本数 PUSH/POP 原子）。
				pushEvent(run, "sound", "producer", "redo", `镜头 ${shotId} 旁白重录失败 ⚠️，已恢复旧录音。可稍后重试。`);
				throw new Error(`镜头 ${shotId} 旁白重录失败（旧版本已回滚）`);
			}

			// 3. 新语音就位：重跑 export（重新归一化该镜 → 时长随旁白重排 → 装配 → 复审）
			pushEvent(
				run,
				"sound",
				"editor",
				"handoff",
				`镜头 ${shotId} 新旁白就位 ✅（旧录音备份为 ${versions[versions.length - 1] ?? "无"}）。剪辑师按新时长重排该镜、重装时间线并重新混音，随后复审。`,
				{ stage: "post", focus: shotId, label: "试听新配音" },
			);
			await executeStages(ctx, run, ["export"], { fromResume: true });
			run.redoActive = null;
			pushLastAction(run, {
				kind: "retts",
				shotId,
				label: `重录 ${shotId} 旁白`,
				at: new Date().toISOString(),
			});
			persistRun(run);

			// P2+派发后回灌：配音重录可能影响 textQuality 轴（字幕/咬字对齐）
			const afterSnapshot = snapshotShotVerdict(run, shotId);
			const deltaText = computeQaRegressionText(shotId, beforeSnapshot, afterSnapshot);
			if (deltaText) {
				pushEvent(run, "sound", "client", "redo", deltaText, { stage: "post", focus: shotId });
			}
		} catch (error) {
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
			pushEvent(run, "sound", "producer", "status", `旁白重录受阻 ⚠️：${run.error}`);
			persistRun(run);
		}
	})();
	return { ok: true };
}
