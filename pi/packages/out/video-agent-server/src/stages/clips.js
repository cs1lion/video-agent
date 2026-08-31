/**
 * stageClips —— 镜头生成阶段（图生视频，含 i2v→t2v 退降）。
 * 逐镜提交视频队列：关键帧先行做首帧锚定（有关键帧则图生视频，失败退文生视频）。
 * 部分确认：只把用户放行的镜头交生成，未勾选镜头不消耗额度。
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { appendSpan, ensureKeyframe, optionsOf, pushEvent, readArtifact, readKeyframes, setStage, throwIfAborted, writeJson, } from "../pipeline.ts";
import { fileDataUrl } from "../asset-version.ts";
import { trackMediaCost } from "../pricing.ts";
import { probeDuration } from "../ffmpeg.ts";
import { dialogueDerivedSec, estimateClipSeconds, videoAdapterOf, videoSubmitParams, videoSubmitParamsForDialogue, withReferenceAudioInstruction } from "../redo-adapters.ts";
import { pixelDimensions } from "../../../video-agent/src/index.ts";
import { prepareDialogueAudio } from "./dialogue-audio.ts";
import { buildBudgetAlert, PRIORITY_QUEUE_VALUES } from "../director-contract.ts";
import { REFERENCE_FOLLOW_THRESHOLD, referenceFollows } from "../qa/audio-follow.ts";
import { referenceIntelligible } from "../qa/asr-check.ts";
import { readPriorityInstructions } from "../producer.ts";
/** 镜头生成阶段：图生视频（含 i2v→t2v 退降） */
export async function stageClips(sc, script) {
    const { run, signal } = sc;
    const opts = optionsOf(run);
    const scriptDoc = script ?? (await readArtifact(run, "script.json"));
    const shotPrompts = await readArtifact(run, "prompts.json");
    const bible = await readArtifact(run, "visual-bible.json").catch(() => ({ styleKeywords: [], palette: [], lighting: "", grade: "" }));
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
    const clipFiles = [];
    // A2：台词镜回写 dialogue（audioDurationSec/audioUrl）或降级改写 audioMode 后需落盘，
    // 让 audio/export 阶段、retts 与重启恢复看到同一份脚本。
    let scriptDirty = false;
    // ---- 配额闸门（D5）：派发前先预留，挡住并发超发冲 429 ----
    const quota = sc.ctx.quota;
    const estimateSec = estimateClipSeconds(sc.ctx, opts);
    let quotaShortfall = false;
    /** 预算告警 + 本镜及剩余镜头记空位（配额不会凭空回来，继续派发必被拒，
     *  继续循环只会白烧关键帧成本——escalate 而非硬撞） */
    const budgetAlert = (fromIndex) => {
        quotaShortfall = true;
        for (let j = fromIndex; j < productionShots.length; j += 1)
            clipFiles.push(null);
        // 多 key：展示口径 = 各池剩余之和（告警只在全部池都不够一镜时触发，此时必为有限值；
        // 任一池无每日配额时该告警根本不会走到这里）
        const snaps = quota?.snapshot() ?? [];
        const remaining = snaps.reduce((s, p) => s + (Number.isFinite(p.remainingQuotaSec) ? p.remainingQuotaSec : 0), 0);
        const skipped = productionShots.length - fromIndex;
        appendSpan(run, {
            stage: "clips",
            name: `镜头 ${productionShots[fromIndex].id} 配额预留`,
            kind: "media",
            status: "error",
            output: `配额不足（剩 ${remaining.toFixed(0)}s < 预估 ${estimateSec}s/镜），跳过 ${skipped} 镜`,
        }, Date.now());
        // B4 导演契约：结构化预算告警持久化（导演读取后决定裁剪/降级/放弃）
        const alert = buildBudgetAlert({
            remainingSec: remaining,
            estimateSec,
            productionShotIds: productionShots.map((s) => s.id),
            fromIndex,
        });
        try {
            fs.mkdirSync(run.dir, { recursive: true });
            fs.appendFileSync(path.join(run.dir, "budget-alerts.ndjson"), `${JSON.stringify(alert)}\n`, "utf-8");
        }
        catch {
            // 告警持久化失败不影响管线
        }
        pushEvent(run, "producer", "client", "status", `⚠️ 预算告警：视频配额不足（剩 ${remaining.toFixed(0)}s，单镜预估 ${estimateSec}s），镜头 ${productionShots[fromIndex].id} 起 ${skipped} 镜未派发。建议减少镜头数或缩短镜长。`, { stage: "clips", label: "查看分镜" });
    };
    // 导演契约持久化重应用：入队时按已持久化指令设 job priority（reshot 重入队同样生效，契约不再是一次性建议）
    const priorityByShot = new Map((await readPriorityInstructions(run)).map((inst) => [inst.shotId, inst.priority]));
    const pending = [];
    // Phase 1: 批量准备 + 预留 + 提交（pickPool 在 reserveShotQuota 内自动选最早可用池）
    for (const [i, shot] of productionShots.entries()) {
        throwIfAborted(signal);
        const prompt = shotPrompts.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual;
        // 预检：配额明确不足 → 提前 escalate，连关键帧成本都不烧。
        // 多 key 口径：「任一池还够一镜」就继续派发（单池即原行为）；
        // 全部无每日配额（限免）时 remainingQuotaSec 为 Infinity，永不触发。
        if (quota && !quota.snapshot().some((p) => p.remainingQuotaSec >= estimateSec)) {
            budgetAlert(i);
            break;
        }
        // A2 台词分支（准备逻辑不变）
        let dialogueReadyUrl = null;
        let referenceAudioPathForShot = null;
        let dialogueLineForShot = null;
        if (opts.audioDrive === "dialogue" && shot.audioMode === "dialogue" && shot.dialogue) {
            scriptDirty = true;
            const outcome = await prepareDialogueAudio(sc, shot);
            if (outcome.kind === "silent") {
                shot.audioMode = "silent";
                pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 台词 TTS 失败 ⚠️（${outcome.reason}），该镜降级为无声画面继续（不阻断管线）。`, { stage: "generate", focus: shot.id });
            }
            else if (outcome.kind === "narration") {
                shot.audioMode = "narration";
                if (!shot.narrationZh)
                    shot.narrationZh = shot.dialogue.lines.zh;
                if (!shot.narrationEn)
                    shot.narrationEn = shot.dialogue.lines.en;
                pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 台词托管失败 ⚠️（${outcome.reason}），降级为旁白：先出视频，台词按画外音贴上。`, { stage: "generate", focus: shot.id });
            }
            else {
                dialogueReadyUrl = outcome.audioUrl;
                referenceAudioPathForShot = outcome.localAudioRelPath ?? null;
                dialogueLineForShot = shot.dialogue?.lines.zh ?? null;
                if (typeof outcome.audioDurationSec === "number" && outcome.audioDurationSec > 0) {
                    const derived = dialogueDerivedSec(outcome.audioDurationSec);
                    if (derived !== shot.durationSec) {
                        shot.durationSec = derived;
                        pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 镜长按台词音频反推为 ${derived}s（实测 ${outcome.audioDurationSec.toFixed(1)}s）。`, { stage: "generate", focus: shot.id });
                    }
                }
            }
        }
        else if (shot.audioMode === "dialogue" && shot.dialogue && opts.audioDrive !== "dialogue") {
            scriptDirty = true;
            shot.audioMode = "narration";
            if (!shot.narrationZh)
                shot.narrationZh = shot.dialogue.lines.zh;
            if (!shot.narrationEn)
                shot.narrationEn = shot.dialogue.lines.en;
            pushEvent(run, "sound", "producer", "status", `镜头 ${shot.id} 声明台词模式但本次运行未开启音频驱动，已降级为旁白（台词文本保留）。`, { stage: "generate", focus: shot.id });
        }
        const referenceParams = dialogueReadyUrl ? videoSubmitParamsForDialogue(sc.ctx, dialogueReadyUrl, shot.durationSec) : null;
        if (dialogueReadyUrl && !referenceParams) {
            shot.audioMode = "narration";
            if (!shot.narrationZh)
                shot.narrationZh = shot.dialogue.lines.zh;
            if (!shot.narrationEn)
                shot.narrationEn = shot.dialogue.lines.en;
            pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 当前视频适配器不支持音频驱动（audios 被忽略），台词改走旁白轨。`, { stage: "generate", focus: shot.id });
        }
        const useReference = Boolean(referenceParams);
        const frame = await ensureKeyframe(sc, shot.id, prompt, bible, keyframes, shot);
        const imageDataUrl = frame.file ? await fileDataUrl(run.dir, frame.file) : null;
        const shotEstimate = estimateClipSeconds(sc.ctx, opts, shot.durationSec);
        const reservation = await reserveShotQuota(sc, shot.id, shotEstimate, 0);
        if (!reservation) {
            budgetAlert(i);
            break;
        }
        pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 提交生成（${opts.resolution} · ${shot.durationSec}s · ${useReference ? "台词音频驱动口型" : imageDataUrl ? "关键帧+提示词 图生视频" : "文生视频"}）：${prompt.slice(0, 60)}…`);
        const t0 = Date.now();
        // adapterId 取调用时传入的预留：降级重试会重新选池（可能换池），任务必须跟着
        // 新预留的 key 走——闭包捕获 Phase-1 预留会造成「配额记在 B 池、请求烧 A key」的账实不符
        const submitClip = (mode, withImage, at) => sc.queue.submit({
            roleName: "video-agent",
            kind: "video",
            adapterId: at?.adapterId,
            prompt: mode === "reference" ? withReferenceAudioInstruction(prompt) : prompt,
            params: mode === "reference" && referenceParams ? referenceParams : videoSubmitParams(sc.ctx, opts, width, height, withImage && imageDataUrl ? imageDataUrl : null, shot.durationSec),
            outputName: `clip-${shot.id}`,
            priority: priorityByShot.has(shot.id) ? PRIORITY_QUEUE_VALUES[priorityByShot.get(shot.id)] : undefined,
        }, run.dir);
        run.metrics.mediaCalls += 1;
        // 提交到队列（pump 自动按 adapterId 分发到对应 key 并行执行）
        const initialJob = submitClip(useReference ? "reference" : "normal", Boolean(imageDataUrl), reservation);
        pending.push({ shot, index: i, prompt, imageDataUrl, useReference, referenceParams, referenceAudioPath: referenceAudioPathForShot, dialogueLine: dialogueLineForShot, reservation, submitClip, initialJob, t0 });
    }
    // Phase 2: 批量等待出片（队列的 awaitJob 在 job 完成时 resolve；多 key 并行时多个 job 同时在途）
    for (const pc of pending) {
        throwIfAborted(signal);
        const { shot, index: i, imageDataUrl, useReference, referenceAudioPath, dialogueLine, reservation, submitClip, initialJob, t0 } = pc;
        let attemptSeq = 0;
        let finished;
        let currentReservation = reservation;
        try {
            // 等待 Phase 1 已提交的 job 出片（不重复提交）
            finished = await sc.queue.awaitJob(initialJob.id, undefined, signal);
            // 台词跟读校验（audio-follow）：出片成功 ≠ 跟读成功——模型自行配音（不可懂人声）
            // 是 reference 模式的已知失败模式（包络相关 -0.227 vs 跟读成功 +0.990，可分性极强），
            // 不抓的话 export 的 keepSourceAudio 会把垃圾音轨原样烧进成片。
            let referenceFollowed = true;
            const followSpan = (check, tag, extra = "") => appendSpan(run, {
                stage: "clips",
                name: `镜头 ${shot.id} 台词跟读校验${tag}`,
                kind: "qa",
                status: check.follows ? "ok" : "semantic-fail",
                output: `包络相关 ${check.correlation.toFixed(2)}（阈值 ${REFERENCE_FOLLOW_THRESHOLD}）${extra}`,
            }, Date.now());
            if (finished.status === "done" && finished.filePath && pc.useReference && referenceAudioPath) {
                const first = await referenceFollows(run.dir, path.relative(run.dir, finished.filePath), referenceAudioPath, signal);
                // 双关卡：包络证"节奏像"，ASR 转写证"说的是这句台词"。
                // 2026-08-30 批次实证：包络 0.78-0.91 的"跟读"ASR 字面重合仅 0.07-0.14——
                // 模型在**模仿节奏说乱语**（口型动、有吐字、不是人话）。这是 agnes reference
                // 的模型级行为，重试无用（重试相关值仍 0.6 上下）。
                let asrNote = "";
                if (first.follows && dialogueLine) {
                    const asr = await referenceIntelligible(run.dir, path.relative(run.dir, finished.filePath), dialogueLine, {
                        apiKey: sc.ctx.llm.apiKey ?? "",
                        signal,
                    }).catch(() => null);
                    if (asr) {
                        asrNote = `；ASR 重合 ${asr.overlap.toFixed(2)}「${asr.transcribed.slice(0, 16)}」`;
                        first.follows = asr.intelligible;
                    }
                }
                followSpan(first, "", asrNote);
                if (first.follows) {
                    referenceFollowed = true;
                }
                else {
                    // 跟读未过 → **dubOver 模式**：口型视频保留（嘴在动），音轨在 export 被
                    // TTS 原声覆盖——声音永远是人话，不再降级 i2v（画面无话）也不再重试
                    // （乱语是模型级行为，重试 0.6 上下过不了内容关，白烧配额）。
                    settleReservation(sc, currentReservation, estimateClipSeconds(sc.ctx, opts, shot.durationSec));
                    shot.dialogue = { ...shot.dialogue, dubOver: true };
                    referenceFollowed = false;
                    pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 台词跟读未过关${asrNote}——口型视频保留，音轨改用 TTS 原声配音（dubOver）。`, { stage: "generate", focus: shot.id });
                }
            }
            // 台词镜：音频驱动提交失败**或跟读未过** → 降级普通图生视频（新 attempt 新预留），台词转旁白。
            // 差别在配额语义：提交失败 = 供应商没消耗（release）；跟读未过 = 片已真实生成（settle 按预留消耗）。
            const dubOverDone = shot.dialogue?.dubOver === true;
            if ((!(finished.status === "done" && finished.filePath) || (!referenceFollowed && !dubOverDone)) && pc.useReference) {
                if (referenceFollowed) {
                    releaseReservation(sc, currentReservation);
                    pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 音频驱动提交未成功，降级为普通图生视频，台词转旁白轨。`);
                    pc.useReference = false;
                    shot.audioMode = "narration";
                    if (!shot.narrationZh)
                        shot.narrationZh = shot.dialogue.lines.zh;
                    if (!shot.narrationEn)
                        shot.narrationEn = shot.dialogue.lines.en;
                    run.metrics.mediaCalls += 1;
                    attemptSeq += 1;
                    currentReservation = await reserveShotQuota(sc, shot.id, estimateClipSeconds(sc.ctx, opts, shot.durationSec), attemptSeq);
                    if (!currentReservation) {
                        budgetAlert(i);
                        clipFiles.push(null);
                        continue;
                    }
                    const retryJob = submitClip("normal", Boolean(imageDataUrl), currentReservation);
                    finished = await sc.queue.awaitJob(retryJob.id, undefined, signal);
                }
                // dubOver：预留已结算、口型视频已就位，直接进 clipFiles
            }
            // 通用：图生视频整单失败 → 退还本次预留，降级文生视频重新预留（新 attempt = 新幂等键）
            if (!(finished.status === "done" && finished.filePath) && imageDataUrl) {
                releaseReservation(sc, currentReservation);
                pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 图生视频未成功，降级为文生视频重试。`);
                run.metrics.mediaCalls += 1;
                attemptSeq += 1;
                currentReservation = await reserveShotQuota(sc, shot.id, estimateClipSeconds(sc.ctx, opts, shot.durationSec), attemptSeq);
                if (!currentReservation) {
                    budgetAlert(i);
                    clipFiles.push(null);
                    continue;
                }
                const retryJob = submitClip("normal", false, currentReservation);
                finished = await sc.queue.awaitJob(retryJob.id, undefined, signal);
            }
        }
        catch (error) {
            if (currentReservation)
                releaseReservation(sc, currentReservation);
            throw error;
        }
        const ok = finished.status === "done" && finished.filePath;
        clipFiles.push(ok ? finished.filePath : null);
        if (ok && finished.filePath) {
            let dur = null;
            try {
                dur = await probeDuration(path.relative(run.dir, finished.filePath), run.dir);
                const adapter = videoAdapterOf(sc.ctx);
                if (adapter)
                    trackMediaCost(run, sc.ctx, adapter, {}, dur ?? opts.clipDurationSec);
            }
            catch {
                const adapter = videoAdapterOf(sc.ctx);
                if (adapter)
                    trackMediaCost(run, sc.ctx, adapter, {}, opts.clipDurationSec);
            }
            settleReservation(sc, currentReservation, dur ?? estimateSec);
        }
        else {
            releaseReservation(sc, currentReservation);
        }
        appendSpan(run, { stage: "clips", name: `镜头 ${shot.id} 生成`, kind: "media", status: ok ? "ok" : "error", input: `${pc.useReference ? "[台词驱动+reference] " : ""}${imageDataUrl ? "[keyframe+i2v] " : ""}${pc.prompt.slice(0, 120)}`, output: ok ? path.basename(finished.filePath) : `队列状态 ${finished.status}` }, t0);
        if (ok) {
            pushEvent(run, "tech", "editor", "status", `镜头 ${shot.id} 生成完成 ✅（${i + 1}/${productionShots.length}）`, { stage: "generate", focus: shot.id, label: "查看片段" });
        }
        else {
            pushEvent(run, "tech", "producer", "status", `镜头 ${shot.id} 生成失败 ⚠️，已跳过并由剪辑师在时间线上补位。`, { stage: "generate", focus: shot.id, label: "查看该镜" });
        }
        setStage(run, "clips", "running", Math.round(((i + 1) / productionShots.length) * 100));
    }
    const okCount = clipFiles.filter((f) => f !== null).length;
    if (okCount === 0) {
        throw new Error(quotaShortfall ? "视频配额不足，未派发任何镜头（详见预算告警事件）" : "全部镜头生成失败（详见队列重试记录）");
    }
    setStage(run, "clips", "done", 100);
    // A2：台词回写/降级改写落盘（audio 阶段读 narrationZh、export 读 audioMode/audioDurationSec）
    if (scriptDirty) {
        await writeJson(run, "script.json", scriptDoc);
    }
    pushEvent(run, "tech", "editor", "handoff", `镜头批次交付：${okCount}/${productionShots.length} 镜成功，移交剪辑师归一化与合成。`);
    return { script: { ...scriptDoc, shots: productionShots }, clipFiles };
}
/**
 * 镜头配额预留（D5 闸门）。时长配额不足返回 null（调用方发预算告警、停止派发）；
 * RPM 令牌暂缺则等补充后重试（可被 signal 中止）。
 * 幂等键 = `${runId}:${shotId}:a${attempt}`：同一 attempt 的重复提交被账本去重，
 * i2v→t2v 降级重试是新 attempt（新键、新令牌）。
 * 无账本（测试桩省略 ctx.quota）→ 占位预留 = 不设闸门（旧行为，降级优于阻断）。
 */
