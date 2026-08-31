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
import { withVersionedAsset, fileDataUrl } from "../asset-version.ts";
import { dialogueDerivedSec, estimateClipSeconds, ttsAdapterOf, videoAdapterOf, videoSubmitParams, videoSubmitParamsForDialogue, withReferenceAudioInstruction } from "../redo-adapters.ts";
import { trackMediaCost } from "../pricing.ts";
import { fallbackVoiceDirection, narrationFor, rettsDialogueMessages, rettsNarrationMessages } from "../prompts.ts";
import { prepareDialogueAudio } from "../stages/dialogue-audio.ts";
import { reserveShotQuota } from "../stages/clips.ts";
import { probeDuration } from "../ffmpeg.ts";
import { MAX_RETTS_PER_SHOT, appendSpan, computeQaRegressionText, executeStages, availableVoices, optionsOf, persistRun, pushEvent, pushLastAction, readArtifact, readKeyframes, resolveVoice, setStage, snapshotShotVerdict, stage, writeJson, } from "../pipeline.ts";
import { narratorVoiceFor } from "../voice-cast.ts";
import { referenceFollows } from "../qa/audio-follow.ts";
import { referenceIntelligible } from "../qa/asr-check.ts";
/**
 * 旁白重录（语音级重做）
 * 护栏：每镜上限 MAX_RETTS_PER_SHOT；生成失败自动回滚旧录音。
 * A5：台词镜（audioMode=dialogue）走级联重做——台词音频链 + 口型视频重生成，
 * 复用 withVersionedAsset（D2）与 reserveShotQuota（配额护栏），见 rettsDialogueCascade。
 */
