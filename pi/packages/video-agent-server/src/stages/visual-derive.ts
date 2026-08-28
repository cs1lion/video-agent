/**
 * 美术设计阶段 - 设计图生成 + 自审（仅实体推导与出图重试）。
 *
 * 从 pipeline.ts 拆出，包含：
 * - deriveDesignBible：LLM 推导人物/道具/场景 → 逐张出图
 * - autoReviewDesign：自审 → fail 自动重绘 + 复审
 * 失败容忍：推导失败不阻断管线，事件告知用户。
 */

import { reviewDesignBible } from "../design-review.js";
import { chatJson } from "../llm.js";
import { trackLlmCost } from "../pricing.ts";
import {
	normalizeDesignDoc,
	designBibleMessages,
	designSheetPrompt,
	type DesignBibleDoc,
	type DesignEntity,
	type ScriptDoc,
	type VisualBible,
} from "../prompts.js";
import {
	appendSpan,
	fileDataUrl,
	generateImage,
	imageSizeFor,
	optionsOf,
	promptsToText,
	pushEvent,
	readDesignBible,
	setStage,
	throwIfAborted,
	writeDesignBible,
} from "../pipeline.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StageCtx } from "../pipeline.js";

/**
 * 美术设计核心素材：人物/道具/场景概念设计图（失败容忍，不阻断管线）。
 * LLM 推导实体矩阵 → 逐张出图。
 */