export async function reserveShotQuota(sc, shotId, estimateSec, attempt) {
    const quota = sc.ctx.quota;
    if (!quota)
        return { ok: true, reservationId: "", reservedSec: estimateSec, reused: false, poolId: "" };
    for (;;) {
        throwIfAborted(sc.signal);
        // 多 key 并发（2026-08-29：每个 key 限流独立 → 一 key 一池）：
        // 每轮重新选池，而不是死等固定池——别的 key 可能已经空出来了。
        const poolId = quota.pickPool(estimateSec);
        if (poolId !== null) {
            const r = quota.reserve(poolId, estimateSec, {
                idempotencyKey: `${sc.run.id}:${shotId}:a${attempt}`,
            });
            if (r.ok)
                return r;
            // 令牌恰好被并发抢走 → 下一轮重新选池；其余原因不可重试
            if (r.reason === "rpm_exhausted")
                continue;
            return null;
        }
        // 无可用池：区分「令牌暂缺（等待可恢复）」与「额度不足/全部隔离（等也没用）」。
        // 隔离池（key 认证失效）不参与等待——等 30 分钟不如早点 escalate。
        const now = Date.now();
        const snaps = quota.snapshot();
        const active = snaps.filter((p) => !(p.quarantinedUntil && now < p.quarantinedUntil));
        if (!active.some((p) => p.remainingQuotaSec >= estimateSec)) {
            return null; // insufficient_quota / 全部隔离 → 预算告警由调用方处理
        }
        const soonest = active.reduce((min, p) => Math.min(min, p.rpmWaitMs), Number.POSITIVE_INFINITY);
        const waitMs = Number.isFinite(soonest) && soonest > 0 ? soonest : 1000;
        await sleepAbortable(Math.min(waitMs + 100, 65_000), sc.signal);
    }
}
function releaseReservation(sc, reservation) {
    if (sc.ctx.quota && reservation.reservationId)
        sc.ctx.quota.release(reservation.reservationId);
}
function settleReservation(sc, reservation, actualSec) {
    if (sc.ctx.quota && reservation.reservationId)
        sc.ctx.quota.settle(reservation.reservationId, actualSec);
}
/** 可中止 sleep：abort 时立即 reject「已中止」（与管线其余中止路径同语义） */
function sleepAbortable(ms, signal) {
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
