/**
 * redesignEntityInner —— 单卡设计图重绘（redesignEntity 的内部实现）。
 * 以旧定稿为参考图做增量重绘（防人物改脸漂移）；失败回滚、级联标过期。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { designSheetPrompt, type VisualBible } from "../prompts.ts";
import {
	appendSpan,
	generateImage,
	imageSizeFor,
	MAX_IMAGE_REDRAW,
	normalizeBible,
	optionsOf,
	propagateEntityUpdate,
	pushEvent,
	readArtifact,
	readDesignBible,
	writeDesignBible,
	type RunRecord,
	type StageCtx,
} from "../pipeline.ts";
import { fileDataUrl, withVersionedAsset } from "../asset-version.ts";
import { GenerationQueue } from "../../../coding-agent/examples/extensions/studio/media/queue.ts";
import type { ServerContext } from "../config.ts";

/** 手动调整重绘一张设计图（内部实现；公共入口 redesignEntity 留在 pipeline.ts） */
export async function redesignEntityInner(
	ctx: ServerContext,
	run: RunRecord,
	entityId: string,
	instruction: string,
): Promise<{ ok: boolean; error?: string }> {
	const doc = await readDesignBible(run);
	if (!doc) return { ok: false, error: "美术设计图尚未生成" };
	const entity = [...doc.characters, ...doc.props, ...doc.scenes].find((e) => e.id === entityId);
	if (!entity) return { ok: false, error: `设计条目 ${entityId} 不存在` };
	if (entity.attempts >= MAX_IMAGE_REDRAW && instruction) {
		return {
			ok: false,
			error: `「${entity.name}」已重绘 ${MAX_IMAGE_REDRAW} 次达上限。建议在美术设计阶段微调整体风格。`,
		};
	}

	const bible = normalizeBible(
		await readArtifact<VisualBible>(run, "visual-bible.json").catch(() => ({
			styleKeywords: [],
			palette: [],
			lighting: "",
			grade: "",
		})),
	);
	const queue = new GenerationQueue(ctx.mediaConfig);
	const sc: StageCtx = { run, ctx, queue, signal: run.abort.signal };
	// 参考传导：以该实体旧版定稿为参考，重绘是增量调整而非凭空再画（防人物改脸漂移）
	const prevRef =
		entity.file && fs.existsSync(path.join(run.dir, entity.file)) ? await fileDataUrl(run.dir, entity.file) : null;
	entity.attempts += 1;
	pushEvent(
		run,
		"art",
		"client",
		"redo",
		`美术指导正在重绘设计图「${entity.name}」（第 ${entity.attempts} 次）${instruction ? `：${instruction.slice(0, 60)}` : "（原样重绘）"}…`,
	);
	const t0 = Date.now();
	try {
		// 备份旧图、再生成。顺序反了会把新图误挪进版本库、令主名悬空（详见 withVersionedAsset）。
		const vRelPath = `assets/design-${entity.category}-${entity.id}_v${entity.versions.length + 1}${path.extname(entity.file ?? "")}`;
		const { file } = await withVersionedAsset({
			run,
			mainRelPath: entity.file ?? "",
			versions: entity.versions,
			backupRelPath: vRelPath,
			generate: () =>
				generateImage(
					sc,
					designSheetPrompt(entity, bible, instruction || undefined),
					`design-${entity.category}-${entity.id}`,
					imageSizeFor(optionsOf(run).aspectRatio),
					{ referenceImage: prevRef },
				),
		});
		if (!file) {
			entity.status = entity.file ? "done" : "failed";
			entity.error = "图像生成失败";
			await writeDesignBible(run, doc);
			pushEvent(run, "art", "client", "status", `设计图「${entity.name}」重绘未成功 ⚠️，可稍后在卡片上再次重试。`);
			return { ok: false, error: "图像生成失败，请稍后重试" };
		}
		entity.file = file;
		entity.status = "done";
		entity.error = undefined;
		await writeDesignBible(run, doc);
		appendSpan(
			run,
			{
				stage: "reshot",
				name: `设计图 ${entity.id} 调整重绘`,
				kind: "media",
				status: "ok",
				input: (instruction || "原样重绘").slice(0, 120),
				output: path.basename(file),
			},
			t0,
		);
		// 失效级联：以旧定稿为参考图的关键帧随本次更新标过期（关键帧闸门内立即可见）
		await propagateEntityUpdate(run, entity);
		pushEvent(
			run,
			"art",
			"client",
			"redo",
			`设计图「${entity.name}」已按你的意见重绘完成${instruction ? `：${instruction.slice(0, 60)}` : ""}。`,
			{ stage: "bible", focus: entity.id, label: "查看设计图" },
		);
		return { ok: true };
	} catch (error) {
		if (sc.signal.aborted) return { ok: false, error: "已中止" };
		entity.status = entity.file ? "done" : "failed";
		entity.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
		await writeDesignBible(run, doc);
		pushEvent(run, "art", "client", "status", `设计图「${entity.name}」重绘出错 ⚠️：${entity.error}`);
		return { ok: false, error: entity.error ?? "重绘失败" };
	}
}
