/**
 * redesignKeyframeInner —— 单镜关键帧重绘（redrawKeyframe/redesignKeyframe 的内部实现）。
 * 自参考迭代：当前设计定稿矩阵 + 旧帧构图合成参考板；失败回滚；auto 路径独立计数。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { keyframePrompt } from "../prompts.ts";
import { appendSpan, buildReferenceSheet, designAnchorsOf, generateImage, imageSizeFor, keyframeReferencesOf, MAX_IMAGE_AUTO_REDRAW, MAX_IMAGE_REDRAW, optionsOf, promptSigOf, pushEvent, readArtifact, readKeyframes, writeJson, } from "../pipeline.ts";
import { fileDataUrl, withVersionedAsset } from "../asset-version.ts";
import { GenerationQueue } from "../../../coding-agent/examples/extensions/studio/media/queue.ts";
/** 手动重绘某镜关键帧（内部实现；公共入口 redesignKeyframe/redrawKeyframe 留在 pipeline.ts） */
export async function redesignKeyframeInner(ctx, run, shotId, instruction, opts) {
    let script;
    try {
        script = await readArtifact(run, "script.json");
    }
    catch {
        return { ok: false, error: "剧本产物缺失" };
    }
    if (!script.shots.some((s) => s.id === shotId))
        return { ok: false, error: `镜头 ${shotId} 不存在` };
    const doc = await readKeyframes(run);
    let entry = doc.frames.find((f) => f.shotId === shotId);
    const keyframeWasFailed = entry?.status === "failed";
    // 手动路径有人工配额护栏；auto 路径独立计数（不占手动配额）
    if (entry) {
        if (opts?.auto) {
            if ((entry.autoAttempts ?? 0) >= MAX_IMAGE_AUTO_REDRAW) {
                return {
                    ok: false,
                    error: `镜头 ${shotId} 审核自动重绘 ${MAX_IMAGE_AUTO_REDRAW} 轮仍未通过，已停止。问题需在分镜提示词阶段微调后整体重跑。`,
                };
            }
        }
        else if (entry.attempts >= MAX_IMAGE_REDRAW) {
            return {
                ok: false,
                error: `镜头 ${shotId} 关键帧已重绘 ${MAX_IMAGE_REDRAW} 次达上限。建议在分镜提示词阶段微调后整体重跑。`,
            };
        }
    }
    const bible = await readArtifact(run, "visual-bible.json").catch(() => ({ styleKeywords: [], palette: [], lighting: "", grade: "" }));
    const shotPrompts = await readArtifact(run, "prompts.json").catch(() => null);
    const shotPrompt = shotPrompts?.prompts.find((p) => p.shotId === shotId)?.prompt ??
        script.shots.find((s) => s.id === shotId).visual;
    const queue = new GenerationQueue(ctx.mediaConfig);
    const sc = { run, ctx, queue, signal: run.abort.signal };
    if (!entry) {
        entry = { shotId, status: "pending", attempts: 0, versions: [] };
        doc.frames.push(entry);
    }
    const oldFile = entry.file;
    const t0 = Date.now();
    // 自参考迭代：当前设计定稿矩阵 + 旧帧构图一起合成参考板；既同步新设定，又保留原构图。
    const prevSelfRef = oldFile && fs.existsSync(path.join(run.dir, oldFile)) ? await fileDataUrl(run.dir, oldFile) : null;
    const latestReferences = await keyframeReferencesOf(shotId, run, shotPrompt, script.shots.find((s) => s.id === shotId)?.visual);
    const redrawSources = [...latestReferences.entities.map((entity) => entity.file).filter(Boolean)];
    if (oldFile && fs.existsSync(path.join(run.dir, oldFile)))
        redrawSources.push(oldFile);
    const redrawReference = oldFile && fs.existsSync(path.join(run.dir, oldFile))
        ? await buildReferenceSheet(run, shotId, redrawSources)
        : latestReferences.file;
    const redrawReferenceImage = redrawReference ? await fileDataUrl(run.dir, redrawReference) : prevSelfRef;
    if (opts?.auto) {
        entry.autoAttempts = (entry.autoAttempts ?? 0) + 1;
    }
    else {
        entry.attempts += 1;
    }
    delete entry.confirmed;
    pushEvent(run, "storyboard", "client", "redo", `正在重试镜头 ${shotId} 关键帧（第 ${entry.attempts} 次）${instruction ? `：${instruction.slice(0, 60)}` : "（原样重绘）"}…`);
    try {
        // 先备份旧图、再生成：生成会写入同名主文件，若先生成后备份，
        // 会把新图误挪进版本库并让主文件悬空（UI 404、首帧锚定失效）。
        const vRelPath = `assets/key-${shotId}_v${entry.versions.length + 1}${path.extname(oldFile ?? "")}`;
        const { file } = await withVersionedAsset({
            run,
            mainRelPath: oldFile ?? "",
            versions: entry.versions,
            backupRelPath: vRelPath,
            generate: async () => generateImage(sc, keyframePrompt(shotPrompt, bible, await designAnchorsOf(run)) +
                (instruction ? `, adjustment: ${instruction}` : ""), `key-${shotId}`, imageSizeFor(optionsOf(run).aspectRatio), { referenceImage: redrawReferenceImage }),
        });
        if (!file) {
            entry.status = oldFile ? "done" : "failed";
            await writeJson(run, "keyframes.json", doc);
            pushEvent(run, "storyboard", "client", "status", `镜头 ${shotId} 关键帧重试未成功 ⚠️，可稍后再次重试。`);
            return { ok: false, error: "关键帧生成失败，请稍后重试" };
        }
        entry.file = file;
        entry.status = "done";
        entry.error = undefined;
        entry.promptSig = promptSigOf(shotPrompt);
        // 元数据对齐：重绘即视为同步最新设定；参考矩阵刷新为当前最相关实体集
        entry.refs = latestReferences.entities.map((entity) => entity.id);
        if (redrawReference)
            entry.refSheet = redrawReference;
        else
            delete entry.refSheet;
        delete entry.staleRefs;
        if (Array.isArray(doc.confirmedShotIds))
            doc.confirmedShotIds = doc.confirmedShotIds.filter((id) => id !== shotId);
        await writeJson(run, "keyframes.json", doc);
        appendSpan(run, {
            stage: "reshot",
            name: `关键帧 ${shotId} 重绘`,
            kind: "media",
            status: "ok",
            input: (instruction || "原样重绘").slice(0, 120),
            output: path.basename(file),
        }, t0);
        pushEvent(run, "storyboard", "client", "redo", `镜头 ${shotId} 关键帧已重绘完成${instruction ? `：${instruction.slice(0, 60)}` : ""}。补拍时将以新关键帧锚定画面。`, { stage: "keyframes", focus: shotId, label: "查看关键帧" });
        return { ok: true, keyframeWasFailed };
    }
    catch (error) {
        if (sc.signal.aborted)
            return { ok: false, error: "已中止" };
        entry.status = oldFile ? "done" : "failed";
        entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
        await writeJson(run, "keyframes.json", doc);
        pushEvent(run, "storyboard", "client", "status", `镜头 ${shotId} 关键帧重试出错 ⚠️：${entry.error}`);
        return { ok: false, error: entry.error ?? "重绘失败" };
    }
}
