/**
 * stageAudio —— 配音阶段。
 * 每镜 TTS 旁白：配音导演先生成表演指导，再按指导合成语音。
 * TTS 失败不阻断管线（该镜以无声画面进时间线）。
 */

import * as path from "node:path";
import { fallbackVoiceDirection, narrationFor, type ScriptDoc } from "../prompts.ts";
import { appendSpan, availableVoices, ensureVoiceDirections, optionsOf, pushEvent, readArtifact, readKeyframes, setStage, throwIfAborted, writeJson, type StageCtx } from "../pipeline.ts";
import { ttsAdapterOf } from "../redo-adapters.ts";
import { trackMediaCost } from "../pricing.ts";
import { assignCastVoices, narratorVoiceFor } from "../voice-cast.ts";

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
	// 配音选角：旁白音色必须避开全部角色已绑定的音色（否则旁白开场和人物开口一个声音）。
	// 角色音色在剧本阶段已按人物设计注入 dialogue.voiceId——这里读现成绑定算旁白位。
	const catalog = availableVoices(sc.ctx);
	const assignment = assignCastVoices(
		(run.brief.coSpace?.characters ?? []).map((c) => ({ name: c.name, description: c.description, voiceId: c.voiceId })),
		catalog,
	);
	const narratorVoiceId =
		assignment.narratorVoiceId ??
		// 兜底：共创卡缺角色时也按「避开台词镜绑定」选旁白位
		narratorVoiceFor(catalog, scriptDoc.shots.map((s) => s.dialogue?.voiceId));
	const idToLabel = new Map(Object.entries(catalog).map(([label, id]) => [id, label]));
	const narratorLabel = narratorVoiceId ? (idToLabel.get(narratorVoiceId) ?? narratorVoiceId) : "适配器默认";
	// 配音选角留痕（e2e 断言 + 运维排查的依据）
	await writeJson(run, "voice-cast.json", {
		narratorVoiceId,
		characters: assignment.byCharacter,
		notes: assignment.notes,
	});
	const castSummary = Object.entries(assignment.byCharacter)
		.map(([name, id]) => `${name}→${idToLabel.get(id) ?? id}`)
		.join("、");
	pushEvent(
		run,
		"sound",
		"editor",
		"status",
		`配音选角：旁白＝${narratorLabel}${castSummary ? `；角色 ${castSummary}` : ""}${assignment.notes.length ? `（注意：${assignment.notes[0]}）` : "；与角色声线全部错开"}。`,
	);
	const narratorParams = narratorVoiceId ? { voice: narratorVoiceId } : {};
	const directions = await ensureVoiceDirections(sc, scriptDoc);
	// 部分确认（闸门 B）：只为放行镜头烧 TTS；返回数组仍与全量脚本对齐
	// （export 按 scriptDoc.shots.indexOf 取音轨，索引空间不能变）。
	const keyframes = await readKeyframes(run);
	const confirmedIds = Array.isArray(keyframes.confirmedShotIds) ? new Set(keyframes.confirmedShotIds) : null;
	const audioFiles: (string | null)[] = [];
	for (const [i, shot] of scriptDoc.shots.entries()) {
		throwIfAborted(signal);
		const text = narrationFor(shot, opts.promptLanguage).trim();
		if (!text || (confirmedIds && !confirmedIds.has(shot.id))) {
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
				params: { instruction, ...narratorParams },
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