export async function rettsRun(ctx, run, shotId, instruction, voice) {
    const explicitVoice = resolveVoice(ctx, voice);
    const prevStatus = run.status;
    if (prevStatus === "running")
        return { ok: false, error: "管线运行中，请稍候" };
    // 同步占位：在首个 await 前进入运行态，消除双提交竞态窗口；校验失败恢复原状态
    run.status = "running";
    const bail = (error) => {
        run.status = prevStatus;
        return { ok: false, error };
    };
    if (stage(run, "audio").status !== "done")
        return bail("配音尚未完成，无法重录旁白");
    let script;
    try {
        script = await readArtifact(run, "script.json");
    }
    catch {
        return bail("剧本产物缺失，无法定位镜头");
    }
    const shot = script.shots.find((s) => s.id === shotId);
    if (!shot)
        return bail(`镜头 ${shotId} 不存在`);
    const isDialogueShot = shot.audioMode === "dialogue" && Boolean(shot.dialogue);
    if (isDialogueShot && optionsOf(run).audioDrive !== "dialogue") {
        return bail(`镜头 ${shotId} 是台词镜，但本次运行未开启音频驱动，无法重录台词。请改用补拍（reshot），或开启音频驱动后整体重跑。`);
    }
    if (!isDialogueShot) {
        const narration = narrationFor(shot, optionsOf(run).promptLanguage).trim();
        if (!narration)
            return bail(`镜头 ${shotId} 无旁白，无需重录`);
    }
    const attempts = (run.ttsAttempts[shotId] ?? 0) + 1;
    if (attempts > MAX_RETTS_PER_SHOT) {
        return bail(`镜头 ${shotId} 旁白已重录 ${MAX_RETTS_PER_SHOT} 次达上限。建议在「剧本」阶段微调后整体重跑。`);
    }
    run.ttsAttempts[shotId] = attempts;
    // P2+派发后回灌：动作前快照 verdict，retts 后 audioSync 可能有变化
    const beforeSnapshot = snapshotShotVerdict(run, shotId);
    // 指令解析：改写文案（copy-edit）或纯表演指导（voice-only）
    let scriptUpdated = false;
    if (instruction.trim()) {
        const t0 = Date.now();
        try {
            if (isDialogueShot) {
                const parsed = await chatJson(ctx.llm, rettsDialogueMessages(shot, instruction.trim(), optionsOf(run)));
                const mode = parsed.mode === "copy-edit" ? "copy-edit" : "voice-only";
                const newInstruction = typeof parsed.instruction === "string" ? parsed.instruction.trim().slice(0, 200) : "";
                if (mode === "copy-edit" && shot.dialogue) {
                    const zh = typeof parsed.linesZh === "string" ? parsed.linesZh.trim() : "";
                    const en = typeof parsed.linesEn === "string" ? parsed.linesEn.trim() : "";
                    if (zh && zh !== shot.dialogue.lines.zh) {
                        shot.dialogue.lines.zh = zh.slice(0, 400);
                        scriptUpdated = true;
                    }
                    if (en && en !== shot.dialogue.lines.en) {
                        shot.dialogue.lines.en = en.slice(0, 400);
                        scriptUpdated = true;
                    }
                }
                if (newInstruction && newInstruction !== shot.ttsDirection) {
                    shot.ttsDirection = newInstruction;
                    scriptUpdated = true;
                }
            }
            else {
                const parsed = await chatJson(ctx.llm, rettsNarrationMessages(shot, instruction.trim(), optionsOf(run)));
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
            }
        }
        catch {
            // 解析失败：忽略，沿用原文案与指导
        }
    }
    pushEvent(run, "producer", "sound", "user", `请求重录镜头 ${shotId}${isDialogueShot ? "台词（含口型重生成）" : "旁白"}${instruction ? `：${instruction}` : "（原文重录）"}`);
    pushEvent(run, "director", "sound", "redo", isDialogueShot
        ? `安排重录镜头 ${shotId} 台词（第 ${attempts}/${MAX_RETTS_PER_SHOT} 轮）${scriptUpdated ? "，台词已按指令调整" : ""}。台词是口型驱动源：新音频就位后将重新托管并重生成该镜口型视频（配额内），再重排混音复审。`
        : `安排重录镜头 ${shotId} 旁白（第 ${attempts}/${MAX_RETTS_PER_SHOT} 轮）${scriptUpdated ? "，文案已按指令调整" : ""}。旧录音备份为历史版本，新语音就位后该镜按新时长重排、重新混音并复审。`);
    // 回退导出态，进入运行
    setStage(run, "export", "pending", 0);
    run.verdict = undefined;
    run.videoUrl = undefined;
    run.status = "running";
    run.redoActive = { kind: "retts", shotId, label: isDialogueShot ? `重录 ${shotId} 台词` : `重录 ${shotId} 旁白` };
    persistRun(run);
    void (async () => {
        const queue = new GenerationQueue(ctx.mediaConfig);
        const sc = { run, ctx, queue, signal: run.abort.signal };
        // 台词镜级联前的脚本快照：片段重生成失败时回滚台词回写，保持脚本与旧片段一致
        const prevDialogue = isDialogueShot && shot.dialogue
            ? {
                audioMode: shot.audioMode,
                durationSec: shot.durationSec,
                audioUrl: shot.dialogue.audioUrl,
                audioDurationSec: shot.dialogue.audioDurationSec,
                narrationZh: shot.narrationZh,
                narrationEn: shot.narrationEn,
            }
            : null;
        try {
            if (isDialogueShot && shot.dialogue) {
                await rettsDialogueCascade(sc, script, shot, attempts);
            }
            else {
                // 旁白重录沿用配音选角的旁白音色（显式 voice 参数优先）——否则又会回落默认音色与角色撞声
                const narratorFallback = narratorVoiceFor(availableVoices(ctx), script.shots.map((sh) => sh.dialogue?.voiceId));
                await rettsNarration(sc, shot, explicitVoice ?? narratorFallback);
            }
            // 3. 新音频就位：重跑 export（重新归一化该镜 → 时长随旁白重排 → 装配 → 复审）
            pushEvent(run, "sound", "editor", "handoff", isDialogueShot
                ? `镜头 ${shotId} 新台词就位 ✅，口型视频已按新音频重生成。剪辑师重排该镜、重装时间线并重新混音，随后复审。`
                : `镜头 ${shotId} 新旁白就位 ✅（旧录音备份为 ${run.ttsVersions[shotId]?.[run.ttsVersions[shotId].length - 1] ?? "无"}）。剪辑师按新时长重排该镜、重装时间线并重新混音，随后复审。`, { stage: "post", focus: shotId, label: isDialogueShot ? "查看新口型" : "试听新配音" });
            await executeStages(ctx, run, ["export"], { fromResume: true });
            run.redoActive = null;
            pushLastAction(run, {
                kind: "retts",
                shotId,
                label: isDialogueShot ? `重录 ${shotId} 台词` : `重录 ${shotId} 旁白`,
                at: new Date().toISOString(),
            });
            persistRun(run);
            // P2+派发后回灌：配音重录可能影响 textQuality 轴（字幕/咬字对齐）
            const afterSnapshot = snapshotShotVerdict(run, shotId);
            const deltaText = computeQaRegressionText(shotId, beforeSnapshot, afterSnapshot);
            if (deltaText) {
                pushEvent(run, "sound", "client", "redo", deltaText, { stage: "post", focus: shotId });
            }
        }
        catch (error) {
            // 台词级联中途失败：回滚台词回写，让脚本与（已回滚的）旧片段保持一致
            if (prevDialogue && shot.dialogue) {
                shot.audioMode = prevDialogue.audioMode;
                shot.durationSec = prevDialogue.durationSec;
                shot.dialogue.audioUrl = prevDialogue.audioUrl;
                shot.dialogue.audioDurationSec = prevDialogue.audioDurationSec;
                shot.narrationZh = prevDialogue.narrationZh;
                shot.narrationEn = prevDialogue.narrationEn;
                await writeJson(run, "script.json", script).catch(() => { });
            }
            if (sc.signal.aborted) {
                run.status = "cancelled";
                run.redoActive = null;
                persistRun(run);
                return;
            }
            const current = run.stages.find((s) => s.status === "running");
            if (current)
                current.status = "failed";
            run.status = "failed";
            run.error = error instanceof Error ? error.message : String(error);
            run.redoActive = null;
            pushEvent(run, "sound", "producer", "status", `${isDialogueShot ? "台词重录" : "旁白重录"}受阻 ⚠️：${run.error}`);
            persistRun(run);
        }
    })();
    return { ok: true };
}
/**
 * 旁白镜重录（既有路径抽出）：版本化备份旧 TTS → 重录 → 计费。
 * 台词镜不走这里（口型绑定音频，必须级联重生成视频，见 rettsDialogueCascade）。
 */
