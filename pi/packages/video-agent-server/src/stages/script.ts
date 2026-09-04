/**
 * stageScript —— 剧本阶段。
 * 解析需求 → 搭建 N 镜叙事骨架 → 落盘 script.json。
 * 若模型两次未命中镜头数：宽容通过 + 事件告知用户（下游对镜头数宽容）。
 */

import { scriptMessages, type ScriptDoc } from "../prompts.js";
import {
	availableVoices,
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

	// 2026-09-01 补遗 §4 根治点：user 提供 scriptIntent 时跳过 LLM 编剧，直接采用。
	// 避免 LLM director 自由重写 audioMode（如 B剧 SH06 从 dialogue 被改为 narration）
	// 或替换台词。仍走 normalizeScript + 台词守卫，保证下游阶段拿到合法 ScriptDoc。
	const userIntent = run.brief.coSpace?.scriptIntent;
	if (userIntent && userIntent.shots.length > 0) {
		const title = userIntent.title ?? run.brief.creative.logline.slice(0, 40);
		const logline = userIntent.logline ?? run.brief.creative.logline;
		const shots = userIntent.shots.map((s) => ({
			id: s.id,
			visual: s.visual,
			durationSec: s.durationSec ?? opts.clipDurationSec,
			narrationZh: s.narrationZh ?? "",
			narrationEn: s.narrationEn ?? "",
			audioMode: (s.audioMode ?? "narration") as "dialogue" | "narration" | "silent",
			...(s.dialogue
				? {
						dialogue: {
							characterId: s.dialogue.characterId,
							lines: { zh: s.dialogue.lines.zh, en: s.dialogue.lines.en ?? "" },
							...(s.dialogue.emotion ? { emotion: s.dialogue.emotion } : {}),
						},
					}
				: {}),
		}));
		let script: ScriptDoc = { title, logline, shots };
		script = normalizeScript(script, opts);
		pushEvent(
			run,
			"writer",
			"producer",
			"status",
			`用户提供了 scriptIntent，跳过 LLM 编剧，采用 ${script.shots.length} 镜用户剧本（补遗 §4 根治点）。`,
		);
		// 台词模式守卫同样适用（dialogueCount 计数）
		if (opts.audioDrive === "dialogue") {
			const dialogueCount = script.shots.filter((s) => s.audioMode === "dialogue").length;
			const required = Math.max(2, Math.ceil(opts.shotCount / 2));
			if (dialogueCount < required) {
				pushEvent(
					run,
					"writer",
					"producer",
					"status",
					`用户剧本对白密度不足（${dialogueCount} 镜有对白，要求 ≥${required}）——以用户为准，不重写。`,
				);
			}
		}
		// D1 闸门同样跑（多角色对白拆镜）
		if (opts.audioDrive === "dialogue") {
			const enforced = enforceSingleSpeaker(script);
			script = enforced.script;
			for (const warning of enforced.warnings) {
				pushEvent(run, "writer", "producer", "status", `⚠️ ${warning}`);
			}
		}
		// A7 音色绑定 —— 同样以 user 剧本的 characterId 为准
		script = bindCharacterVoices(script, run.brief.coSpace, availableVoices(sc.ctx));
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
	// 对白密度守卫（2026-08-30 压力轮实证）：台词模式下 LLM 可能整本写成旁白
	//（S1 电台片六镜 0 对白，brief 明确"四轮对讲"）——不足即带强化反馈重写一次。
	if (opts.audioDrive === "dialogue") {
		const dialogueCount = script.shots.filter((s) => s.audioMode === "dialogue").length;
		const required = Math.max(2, Math.ceil(opts.shotCount / 2));
		if (dialogueCount < required) {
			pushEvent(
				run,
				"writer",
				"producer",
				"status",
				`⚠️ 剧本对白密度不足（${dialogueCount} 镜有对白，brief 要求 ≥${required}）——强化重写一次。`,
			);
			throwIfAborted(signal);
			script = await generateDoc<ScriptDoc>(
				sc,
				scriptMessages(
					run.brief,
					opts,
					`上一次生成的剧本只有 ${dialogueCount} 个 dialogue 镜，不达标。brief 明确要求多轮对讲：本次必须让至少 ${required} 个镜头是 dialogue（每轮对白一个独立镜头，让角色开口说出台词），narration 仅限开场/收尾各至多一镜，严禁用旁白转述本该角色说的话。`,
				),
				refImageNote(run),
				"script",
			);
			script = normalizeScript(script, opts);
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
	// A7 音色绑定 + 配音选角：显式绑定优先；未绑定的角色按人物设计自动分配（同片去重）。
	// catalog 传入音色库——旁白音色错开也依赖这份分配结果。
	script = bindCharacterVoices(script, run.brief.coSpace, availableVoices(sc.ctx));
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