export async function deriveDesignBible(
	sc: StageCtx,
	script: ScriptDoc,
	bible: VisualBible,
): Promise<void> {
	const { run, signal } = sc;
	let doc: DesignBibleDoc;
	const t0 = Date.now();
	try {
		const designBiblePrompt = promptsToText(designBibleMessages(run.brief, script, bible));
		const raw = await chatJson<Partial<Record<"characters" | "props" | "scenes", unknown>>>(
			sc.ctx.llm,
			designBiblePrompt,
			signal,
		);
		run.metrics.llmCalls += 1;
		trackLlmCost(run, sc.ctx, designBiblePrompt, JSON.stringify(raw));
		doc = normalizeDesignDoc(raw);
		appendSpan(
			run,
			{
				stage: "visual",
				name: "美术设计·实体推导",
				kind: "llm",
				status: "ok",
				input: `${script.title} + 美术设计`,
				output: `人物 ${doc.characters.length} / 道具 ${doc.props.length} / 场景 ${doc.scenes.length}`,
			},
			t0,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		appendSpan(
			run,
			{
				stage: "visual",
				name: "美术设计·实体推导",
				kind: "llm",
				status: "error",
				output: error instanceof Error ? error.message : String(error),
			},
			t0,
		);
		pushEvent(run, "art", "producer", "status", "设计实体推导失败 ⚠️（不影响后续阶段），可稍后在美术设计面板重试。");
		return;
	}
	const total = doc.characters.length + doc.props.length + doc.scenes.length;
	if (total === 0) {
		pushEvent(run, "art", "producer", "status", "剧本中没有需要单独出设计图的实体，跳过概念设计图生成。");
		return;
	}
	doc.generatedAt = new Date().toISOString();
	await writeDesignBible(run, doc);
	pushEvent(
		run,
		"art",
		"producer",
		"status",
		`美术设计开工：${total} 张概念设计图（人物 ${doc.characters.length} · 道具 ${doc.props.length} · 场景 ${doc.scenes.length}）逐张绘制中。`,
	);

	const entities: DesignEntity[] = [...doc.characters, ...doc.props, ...doc.scenes];
	let done = 0;
	for (const entity of entities) {
		throwIfAborted(signal);
		const tImg = Date.now();
		entity.attempts += 1;
		try {
			const file = await generateImage(
				sc,
				designSheetPrompt(entity, bible),
				`design-${entity.category}-${entity.id}`,
				// 概念图直接按成片画幅出图：参考板/构图传导到关键帧时不发生裁切漂移
				imageSizeFor(optionsOf(run).aspectRatio),
			);
			if (file) {
				entity.file = file;
				entity.status = "done";
				entity.error = undefined;
			} else {
				entity.status = "failed";
				entity.error = "图像生成失败";
			}
		} catch (error) {
			if (signal.aborted) throw error;
			entity.status = "failed";
			entity.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
		}
		appendSpan(
			run,
			{
				stage: "visual",
				name: `设计图 ${entity.id}（${entity.name}）`,
				kind: "media",
				status: entity.status === "done" ? "ok" : "error",
				input: entity.design.slice(0, 120),
				output: entity.file ? path.basename(entity.file) : (entity.error ?? "失败"),
			},
			tImg,
		);
		pushEvent(
			run,
			"art",
			"producer",
			"status",
			entity.status === "done"
				? `设计图完成 ✅「${entity.name}」（${entity.category === "character" ? "人物" : entity.category === "prop" ? "道具" : "场景"} ${entity.id}）`
				: `设计图失败 ⚠️「${entity.name}」：${entity.error ?? "未知原因"}。可在美术设计面板重试。`,
			{ stage: "bible", focus: entity.id, label: "查看设计图" },
		);
		done += 1;
		setStage(run, "visual", "running", Math.round(40 + (done / total) * 55));
		await writeDesignBible(run, doc);
	}
	const okCount = entities.filter((e) => e.status === "done").length;
	pushEvent(
		run,
		"art",
		"producer",
		"status",
		`美术设计完成 ✅ ${okCount}/${total} 张设计图就绪，可在「美术设计」面板查看并逐张调整；确认前不会进入关键帧与视频生成。`,
	);

	// 出图自审：视觉模型对照设计要点逐卡审查（fail 卡自动重绘一轮再复审）。
	// 美术设计是全片视觉源头——设计卡画错（如银发画成棕发）会在关键帧与视频里放大，
	// 源头拦截比事后逐镜补拍便宜一个数量级；审核失败不阻断管线。
	if (okCount > 0) await autoReviewDesign(sc, doc, bible);
}

/** 设计出图自审：审核 → fail 卡带审核意见重绘（1 轮）→ 复审；结果写回实体 review 字段 */
export async function autoReviewDesign(sc: StageCtx, doc: DesignBibleDoc, bible: VisualBible): Promise<void> {
	const { run, signal } = sc;
	const t0 = Date.now();
	let flagged: DesignEntity[];
	try {
		pushEvent(run, "reviewer", "art", "status", "审校员核对设计图：逐张比对画面与设计要点…");
		const { reviewed } = await reviewDesignBible(sc.ctx, run, signal);
		flagged = reviewed.filter((e) => e.review?.verdict === "fail");
		const warnCount = reviewed.filter((e) => e.review?.verdict === "warn").length;
		appendSpan(
			run,
			{
				stage: "visual",
				name: "美术设计·出图自审",
				kind: "qa",
				status: flagged.length > 0 ? "semantic-fail" : "ok",
				input: `${reviewed.length} 张设计图送审`,
				output: `${reviewed.length - flagged.length - warnCount} ok / ${warnCount} warn / ${flagged.length} fail`,
			},
			t0,
		);
		pushEvent(
			run,
			"reviewer",
			"art",
			flagged.length > 0 ? "redo" : "status",
			flagged.length > 0
				? `设计图自审发现问题 ⚠️：${flagged.map((e) => `「${e.name}」${e.review!.issues.join("、")}`).join("；")}。安排美术指导带意见重绘。`
				: `设计图自审通过 ✅ ${reviewed.length} 张与设计要点相符${warnCount > 0 ? `（另有 ${warnCount} 张小偏差，可人工复核）` : ""}。`,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		appendSpan(
			run,
			{
				stage: "visual",
				name: "美术设计·出图自审",
				kind: "qa",
				status: "error",
				output: error instanceof Error ? error.message : String(error),
			},
			t0,
		);
		pushEvent(run, "reviewer", "producer", "status", "设计图自审未成功 ⚠️（不影响管线），可在美术设计面板手动发起审核。");
		return;
	}
	if (flagged.length === 0) return;

	// fail 卡自动重绘一轮：以旧图为参考做增量修正（防人物改脸漂移），审核意见即调整指令。
	// 自动轮不占 entity.attempts（那是用户手动重绘的配额），天然每管线只跑一轮，有界。
	const redrawn: DesignEntity[] = [];
	for (const entity of flagged) {
		throwIfAborted(signal);
		const issues = entity.review?.issues.join("; ") ?? "";
		// 先备份旧图、再生成（与 redesignEntity 同规：先生成后备份会把新图误挪进版本库）
		if (entity.file && fs.existsSync(path.join(run.dir, entity.file))) {
			const vName = `design-${entity.category}-${entity.id}_v${entity.versions.length + 1}${path.extname(entity.file)}`;
			await fs.promises.rename(path.join(run.dir, entity.file), path.join(run.dir, "assets", vName)).catch(() => {});
			entity.versions.push(path.join("assets", vName));
		}
		const prevRef = entity.versions.length
			? await fileDataUrl(run.dir, entity.versions[entity.versions.length - 1]!).catch(() => null)
			: null;
		const file = await generateImage(
			sc,
			designSheetPrompt(entity, bible, `fix these problems: ${issues}`),
			`design-${entity.category}-${entity.id}`,
			imageSizeFor(optionsOf(run).aspectRatio),
			{ referenceImage: prevRef },
		);
		if (file) {
			entity.file = file;
			entity.status = "done";
			entity.error = undefined;
			redrawn.push(entity);
		} else {
			// 重绘失败：回滚版本库里的旧图到主名
			if (entity.versions.length && entity.file) {
				const vName = entity.versions[entity.versions.length - 1]!;
				await fs.promises.rename(path.join(run.dir, vName), path.join(run.dir, entity.file)).catch(() => {});
				entity.versions.pop();
			}
			entity.status = entity.file ? "done" : "failed";
		}
		await writeDesignBible(run, doc);
	}

	// 复审重绘卡：定向小批量调用，确认修复效果
	if (redrawn.length > 0) {
		pushEvent(
			run,
			"art",
			"reviewer",
			"handoff",
			`${redrawn.map((e) => `「${e.name}」`).join("、")}已按审核意见重绘，提交复审…`,
		);
		try {
			const { reviewed } = await reviewDesignBible(sc.ctx, run, signal, redrawn.map((e) => e.id));
			const fixed = reviewed.filter((e) => e.review?.verdict !== "fail");
			const still = reviewed.filter((e) => e.review?.verdict === "fail");
			appendSpan(
				run,
				{
					stage: "visual",
					name: "设计图·重绘复审",
					kind: "qa",
					status: still.length > 0 ? "semantic-fail" : "ok",
					input: `${redrawn.length} 张重绘复审`,
					output: `${fixed.length} 修复 / ${still.length} 仍不合格`,
				},
				Date.now(),
			);
			pushEvent(
				run,
				"art",
				"reviewer",
				"qa",
				`设计图重绘后${still.length > 0 ? `仍有问题 ⚠️：${still.map((f) => `「${f.name}」${f.review!.issues.join("、")}`).join("；")}。已在帧上标注，确认前请人工定夺（可手动重绘或确认放行）。` : `审核问题已全部修复 ✅ 卡片 ${fixed.map((f) => f.name).join("、")} 复审通过。`}`,
			);
		} catch (error) {
			if (signal.aborted) throw error;
			pushEvent(run, "art", "producer", "status", "重绘卡复审未成功 ⚠️，请在美术设计面板手动发起审核确认。");
		}
	}
}