async function rettsNarration(sc, shot, resolvedVoice) {
    const { run, ctx } = sc;
    const narration = narrationFor(shot, optionsOf(run).promptLanguage).trim();
    // 1. 备份现有 TTS（版本化：tts-SHxx_v{n}.mp3）
    run.ttsVersions[shot.id] = run.ttsVersions[shot.id] ?? [];
    const versions = run.ttsVersions[shot.id];
    const voiceDirection = shot.ttsDirection ?? fallbackVoiceDirection(run.brief);
    const { file: okRel } = await withVersionedAsset({
        run,
        mainRelPath: `assets/tts-${shot.id}.mp3`,
        versions,
        backupRelPath: `assets/tts-${shot.id}_v${versions.length + 1}.mp3`,
        generate: async () => {
            const job = sc.queue.submit({
                roleName: "video-agent",
                kind: "tts",
                prompt: narration,
                params: { instruction: voiceDirection, ...(resolvedVoice ? { voice: resolvedVoice } : {}) },
                outputName: `tts-${shot.id}`,
            }, run.dir);
            run.metrics.mediaCalls += 1;
            const finished = await sc.queue.awaitJob(job.id, undefined, sc.signal);
            return finished.status === "done" && finished.filePath
                ? path.relative(run.dir, finished.filePath)
                : null;
        },
    });
    const ok = Boolean(okRel);
    // P2：旁白重录成功后按 prompt 字符数计费
    if (ok) {
        const adapter = ttsAdapterOf(sc.ctx);
        if (adapter)
            trackMediaCost(run, sc.ctx, adapter, { prompt: narration });
    }
    appendSpan(run, {
        stage: "reshot",
        name: `镜头 ${shot.id} 旁白重录`,
        kind: "media",
        status: ok ? "ok" : "error",
        input: narration.slice(0, 120),
        output: ok ? path.basename(okRel) : `队列状态 error`,
    }, Date.now());
    if (!ok) {
        // withVersionedAsset 已自动回滚（还有可重试机会、版本数 PUSH/POP 原子）。
        pushEvent(run, "sound", "producer", "redo", `镜头 ${shot.id} 旁白重录失败 ⚠️，已恢复旧录音。可稍后重试。`);
        throw new Error(`镜头 ${shot.id} 旁白重录失败（旧版本已回滚）`);
    }
}
/**
 * A5 台词镜级联重做：台词是口型驱动源——重录台词后必须重生成口型视频。
 * 1. 台词音频链（复用 A2 prepareDialogueAudio：TTS→实测→停顿→超短超长对齐→托管→回写）；
 * 2. 口型视频重生成（withVersionedAsset 版本化 clip；配额走 reserveShotQuota，
 *    幂等键命名空间 `${shotId}-retts{n}` 与管线/补拍隔离）；
 * 3. reference 失败 → 降级普通图生视频（台词转旁白），再失败 → 文生视频（同 clips 降级链）。
 * 失败时 withVersionedAsset 自动回滚旧片段；调用方负责回滚脚本回写与运行态。
 */
