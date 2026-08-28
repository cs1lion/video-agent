/**
 * stageAudio —— 配音阶段。
 * 每镜 TTS 旁白：配音导演先生成表演指导，再按指导合成语音。
 * TTS 失败不阻断管线（该镜以无声画面进时间线）。
 */

import * as path from "node:path";
import { fallbackVoiceDirection, narrationFor, type ScriptDoc } from "../prompts.ts";
import { appendSpan, ensureVoiceDirections, optionsOf, pushEvent, readArtifact, setStage, throwIfAborted, type StageCtx } from "../pipeline.ts";
import { ttsAdapterOf } from "../redo-adapters.ts";
import { trackMediaCost } from "../pricing.ts";

/** 配音阶段（独立 stage，每镜 TTS 旁白） */
export async function stageAudio(
	sc: StageCtx,
	script?: ScriptDoc,
): Promise<{ script: ScriptDoc; audioFiles: (string | null)[] }> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	setStage(run, "audio", "running", 0);
	pushEvent(
		run,
		"sound",
		"editor",
		"status",
		`声音设计开工：配音导演逐镜撰写表演指导，按 ${opts.promptLanguage === "en" ? "英文" : "中文"}旁白录制有情绪起伏的 TTS。`,
	);
	const directions = await ensureVoiceDirections(sc, scriptDoc);
	const audioFiles: (string | null)[] = [];
	for (const [i, shot] of scriptDoc.shots.entries()) {
		throwIfAborted(signal);
		const text = narrationFor(shot, opts.promptLanguage).trim();
		if (!text) {
			audioFiles.push(null);
			setStage(run, "audio", "running", Math.round(((i + 1) / scriptDoc.shots.length) * 100));
			continue;
		}
		const instruction = directions.get(shot.id) ?? fallbackVoiceDirection(run.brief);
		const t0 = Date.now();
		const job = sc.queue.submit(
			{
				roleName: "video-agent",
				kind: "tts",
				prompt: text,
				params: { instruction },
				outputName: `tts-${shot.id}`,
			},
			run.dir,
		);
		run.metrics.mediaCalls += 1;
		const finished = await sc.queue.awaitJob(job.id, undefined, signal).catch(() => null);
		const ok = finished?.status === "done" && finished.filePath;
		audioFiles.push(ok ? finished!.filePath! : null);
		// P2：TTS 成功时按 prompt 字符数计费
		if (ok) {
			const adapter = ttsAdapterOf(sc.ctx);
			if (adapter) trackMediaCost(run, sc.ctx, adapter, { prompt: text });
		}
		appendSpan(
			run,
			{
				stage: "audio",
				name: `镜头 ${shot.id} 配音`,
				kind: "media",
				status: ok ? "ok" : "error",
				input: `[指导] ${instruction.slice(0, 60)}｜${text.slice(0, 80)}`,
				output: ok ? path.basename(finished!.filePath!) : "TTS 失败",
			},
			t0,
		);
		if (ok) {
			pushEvent(
				run,
				"sound",
				"editor",
				"status",
				`旁白录制完成 ✅ 镜头 ${shot.id}（指导：${instruction.slice(0, 30)}…）`,
				{ stage: "post", focus: shot.id, label: "试听配音" },
			);
		} else {
			pushEvent(run, "sound", "producer", "status", `旁白录制失败 ⚠️ 镜头 ${shot.id}（该镜将以无声画面进时间线）。`, {
				stage: "post",
				focus: shot.id,
				label: "查看该镜",
			});
		}
		setStage(run, "audio", "running", Math.round(((i + 1) / scriptDoc.shots.length) * 100));
	}
	setStage(run, "audio", "done", 100);
	const ttsOk = audioFiles.filter((f) => f !== null).length;
	pushEvent(
		run,
		"sound",
		"editor",
		"handoff",
		`旁白轨交付：${ttsOk}/${audioFiles.length} 条 TTS 就绪（逐镜带表演指导），音量层级 旁白＞音效＞BGM。`,
	);
	return { script: scriptDoc, audioFiles };
}
