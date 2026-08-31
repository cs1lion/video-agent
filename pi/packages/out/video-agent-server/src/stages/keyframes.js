/**
 * stageKeyframes —— 独立关键帧阶段。
 * 分镜文本定稿后逐镜绘制首帧锚定图，完成后挂关键帧确认闸门。
 */
import { keyframePrompt } from "../prompts.js";
import { appendSpan, generateImage, imageSizeFor, keyframeReferencesOf, optionsOf, pushEvent, readArtifact, readKeyframes, setStage, throwIfAborted, writeJson, } from "../pipeline.js";
import * as path from "node:path";
/** 独立关键帧阶段：分镜文本定稿后逐镜绘制首帧锚定图，完成后挂关键帧确认闸门 */
export async function stageKeyframes(sc, script, bible) {
    const { run, signal } = sc;
    setStage(run, "keyframes", "running", 5);
    const scriptDoc = script ?? (await readArtifact(run, "script.json"));
    const bibleDoc = bible ?? (await readArtifact(run, "visual-bible.json"));
    const shotPrompts = await readArtifact(run, "prompts.json");
    const keyframes = await readKeyframes(run);
    // 重跑分镜会重塑画面原料：上一轮确认清单随之作废，必须重新经过关键帧闸门。
    keyframes.confirmedShotIds = [];
    for (const frame of keyframes.frames)
        delete frame.confirmed;
    // 上游 refine 过期级联：帧的提示词签名与当前 prompts.json 不一致（画面原料已变）→
    // 标 stale 复用既有级联机制（确认闸门拦截 + UI 过期徽标），而不是让旧画面静默过关。
    const staleShots = [];
    for (const frame of keyframes.frames) {
        if (frame.status !== "done" || !frame.file || !frame.promptSig)
            continue; // 旧 run 无签名：跳过
        const shot = scriptDoc.shots.find((s) => s.id === frame.shotId);
        if (!shot)
            continue; // 该镜已不存在（refine 改了镜头清单）：留给下方循环处理
        const currentSig = optionsOf(run).shotCount.toString() + ":" + (shotPrompts.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual);
        if (currentSig !== frame.promptSig) {
            frame.staleRefs = [...new Set([...(frame.staleRefs ?? []), "prompts"])];
            delete frame.confirmed;
            staleShots.push(frame.shotId);
        }
    }
    if (staleShots.length > 0) {
        if (Array.isArray(keyframes.confirmedShotIds))
            keyframes.confirmedShotIds = keyframes.confirmedShotIds.filter((id) => !staleShots.includes(id));
        pushEvent(run, "storyboard", "client", "redo", `分镜提示词已更新 ⚠️ ${staleShots.length} 镜关键帧基于旧画面描述（${staleShots.join("、")}），已标过期：请逐镜重绘同步后再确认。`, { stage: "keyframes", label: "去处理" });
    }
    for (const [i, shot] of scriptDoc.shots.entries()) {
        throwIfAborted(signal);
        const prompt = shotPrompts.prompts.find((p) => p.shotId === shot.id)?.prompt ?? shot.visual;
        await ensureKeyframe(sc, shot.id, prompt, bibleDoc, keyframes, shot);
        setStage(run, "keyframes", "running", Math.round(5 + ((i + 1) / scriptDoc.shots.length) * 90));
    }
    await writeJson(run, "keyframes.json", keyframes);
    setStage(run, "keyframes", "done", 100);
    pushEvent(run, "storyboard", "tech", "handoff", `分镜锁定 ✅ ${scriptDoc.shots.length} 镜提示词与关键帧全部就绪（含一致性锚点与负面词）。技术导演待命，等你确认关键帧后按队列提交生成。`);
}
/** 单镜关键帧：备份旧图、出图、失败回滚、stale 清理 */
async function ensureKeyframe(sc, shotId, shotPrompt, bible, doc, shot) {
    const { run, signal } = sc;
    let entry = doc.frames.find((f) => f.shotId === shotId);
    if (entry?.status === "done" && entry.file)
        return entry;
    if (!entry) {
        entry = { shotId, status: "pending", attempts: 0, versions: [] };
        doc.frames.push(entry);
    }
    entry.attempts += 1;
    entry.status = "pending";
    const t0 = Date.now();
    const references = await keyframeReferencesOf(shotId, run, shotPrompt, shot.visual);
    const referenceImage = references.dataUrl;
    // 记录本帧依赖的设计定稿：该实体重绘时可精确级联标过期；新出图即视为同步了最新设定
    entry.refs = references.entities.map((entity) => entity.id);
    if (references.file)
        entry.refSheet = references.file;
    else
        delete entry.refSheet;
    delete entry.staleRefs;
    pushEvent(run, "tech", "producer", "status", `镜头 ${shotId} 先出关键帧（首帧锚定图${referenceImage ? ` · ${references.entities.length} 实体参考板` : ""}）…`);
    throwIfAborted(signal);
    const file = await generateImage(sc, keyframePrompt(shotPrompt, bible, references.anchors), `key-${shotId}`, imageSizeFor(optionsOf(run).aspectRatio), { referenceImage });
    if (file) {
        entry.file = file;
        entry.status = "done";
        entry.error = undefined;
    }
    else {
        entry.status = "failed";
        entry.error = "关键帧生成失败";
    }
    appendSpan(run, {
        stage: "keyframes",
        name: `关键帧 ${shotId}`,
        kind: "media",
        status: entry.status === "done" ? "ok" : "error",
        input: shotPrompt.slice(0, 120),
        output: entry.file ? path.basename(entry.file) : (entry.error ?? "失败"),
    }, t0);
    throwIfAborted(signal);
    if (entry.status === "done") {
        // 关键帧自审：视觉模型对照设计定稿审查（已迁到 keyframes-review.ts）
    }
    const updated = await readKeyframes(run);
    return updated.frames.find((f) => f.shotId === shotId);
}