async function rettsDialogueCascade(sc, script, shot, attempts) {
    const { run, ctx } = sc;
    const opts = optionsOf(run);
    // ---- 1. 台词音频链（TTS→实测→停顿→对齐→托管→dialogue 回写）----
    const outcome = await prepareDialogueAudio(sc, shot);
    if (outcome.kind === "silent") {
        throw new Error(`镜头 ${shot.id} 台词 TTS 失败（${outcome.reason}）——旧台词音频与片段未改动，可稍后重试`);
    }
    let useReference = outcome.kind === "ready";
    const audioUrl = outcome.kind === "ready" ? outcome.audioUrl : null;
    if (outcome.kind === "narration") {
        // 托管失败：降旁白（与 clips 台词分支同语义），视频按普通路径重生成
        shot.audioMode = "narration";
        if (!shot.narrationZh)
            shot.narrationZh = shot.dialogue.lines.zh;
        if (!shot.narrationEn)
            shot.narrationEn = shot.dialogue.lines.en;
        pushEvent(run, "sound", "producer", "redo", `镜头 ${shot.id} 台词托管失败 ⚠️（${outcome.reason}），重录降级为旁白：视频按普通路径重生成，台词按画外音贴上。`);
    }
    else if (typeof outcome.audioDurationSec === "number" && outcome.audioDurationSec > 0) {
        // A4b：以音频反推镜长（与 clips 台词分支同一推导），reference 提交读同一份
        const derived = dialogueDerivedSec(outcome.audioDurationSec);
        if (derived !== shot.durationSec) {
            shot.durationSec = derived;
            pushEvent(run, "sound", "producer", "redo", `镜头 ${shot.id} 镜长按新台词音频反推为 ${derived}s（实测 ${outcome.audioDurationSec.toFixed(1)}s）。`);
        }
    }
    if (outcome.kind === "ready" && outcome.wordTimestamps && shot.dialogue) {
        shot.dialogue.wordTimestamps = outcome.wordTimestamps;
    }
    // 台词回写落盘（audio/export 阶段与重试读同一份）
    await writeJson(run, "script.json", script);
    // ---- 2. 口型视频重生成（版本化 + 配额）----
    const promptArtifact = await readArtifact(run, "prompts.json").catch(() => ({ prompts: [] }));
    const basePrompt = promptArtifact.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual;
    const keyframes = await readKeyframes(run).catch(() => ({ frames: [] }));
    const kf = keyframes.frames.find((f) => f.shotId === shot.id);
    // 无条件读关键帧：reference 失败降级 i2v 时需要它做首帧锚定（与 clips 先备帧后提交同思路）
    const kfDataUrl = kf?.status === "done" && kf.file ? await fileDataUrl(run.dir, kf.file) : null;
    const prompt = useReference ? withReferenceAudioInstruction(basePrompt) : basePrompt;
    const estimateSec = estimateClipSeconds(ctx, opts, shot.durationSec);
    // 幂等键命名空间隔离：管线阶段用 `${runId}:${shotId}:a{n}`，这里带 retts 轮次，
    // 避免与管线 attempt / 多轮 retts 撞键（撞键会被账本去重，settle 语义错乱）
    const shotKey = `${shot.id}-retts${attempts}`;
    let reservation = await reserveShotQuota(sc, shotKey, estimateSec, 0);
    if (!reservation) {
        pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 台词重生成配额不足（预估 ${estimateSec}s/镜），已保留新台词音频，旧片段未动。`);
        throw new Error(`镜头 ${shot.id} 口型视频重生成配额不足（旧版本未改动）`);
    }
    run.shotVersions[shot.id] = run.shotVersions[shot.id] ?? [];
    const versions = run.shotVersions[shot.id];
    let attemptSeq = 0;
    const { file: okRel } = await withVersionedAsset({
        run,
        mainRelPath: `assets/clip-${shot.id}.mp4`,
        versions,
        backupRelPath: `assets/clip-${shot.id}_v${versions.length + 1}.mp4`,
        generate: async () => {
            if (useReference) {
                const referenceParams = videoSubmitParamsForDialogue(ctx, audioUrl, shot.durationSec);
                if (referenceParams) {
                    const job = sc.queue.submit({ roleName: "video-agent", kind: "video", prompt, params: referenceParams, outputName: `clip-${shot.id}`, adapterId: reservation?.adapterId }, run.dir);
                    run.metrics.mediaCalls += 1;
                    const finished = await sc.queue.awaitJob(job.id, undefined, sc.signal);
                    if (finished.status === "done" && finished.filePath) {
                        // 台词跟读校验（与 clips 主链同款双关卡防线）：自行配音不可懂 → dubOver
                        const refLocal = outcome.kind === "ready" ? outcome.localAudioRelPath : undefined;
                        if (!refLocal)
                            return path.relative(run.dir, finished.filePath);
                        const check = await referenceFollows(run.dir, path.relative(run.dir, finished.filePath), refLocal, sc.signal);
                        let follows = check.follows;
                        if (follows && shot.dialogue?.lines.zh) {
                            const asr = await referenceIntelligible(run.dir, path.relative(run.dir, finished.filePath), shot.dialogue.lines.zh, {
                                apiKey: sc.ctx.llm.apiKey ?? "",
                                signal: sc.signal,
                            }).catch(() => null);
                            if (asr)
                                follows = asr.intelligible;
                        }
                        if (follows)
                            return path.relative(run.dir, finished.filePath);
                        pushEvent(run, "tech", "producer", "redo", `镜头 ${shot.id} 台词跟读未过关——口型视频保留，音轨改用 TTS 原声配音（dubOver）。`);
                        shot.dialogue = { ...shot.dialogue, dubOver: true };
                        // 跟读未过：片已真实生成（供应商已消耗）→ 按预留结算，不虚退
                        if (sc.ctx.quota && reservation.reservationId)
                            sc.ctx.quota.settle(reservation.reservationId, estimateSec);
                        return path.relative(run.dir, finished.filePath);
                    }
                    else {
                        // reference 失败 → 降级普通图生视频（新 attempt 新预留），台词转旁白
                        if (sc.ctx.quota && reservation.reservationId)
                            sc.ctx.quota.release(reservation.reservationId);
                    }
                    shot.audioMode = "narration";
                    if (!shot.narrationZh)
                        shot.narrationZh = shot.dialogue.lines.zh;
                    if (!shot.narrationEn)
                        shot.narrationEn = shot.dialogue.lines.en;
                    attemptSeq += 1;
                    pushEvent(run, "tech", "producer", "redo", `镜头 ${shot.id} 口型重生成未成功，降级为普通图生视频，台词转旁白轨。`);
                    reservation = await reserveShotQuota(sc, shotKey, estimateSec, attemptSeq);
                    if (!reservation)
                        return null;
                }
            }
            // 普通图生视频（降级路径或托管失败路径；kfDataUrl 可能为 null → 直接文生）
            const i2vJob = sc.queue.submit({
                roleName: "video-agent",
                kind: "video",
                // 多 key 并发：任务投给预留所在池绑定的 adapter（不传则走默认解析）
                adapterId: reservation?.adapterId,
                prompt,
                params: videoSubmitParams(ctx, opts, 0, 0, kfDataUrl, shot.durationSec),
                outputName: `clip-${shot.id}`,
            }, run.dir);
            run.metrics.mediaCalls += 1;
            const i2v = await sc.queue.awaitJob(i2vJob.id, undefined, sc.signal);
            if (i2v.status === "done" && i2v.filePath)
                return path.relative(run.dir, i2v.filePath);
            if (!kfDataUrl)
                return null; // 已是文生路径，无进一步降级
            // 图生视频失败：退还预留，降级文生视频重新预留
            if (sc.ctx.quota && reservation.reservationId)
                sc.ctx.quota.release(reservation.reservationId);
            attemptSeq += 1;
            reservation = await reserveShotQuota(sc, shotKey, estimateSec, attemptSeq);
            if (!reservation)
                return null;
            const t2vJob = sc.queue.submit({
                roleName: "video-agent",
                kind: "video",
                // 多 key 并发：任务投给预留所在池绑定的 adapter（不传则走默认解析）
                adapterId: reservation?.adapterId,
                prompt,
                params: videoSubmitParams(ctx, opts, 0, 0, null, shot.durationSec),
                outputName: `clip-${shot.id}`,
            }, run.dir);
            run.metrics.mediaCalls += 1;
            const t2v = await sc.queue.awaitJob(t2vJob.id, undefined, sc.signal);
            return t2v.status === "done" && t2v.filePath ? path.relative(run.dir, t2v.filePath) : null;
        },
    });
    const ok = Boolean(okRel);
    // P2：重生成成功按实际时长计费 + 配额结算；失败退还预留
    if (ok && okRel) {
        try {
            const dur = await probeDuration(okRel, run.dir);
            const adapter = videoAdapterOf(ctx);
            if (adapter)
                trackMediaCost(run, ctx, adapter, {}, dur ?? estimateSec);
            if (ctx.quota && reservation.reservationId)
                ctx.quota.settle(reservation.reservationId, dur ?? estimateSec);
        }
        catch {
            const adapter = videoAdapterOf(ctx);
            if (adapter)
                trackMediaCost(run, ctx, adapter, {}, estimateSec);
            if (ctx.quota && reservation.reservationId)
                ctx.quota.settle(reservation.reservationId, estimateSec);
        }
    }
    else if (ctx.quota && reservation.reservationId) {
        ctx.quota.release(reservation.reservationId);
    }
    // 重生成可能改写了 audioMode（reference 失败降旁白）——再落一次盘，
    // 让 export 与重试读到与片段一致的脚本（上面那次写盘在降级之前）
    await writeJson(run, "script.json", script);
    appendSpan(run, {
        stage: "reshot",
        name: `镜头 ${shot.id} 台词口型重生成（第 ${attempts} 轮）`,
        kind: "media",
        status: ok ? "ok" : "error",
        input: prompt.slice(0, 120),
        output: ok ? path.basename(okRel) : `队列状态 error`,
    }, Date.now());
    if (!ok) {
        pushEvent(run, "sound", "producer", "redo", `镜头 ${shot.id} 口型视频重生成失败 ⚠️，已恢复旧版本。可稍后重试。`);
        throw new Error(`镜头 ${shot.id} 口型视频重生成失败（旧版本已回滚）`);
    }
}
