/**
 * prepareDialogueAudio —— 台词镜的音频驱动链（A2 · 六步链路的 1–3 步）。
 *
 * 台词是"驱动源"而非贴片：视频提交前必须先拿到托管好的公开音频 URL——
 * 2.5-flash 的 `audios` 参数要求公开可访问的 URL（StepFun TTS 只返回二进制）。
 *
 * 链路：TTS（按角色 voiceId）→ ffprobe 实测 → pausesSec 插停顿 → CloudBase 托管。
 * 音色跨镜头稳定靠 voiceId 绑定（3.2 台词"更严格"清单），重做时 audioUrl 可复用免重传。
 *
 * 降级链（3.3，延续"TTS 失败不阻断"的好传统）：
 *   - TTS 失败            → { kind: "silent" }    该镜降无声画面（视频照常生成）
 *   - 托管失败 / 未配置凭据 → { kind: "narration" }  台词回填旁白字段，先出视频后贴音（口型不对但成片能看）
 * 降级只返回意向，script（audioMode / narrationZh 回填）由调用方（stageClips）统一改写——
 * 本模块只管媒体链，脚本状态归 stage 所有（单一写者）。
 */

import * as path from "node:path";
import { appendSpan, optionsOf, pushEvent, type StageCtx } from "../pipeline.ts";
import { ttsAdapterOf } from "../redo-adapters.ts";
import { trackMediaCost } from "../pricing.ts";
import { insertPauses, probeDuration } from "../ffmpeg.ts";
import { hostAudioFile, isAudioUrlAlive } from "../hosting/tcb.ts";
import type { ScriptShot } from "../prompts.ts";

export type DialogueAudioOutcome =
	| { kind: "ready"; audioUrl: string; audioDurationSec?: number }
	| { kind: "silent"; reason: string }
	| { kind: "narration"; reason: string };

/** 台词镜的音频驱动链入口。调用方保证 shot 是 dialogue 镜（含 dialogue 子结构）。 */
export async function prepareDialogueAudio(sc: StageCtx, shot: ScriptShot): Promise<DialogueAudioOutcome> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	const dialogue = shot.dialogue!;
	const t0 = Date.now();
	const stage = "clips";

	// 0. 复用：audioUrl 已存在且匿名可达 → 免重传（重做路径的核心省钱点）
	if (dialogue.audioUrl && (await isAudioUrlAlive(dialogue.audioUrl).catch(() => false))) {
		pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 台词音频复用已有托管 URL（免重传）。`);
		return { kind: "ready", audioUrl: dialogue.audioUrl, audioDurationSec: dialogue.audioDurationSec };
	}

	// 1. TTS：按角色音色合成（voiceId 绑定共创角色卡片；缺省回落适配器默认音色）
	const lang = opts.promptLanguage === "en" ? "en" : "zh";
	const text = (dialogue.lines[lang] || dialogue.lines.zh || dialogue.lines.en || "").trim();
	if (!text) {
		return { kind: "silent", reason: "台词文本为空" };
	}
	const paceText = dialogue.pace && dialogue.pace !== "normal" ? `，语速${dialogue.pace === "slow" ? "放慢" : "加快"}` : "";
	const instruction = [dialogue.emotion ?? "", paceText].filter(Boolean).join("");
	const voiceParams = dialogue.voiceId ? { voice: dialogue.voiceId } : {};
	const ttsJob = sc.queue.submit(
		{
			roleName: "video-agent",
			kind: "tts",
			prompt: text,
			params: { instruction, ...voiceParams },
			outputName: `tts-dialogue-${shot.id}`,
		},
		run.dir,
	);
	run.metrics.mediaCalls += 1;
	const ttsDone = await sc.queue.awaitJob(ttsJob.id, undefined, signal).catch(() => null);
	const ttsOk = ttsDone?.status === "done" && ttsDone.filePath;
	if (!ttsOk) {
		appendSpan(run, { stage, name: `镜头 ${shot.id} 台词 TTS`, kind: "media", status: "error", output: `队列状态 ${ttsDone?.status ?? "unknown"}` }, t0);
		return { kind: "silent", reason: "TTS 合成失败" };
	}
	const adapter = ttsAdapterOf(sc.ctx);
	if (adapter) trackMediaCost(run, sc.ctx, adapter, { prompt: text });
	const ttsRel = path.relative(run.dir, ttsDone.filePath!);

	// 2. ffprobe 实测 + 3. pausesSec 插停顿（探测失败 → 跳过停顿直接用原音频）
	let srcRel = ttsRel;
	let durationSec = await probeDuration(ttsRel, run.dir);
	if (durationSec === null) durationSec = opts.clipDurationSec;
	const pauses = (dialogue.pausesSec ?? []).filter((p) => Number.isFinite(p) && p > 0);
	if (pauses.length > 0) {
		const pacedRel = `assets/tts-dialogue-${shot.id}-paced.mp3`;
		try {
			await insertPauses({ cwd: run.dir, inPath: ttsRel, outPath: pacedRel, totalSec: durationSec, pausesSec: pauses, signal });
			const pacedDur = await probeDuration(pacedRel, run.dir);
			if (pacedDur !== null) {
				srcRel = pacedRel;
				durationSec = pacedDur;
			}
		} catch {
			pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 停顿插入失败，使用原台词音频继续。`);
		}
	}
	dialogue.audioDurationSec = durationSec;

	// 4. CloudBase 托管 → 公开 URL（未配置凭据/上传失败 → 降级 narration）
	let audioUrl: string;
	try {
		audioUrl = await hostAudioFile(sc.ctx.studioRoot, run.id, shot.id, path.join(run.dir, srcRel));
	} catch (error) {
		appendSpan(
			run,
			{ stage, name: `镜头 ${shot.id} 台词托管`, kind: "media", status: "error", output: String(error).slice(0, 160) },
			t0,
		);
		return { kind: "narration", reason: `托管失败：${String(error).slice(0, 120)}` };
	}
	dialogue.audioUrl = audioUrl;
	appendSpan(
		run,
		{
			stage,
			name: `镜头 ${shot.id} 台词音频`,
			kind: "media",
			status: "ok",
			input: `[voice=${dialogue.voiceId ?? "默认"}] ${text.slice(0, 60)}`,
			output: `${path.basename(srcRel)}（${durationSec.toFixed(1)}s → 托管）`,
		},
		t0,
	);
	pushEvent(
		run,
		"sound",
		"editor",
		"status",
		`镜头 ${shot.id} 台词音频就绪 ✅（${durationSec.toFixed(1)}s，已托管，将驱动口型生成）。`,
		{ stage: "generate", focus: shot.id, label: "试听台词" },
	);
	return { kind: "ready", audioUrl, audioDurationSec: durationSec };
}
