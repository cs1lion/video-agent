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
import * as fs from "node:fs";
import { appendSpan, optionsOf, pushEvent } from "../pipeline.ts";
import { ttsAdapterOf } from "../redo-adapters.ts";
import { trackMediaCost } from "../pricing.ts";
import { chatJson } from "../llm.ts";
import { insertPauses, padTailToSec, probeDuration } from "../ffmpeg.ts";
import { dialogueCondenseMessages } from "../prompts.ts";
import { hostAudioFile, isAudioUrlAlive } from "../hosting/tcb.ts";
/** 超长判定容差（秒）：镜长 +0.2s 以内不折腾（LLM 精简成本 > 0.2s 尾段轻微越界的观感损失） */
const OVERSHOOT_TOLERANCE_SEC = 0.2;
/** 台词镜的音频驱动链入口。调用方保证 shot 是 dialogue 镜（含 dialogue 子结构）。 */
export async function prepareDialogueAudio(sc, shot) {
    const { run, signal } = sc;
    const opts = optionsOf(run);
    const dialogue = shot.dialogue;
    const t0 = Date.now();
    const stage = "clips";
    // 0. 复用：audioUrl 已存在且匿名可达 → 免重传（重做路径的核心省钱点）
    if (dialogue.audioUrl && (await isAudioUrlAlive(dialogue.audioUrl).catch(() => false))) {
        pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 台词音频复用已有托管 URL（免重传）。`);
        // 本地参考音频若还在，供跟读校验用（旧 run 找不到也不影响主链）
        const localAudioRelPath = `assets/tts-dialogue-${shot.id}.mp3`;
        const processedAudioRelPath = [`assets/tts-dialogue-${shot.id}-pad.mp3`, `assets/tts-dialogue-${shot.id}-paced.mp3`].find((rel) => fs.existsSync(path.join(run.dir, rel)));
        return {
            kind: "ready",
            audioUrl: dialogue.audioUrl,
            audioDurationSec: dialogue.audioDurationSec,
            ...(fs.existsSync(path.join(run.dir, localAudioRelPath)) ? { localAudioRelPath } : {}),
            ...(processedAudioRelPath ? { processedAudioRelPath } : {}),
        };
    }
    // 1. TTS：按角色音色合成（voiceId 绑定共创角色卡片；缺省回落适配器默认音色）
    const lang = opts.promptLanguage === "en" ? "en" : "zh";
    const text = (dialogue.lines[lang] || dialogue.lines.zh || dialogue.lines.en || "").trim();
    if (!text) {
        return { kind: "silent", reason: "台词文本为空" };
    }
    const paceText = dialogue.pace && dialogue.pace !== "normal" ? `，语速${dialogue.pace === "slow" ? "放慢" : "加快"}` : "";
    // 表演指导带人物设计（stepaudio-2.5-tts 的 instruction 控制全局人设与情绪基调，
    // ≤200 字——让声线气质跟着角色设定走，而不是只给情绪词）
    const characterDesign = (run.brief.coSpace?.characters ?? []).find((c) => c.name === dialogue.characterId)?.description;
    const instruction = [
        characterDesign ? `角色：${characterDesign}。` : "",
        dialogue.emotion ? `情绪：${dialogue.emotion}。` : "",
        paceText,
    ]
        .filter(Boolean)
        .join("")
        .slice(0, 200);
    const voiceParams = dialogue.voiceId ? { voice: dialogue.voiceId } : {};
    // TTS 参数利用（实测 speed 有效：同文本 1.3 倍速字节数 -15%）：pace → speed
    const ttsSpeed = dialogue.pace === "slow" ? 0.85 : dialogue.pace === "fast" ? 1.2 : undefined;
    const pauses = (dialogue.pausesSec ?? []).filter((p) => Number.isFinite(p) && p > 0);
    const targetSec = opts.clipDurationSec;
    const adapter = ttsAdapterOf(sc.ctx);
    /** TTS → 实测 → 插停顿。返回 null = TTS 失败（调用方降 silent）。tag 用于重试产物命名。 */
    const synthesizeToPaced = async (speechText, tag) => {
        const job = sc.queue.submit({
            roleName: "video-agent",
            kind: "tts",
            prompt: speechText,
            params: { instruction, ...(ttsSpeed ? { speed: ttsSpeed } : {}), ...voiceParams },
            outputName: `tts-dialogue-${shot.id}${tag}`,
        }, run.dir);
        run.metrics.mediaCalls += 1;
        const done = await sc.queue.awaitJob(job.id, undefined, signal).catch(() => null);
        if (!(done?.status === "done" && done.filePath)) {
            appendSpan(run, { stage, name: `镜头 ${shot.id} 台词 TTS${tag ? "（精简重录）" : ""}`, kind: "media", status: "error", output: `队列状态 ${done?.status ?? "unknown"}` }, t0);
            return null;
        }
        // 原始声 = TTS 直接产物（插停顿/垫尾之前的形态）——reference 提交链只用它
        const rawRel = path.relative(run.dir, done.filePath);
        if (adapter)
            trackMediaCost(run, sc.ctx, adapter, { prompt: speechText });
        const wordTimestamps = done.meta?.wordTimestamps?.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
        let srcRel = path.relative(run.dir, done.filePath);
        let durationSec = await probeDuration(srcRel, run.dir);
        if (durationSec === null)
            durationSec = targetSec;
        if (pauses.length > 0) {
            const pacedRel = `assets/tts-dialogue-${shot.id}${tag}-paced.mp3`;
            try {
                await insertPauses({ cwd: run.dir, inPath: srcRel, outPath: pacedRel, totalSec: durationSec, pausesSec: pauses, signal });
                const pacedDur = await probeDuration(pacedRel, run.dir);
                if (pacedDur !== null) {
                    srcRel = pacedRel;
                    durationSec = pacedDur;
                }
            }
            catch {
                pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 停顿插入失败，使用原台词音频继续。`);
            }
        }
        return { srcRel, durationSec, speechText, rawRel, wordTimestamps };
    };
    /** LLM 精简台词（A4 超长分支）。任何失败 → null（调用方接受原时长）。 */
    const condenseLine = async (speechText) => {
        const targetChars = Math.max(8, Math.floor(targetSec * 4));
        try {
            const parsed = await chatJson(sc.ctx.llm, dialogueCondenseMessages(shot.id, dialogue.lines.zh, dialogue.lines.en, targetChars), signal);
            const zh = typeof parsed.zh === "string" ? parsed.zh.trim() : "";
            const en = typeof parsed.en === "string" ? parsed.en.trim() : "";
            const condensed = lang === "en" ? en || zh : zh || en;
            if (!condensed || condensed === speechText)
                return null;
            return condensed;
        }
        catch {
            return null;
        }
    };
    let synth = await synthesizeToPaced(text, "");
    if (!synth)
        return { kind: "silent", reason: "TTS 合成失败" };
    // 3.5 A4 时长对齐·超长分支：台词 > 镜长 → LLM 精简重写 + 重录（一次机会；
    // 精简不可用/仍超长 → 接受并留痕——不硬裁，切在词中间比轻微越界更伤）。
    if (synth.durationSec > targetSec + OVERSHOOT_TOLERANCE_SEC) {
        const condensed = await condenseLine(synth.speechText);
        if (condensed) {
            pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 台词实测 ${synth.durationSec.toFixed(1)}s 超镜长 ${targetSec}s，已 LLM 精简重录。`);
            const retry = await synthesizeToPaced(condensed, "-r2");
            if (retry) {
                synth = retry;
                if (synth.durationSec > targetSec + OVERSHOOT_TOLERANCE_SEC) {
                    pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 精简重录后仍 ${synth.durationSec.toFixed(1)}s（> 镜长 ${targetSec}s），接受现有时长（尾段口型可能轻微越界）。`);
                }
            }
            else {
                pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 精简重录失败，使用首版台词音频继续。`);
            }
        }
        else {
            pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 台词超镜长且精简不可用，接受 ${synth.durationSec.toFixed(1)}s（尾段口型可能轻微越界）。`);
        }
    }
    // 3.6 A4 时长对齐·过短分支：尾部补静音到镜长（留白让口型自然闭合）
    // 原始人声时长（停顿后、垫尾前）先落袋——export 的镜头节奏用它，垫尾静音不进镜长
    dialogue.rawDurationSec = synth.durationSec;
    if (synth.durationSec < targetSec - 0.05) {
        const paddedRel = `assets/tts-dialogue-${shot.id}-pad.mp3`;
        try {
            const padded = await padTailToSec({
                cwd: run.dir,
                inPath: synth.srcRel,
                outPath: paddedRel,
                targetSec,
                inputSec: synth.durationSec,
                signal,
            });
            if (padded === "padded") {
                const paddedDur = await probeDuration(paddedRel, run.dir);
                synth = { ...synth, srcRel: paddedRel, durationSec: paddedDur ?? targetSec };
                pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 台词 ${synth.durationSec.toFixed(1)}s 短于镜长，尾部补静音到 ${targetSec}s。`);
            }
        }
        catch {
            pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 尾部补静音失败，使用原台词音频继续。`);
        }
    }
    const srcRel = synth.srcRel;
    const durationSec = synth.durationSec;
    const speechText = synth.speechText;
    dialogue.audioDurationSec = durationSec;
    // 4. CloudBase 托管 → 公开 URL（未配置凭据/上传失败 → 降级 narration）
    let audioUrl;
    try {
        audioUrl = await hostAudioFile(sc.ctx.studioRoot, run.id, shot.id, path.join(run.dir, synth.rawRel));
    }
    catch (error) {
        appendSpan(run, { stage, name: `镜头 ${shot.id} 台词托管`, kind: "media", status: "error", output: String(error).slice(0, 160) }, t0);
        return { kind: "narration", reason: `托管失败：${String(error).slice(0, 120)}` };
    }
    dialogue.audioUrl = audioUrl;
    appendSpan(run, {
        stage,
        name: `镜头 ${shot.id} 台词音频`,
        kind: "media",
        status: "ok",
        input: `[voice=${dialogue.voiceId ?? "默认"}] ${speechText.slice(0, 60)}`,
        output: `${path.basename(srcRel)}（${durationSec.toFixed(1)}s → 托管）`,
    }, t0);
    pushEvent(run, "sound", "editor", "status", `镜头 ${shot.id} 台词音频就绪 ✅（${durationSec.toFixed(1)}s，已托管，将驱动口型生成）。`, { stage: "generate", focus: shot.id, label: "试听台词" });
    return {
        kind: "ready",
        audioUrl,
        audioDurationSec: durationSec,
        localAudioRelPath: synth.rawRel,
        ...(synth.srcRel !== synth.rawRel ? { processedAudioRelPath: synth.srcRel } : {}),
        ...(synth.wordTimestamps && synth.wordTimestamps.length > 0 ? { wordTimestamps: synth.wordTimestamps } : {}),
    };
}
