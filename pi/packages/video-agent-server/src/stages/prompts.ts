/**
 * stagePrompts —— 分镜提示词阶段。
 * 编剧定稿 + 美术设计定稿后，逐镜生成视频模型提示词。
 * 角色外观锚点注入：跨镜服装/发型一致性。
 */

import {
	PROMPT_VERSION,
	shotPromptMessages,
	type DesignBibleDoc,
	type ScriptDoc,
	type ShotPromptDoc,
	type StoryboardDoc,
	type VisualBible,
} from "../prompts.js";
import {
	generateDoc,
	normalizeShotPrompts,
	optionsOf,
	pushEvent,
	readArtifact,
	setStage,
	stage as stageFn,
	throwIfAborted,
	writeJson,
} from "../pipeline.js";
import type { StageCtx } from "../pipeline.js";
const stage = stageFn;

/** 分镜提示词阶段（独立 stage，prompts.json 落盘） */
export async function stagePrompts(
	sc: StageCtx,
	script?: ScriptDoc,
	bible?: VisualBible,
): Promise<ShotPromptDoc> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	setStage(run, "prompts", "running", 10);
	pushEvent(run, "storyboard", "tech", "status", "分镜师开工：逐镜拆解画面描述与运镜，生成视频模型提示词。");
	throwIfAborted(signal);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	const bibleDoc = bible ?? (await readArtifact<VisualBible>(run, "visual-bible.json"));
	// 角色外观锚点：美术设计若已产出，注入逐镜 prompt（跨镜服装/发型一致性）
	const designDoc = await readArtifact<DesignBibleDoc>(run, "design-bible.json").catch(() => null);
	// 故事板（P3 消费）：script 阶段产出的 storyboard.json；旧 run 缺文件兜底 null（状态锚点静默跳过）
	const storyboardDoc = await readArtifact<StoryboardDoc>(run, "storyboard.json").catch(() => null);
	const shotPrompts = normalizeShotPrompts(
		await generateDoc<ShotPromptDoc>(
			sc,
			shotPromptMessages(run.brief, scriptDoc, bibleDoc, opts, designDoc, storyboardDoc),
			"",
			"prompts",
		),
		scriptDoc,
		bibleDoc,
		designDoc,
	);
	shotPrompts.promptVersion = PROMPT_VERSION;
	await writeJson(run, "prompts.json", shotPrompts);
	setStage(run, "prompts", "done", 100);
	return shotPrompts;
}
