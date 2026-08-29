/**
 * stageScript —— 剧本阶段。
 * 解析需求 → 搭建 N 镜叙事骨架 → 落盘 script.json。
 * 若模型两次未命中镜头数：宽容通过 + 事件告知用户（下游对镜头数宽容）。
 */

import { scriptMessages, type ScriptDoc } from "../prompts.js";
import {
	generateDoc,
	normalizeScript,
	optionsOf,
	pushEvent,
	refImageNote,
	setStage,
	throwIfAborted,
	writeJson,
} from "../pipeline.js";
import type { StageCtx } from "../pipeline.js";
import { enforceSingleSpeaker, bindCharacterVoices } from "../audio-mode.js";

/** 剧本阶段（独立 stage，script.json 落盘） */
export async function stageScript(sc: StageCtx): Promise<ScriptDoc> {
	const { run, signal } = sc;
	const opts = optionsOf(run);
	setStage(run, "script", "running", 10);
	pushEvent(run, "writer", "producer", "status", `编剧开工：解析需求，搭建 ${opts.shotCount} 镜叙事骨架。`);
	throwIfAborted(signal);
	let script = await generateDoc<ScriptDoc>(sc, scriptMessages(run.brief, opts), refImageNote(run), "script");
	script = normalizeScript(script, opts);
	if (script.shots.length !== opts.shotCount) {
		throwIfAborted(signal);
		const fixed = await generateDoc<ScriptDoc>(
			sc,
			scriptMessages(run.brief, opts),
			refImageNote(run),
			"script",
		);
		script = normalizeScript(fixed, opts);
		// 两次都未命中数量：不硬跑失败（下游对镜头数本身宽容），但必须让用户知情
		if (script.shots.length !== opts.shotCount) {
			pushEvent(
				run,
				"writer",
				"producer",
				"status",
				`⚠️ 编剧两轮均未给出设定的 ${opts.shotCount} 镜（实际 ${script.shots.length} 镜），已按实际镜头数继续。可在「剧本」阶段微调后重跑。`,
			);
		}
	}
	// D1 闸门前置：台词模式下多角色对白必须拆镜。落盘前拦截——用户写完才发现
	// 要拆镜的返工成本太高（且已烧 script 阶段配额）。违规镜降级为旁白，不阻断。
	if (opts.audioDrive === "dialogue") {
		const enforced = enforceSingleSpeaker(script);
		script = enforced.script;
		for (const warning of enforced.warnings) {
			pushEvent(run, "writer", "producer", "status", `⚠️ ${warning}`);
		}
	}
	// A7 音色绑定：共创角色卡上的 voiceId 按 characterId 注入台词镜（LLM 拿不到音色 id）。
	script = bindCharacterVoices(script, run.brief.coSpace);
	await writeJson(run, "script.json", script);
	setStage(run, "script", "done", 100);
	pushEvent(
		run,
		"writer",
		"art",
		"handoff",
		`剧本《${script.title}》完成：${script.shots.length} 镜，${script.shots.reduce((a, s) => a + s.durationSec, 0)}s。Logline：${script.logline}。请据此制定全片视觉规范。`,
	);
	return script;
}
