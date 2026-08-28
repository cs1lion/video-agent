/**
 * stageVisual —— 美术设计阶段。
 * 收到剧本后：定风格 + 调色板 + 光线 → 产出 design-bible.json → 派生设计图（人物/道具/场景）。
 * 失败容忍：design 推导失败不阻断管线，事件告知用户。
 */

import {
	generateDoc,
	normalizeBible,
	type StageCtx,
} from "../pipeline.js";
import { type ScriptDoc, type VisualBible, visualBibleMessages } from "../prompts.js";
import { deriveDesignBible } from "./visual-derive.js";
import {
	optionsOf,
	pushEvent,
	readArtifact,
	refImageNote,
	setStage,
	throwIfAborted,
	writeJson,
} from "../pipeline.js";

/** 美术设计阶段（独立 stage，visual-bible.json 落盘） */
export async function stageVisual(sc: StageCtx, script?: ScriptDoc): Promise<VisualBible> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	setStage(run, "visual", "running", 10);
	pushEvent(run, "art", "writer", "status", "美术指导收到剧本，正在制定美术设计方案：风格基因、色板与光线。");
	throwIfAborted(signal);
	const bible = normalizeBible(
		await generateDoc<VisualBible>(sc, visualBibleMessages(run.brief, opts), refImageNote(run), "visual"),
	);
	await writeJson(run, "visual-bible.json", bible);
	setStage(run, "visual", "running", 40);
	const doc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	// 美术设计核心素材：人物/道具/场景概念图（失败容忍，不阻断管线）
	await deriveDesignBible(sc, doc, bible);
	setStage(run, "visual", "done", 100);
	pushEvent(
		run,
		"art",
		"storyboard",
		"handoff",
		`美术设计定稿：风格 [${bible.styleKeywords.join(" / ")}]，色板 ${bible.palette.slice(0, 4).join("、")}。人物形象与场景设定图已产出，后续关键帧与视频将严格以此为原料。`,
	);
	return bible;
}
