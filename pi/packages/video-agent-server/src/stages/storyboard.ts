/**
 * stageStoryboard —— 故事板阶段（阶段 2.5，P2-S8）。
 * script 定稿后生成镜头卡（前置条件-动作-结果的世界状态账本），storyboard.json 落盘。
 * 自检：validateStoryboard 确定性校验（fail 级带强化反馈重写一次，复用对白密度守卫模式）；
 * 豁免口径与 reshot/QA 消费侧一致（R2 未观察保持 / ellipsis·flashback 时间跳变）。
 *
 * 前向兼容：storyboard.json 缺失（旧 run / 生成失败）不阻断——prompts/export 消费侧全部可选注入。
 */

import {
	storyboardMessages,
	type DesignBibleDoc,
	type ScriptDoc,
	type StoryboardDoc,
} from "../prompts.ts";
import { validateStoryboard, type EntityIds } from "../storyboard-state.ts";
import { generateDoc, optionsOf, pushEvent, readArtifact, setStage, throwIfAborted, writeJson } from "../pipeline.ts";
import type { StageCtx } from "../pipeline.ts";

export async function stageStoryboard(sc: StageCtx, script?: ScriptDoc): Promise<StoryboardDoc> {
	const { run, signal } = sc;
	setStage(run, "prompts", "running", 20);
	pushEvent(run, "storyboard", "tech", "status", "故事板开工：为每个镜头登记世界状态账本（前置-动作-结果）。");
	throwIfAborted(signal);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	const designDoc = await readArtifact<DesignBibleDoc>(run, "design-bible.json").catch(() => null);

	const entityIds: EntityIds = {
		characters: (designDoc?.characters ?? []).map((c) => c.id),
		props: (designDoc?.props ?? []).map((p) => p.id),
		scenes: (designDoc?.scenes ?? []).map((s) => s.id),
	};

	// 台词镜 speaker 实体注册（dialogueTurn.speakerId 引用）
	const speakerIds = new Set(scriptDoc.shots.flatMap((s) => (s.dialogue ? [s.dialogue.characterId] : [])));

	const build = (extraNote: string) =>
		generateDoc<StoryboardDoc>(sc, storyboardMessages(scriptDoc, designDoc), extraNote, "prompts");

	let doc = await build("");
	let conflicts = validateStoryboard(doc, entityIds);
	if (conflicts.length > 0) {
		// 带强化反馈重写一次（对白密度守卫同款模式）；仍失败则落盘带 conflict 标记的版本，
		// 不阻断管线——故事板是增强层，消费侧对缺失/低质字段全部兜底。
		pushEvent(run, "storyboard", "tech", "status", `故事板自检发现 ${conflicts.length} 处冲突，带反馈重写一次。`);
		const feedback = `上一次输出未通过状态机自检，必须修正：\n${conflicts.map((c) => `- [${c.rule}] ${c.shotId}: ${c.message}`).join("\n")}\n重新输出完整 JSON。`;
		doc = await build(feedback);
		conflicts = validateStoryboard(doc, entityIds);
	}
	if (conflicts.length > 0) {
		pushEvent(
			run,
			"storyboard",
			"tech",
			"qa",
			`故事板自检仍有 ${conflicts.length} 处冲突（已落盘，供人工审读）：${conflicts.map((c) => `${c.shotId}`).join("、")}。`,
		);
	}

	// dialogueTurn.speakerId 兜底：台词镜缺失轮次时按剧本补挂（speakerId 引用实体 id）
	for (const shot of doc.shots) {
		const scriptShot = scriptDoc.shots.find((s) => s.id === shot.shotId);
		if (scriptShot?.dialogue && !shot.dialogueTurn && speakerIds.has(scriptShot.dialogue.characterId)) {
			shot.dialogueTurn = { speakerId: scriptShot.dialogue.characterId, order: 0 };
		}
	}

	await writeJson(run, "storyboard.json", conflicts.length > 0 ? { ...doc, conflicts } : doc);
	return doc;
}
