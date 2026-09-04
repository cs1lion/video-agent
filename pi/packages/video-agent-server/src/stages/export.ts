/**
 * stageExport —— 剪辑导出阶段。
 * 逐镜归一化（节奏 trim + J-cut）→ EDL 转场决策 → 时间线合成（xfade/混音/BGM/SFX/字幕，
 * 失败降级 concat）→ 质检（runQa）→ 跨镜一致性预检 → 收尾事件。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dialogueFor, edlPrompt, hasCameraMotion, narrationFor, type EdlDoc, type ScriptDoc } from "../prompts.ts";
import {
	appendSpan,
	optionsOf,
	pushEvent,
	readArtifact,
	setStage,
	throwIfAborted,
	type StageCtx,
} from "../pipeline.ts";
import {
	fallbackSubtitleTiming,
	measuredSubtitleTiming,
	wordTimestampSubtitleTiming,
} from "./export-subtitle.ts";
import {
	assembleTimeline,
	buildAssSubtitles,
	detectSpeechSegments,
	concatWithSubtitles,
	normalizeShot,
	probeDuration,
	SFX_LABEL,
	type SfxType,
	type SubtitleEntry,
	type TimelineShot,
	type TimelineSfx,
	type TimelineTransition,
	TRANSITION_LABEL,
	type TransitionType,
} from "../ffmpeg.ts";
import { chatJson } from "../llm.ts";
import { trackLlmCost } from "../pricing.ts";
import { runQa } from "../qa/review.ts";
import { checkConsistency } from "../consistency.ts";
import { pixelDimensions, type AspectRatio } from "../../../video-agent/src/index.ts";

/** 剪辑导出阶段（独立 stage） */
export async function stageExport(
	sc: StageCtx,
	script?: ScriptDoc,
	clipFiles?: (string | null)[],
	audioFiles?: (string | null)[],
): Promise<void> {
	const { run, ctx, signal } = sc;
	const opts = optionsOf(run);
	const scriptDoc = script ?? (await readArtifact<ScriptDoc>(run, "script.json"));
	setStage(run, "export", "running", 0);
	pushEvent(run, "editor", "reviewer", "status", "剪辑师开工：逐镜归一化 → 拼接 → 烧录字幕。");

	// clips/audio 阶段的产物在 refine/resume 场景下可能来自磁盘，这里统一从 assets 推导
	let clips = clipFiles;
	let audios = audioFiles;
	if (!clips || !audios) {
		clips = scriptDoc.shots.map((s) => {
			const raw = path.join(run.dir, "assets", `clip-${s.id}.mp4`);
			return fs.existsSync(raw) ? raw : null;
		});
		audios = scriptDoc.shots.map((s) => {
			const raw = path.join(run.dir, "assets", `tts-${s.id}.mp3`);
			return fs.existsSync(raw) ? raw : null;
		});
	}

	// ---- 画幅：重新导出时可指定其他画幅（多平台分发），默认生成时主画幅 ----
	const exportAspect: AspectRatio = run.exportAspectRatio ?? opts.aspectRatio;
	const isMainAspect = exportAspect === opts.aspectRatio;
	const finalName = isMainAspect ? "final.mp4" : `final-${exportAspect.replace(":", "x")}.mp4`;
	const { width, height } = pixelDimensions(opts.resolution, exportAspect);
	const normalized: string[] = [];
	const subtitles: SubtitleEntry[] = [];
	const keptShots = scriptDoc.shots.filter((_, i) => clips![i] !== null);
	const totalExportSteps = keptShots.length + 3; // 归一化 + EDL + 合成 + 质检
	let doneSteps = 0;

	// ---- 节奏 trim：按旁白实际时长定每镜时长（旁白 + 尾留白，剪掉空转） ----
	const NARR_TAIL_PAD = 0.7; // 旁白结束后画面留白
	// J-cut 已移除（2026-08-30 反馈"声音与画面抢"）：旁白与画面切点同步进入——
	// 提前 0.35s 的旁白会叠在上一镜画面尾巴上，观感是"声音抢画面"。
	const shotDur: number[] = [];
	const narrDur: (number | null)[] = [];
	for (const shot of keptShots) {
		const i = scriptDoc.shots.indexOf(shot);
		const audioRel = audios![i] ? path.relative(run.dir, audios![i]!) : null;
		// 台词镜无旁白 TTS 文件：节奏锚点用「原始台词人声时长」（垫尾静音不算镜长——
		// 2026-08-30 反馈：pad 版把 2s 台词垫到 5s，成片后半段大段死寂被听成"没声音"）
		const dur = audioRel
			? await probeDuration(audioRel, run.dir)
			: (shot.dialogue?.rawDurationSec ?? shot.dialogue?.audioDurationSec ?? null);
		narrDur.push(dur);
		shotDur.push(
			dur === null
				? opts.clipDurationSec // 无旁白：保持整段
				: Math.min(opts.clipDurationSec, Math.max(1.4, dur + NARR_TAIL_PAD)), // 上限=单镜时长设置（此前硬编码 5.5 导致选 10s 仍被裁成 ~5s）
		);
	}

	for (const shot of keptShots) {
		throwIfAborted(signal);
		const i = scriptDoc.shots.indexOf(shot);
		const k = keptShots.indexOf(shot);
		const out = `shot-${shot.id}.mp4`;
		const t0 = Date.now();
		try {
			// dubOver 镜（跟读校验未过）：口型视频保留，片源乱语音轨在归一化时即被
			// TTS 原声替换——成片里的每一句人话都是真台词
			const dubTtsRel = shot.dialogue?.dubOver
				? ([`assets/tts-dialogue-${shot.id}-pad.mp3`, `assets/tts-dialogue-${shot.id}.mp3`].find((rel) =>
						fs.existsSync(path.join(run.dir, rel)),
					) ?? null)
				: null;
			await normalizeShot({
				cwd: run.dir,
				clipPath: path.relative(run.dir, clips![i]!),
				audioPath: dubTtsRel ?? (audios![i] ? path.relative(run.dir, audios![i]!) : null),
				// 台词镜的对白在镜头自带音轨里：归一化时保留，降级 concat 路径才不丢声音（A3）
				keepSourceAudio: shot.audioMode === "dialogue" && !dubTtsRel,
				outPath: path.join("assets", out),
				width,
				height,
				fps: opts.fps,
				durationSec: shotDur[k]!,
				signal,
			});
			appendSpan(
				run,
				{
					stage: "export",
					name: `镜头 ${shot.id} 归一化`,
					kind: "ffmpeg",
					status: "ok",
					output: `${out}（${shotDur[k]!.toFixed(1)}s）`,
				},
				t0,
			);
		} catch (error) {
			appendSpan(
				run,
				{
					stage: "export",
					name: `镜头 ${shot.id} 归一化`,
					kind: "ffmpeg",
					status: "error",
					output: error instanceof Error ? error.message : String(error),
				},
				t0,
			);
			throw error;
		}
		normalized.push(`assets/${out}`);
		doneSteps += 1;
		setStage(run, "export", "running", Math.round((doneSteps / totalExportSteps) * 100));
	}
	// ---- EDL 转场决策：剪辑师 LLM 为每个切点选转场（失败兜底全 cut） ----
	let edl: EdlDoc | null = null;
	const tEdl = Date.now();
	try {
		const edlShots = keptShots.map((s, k) => ({
			id: s.id,
			durationSec: shotDur[k]!,
			narration: narrationFor(s, opts.promptLanguage).trim().slice(0, 40),
			visual: s.visual.slice(0, 80),
		}));
		const edlText = edlPrompt(edlShots);
		edl = await chatJson<EdlDoc>(ctx.llm, edlText, signal);
		run.metrics.llmCalls += 1;
		trackLlmCost(run, ctx, edlText, JSON.stringify(edl));
		appendSpan(
			run,
			{
				stage: "export",
				name: "剪辑决策（转场 EDL）",
				kind: "llm",
				status: "ok",
				input: `${keptShots.length} 镜节奏表`,
				output: (edl.transitions ?? []).map((t) => `${t.after}:${t.type}`).join(" ") || "空（按 cut 处理）",
			},
			tEdl,
		);
	} catch (error) {
		appendSpan(
			run,
			{
				stage: "export",
				name: "剪辑决策（转场 EDL）",
				kind: "llm",
				status: "error",
				input: "镜头节奏表",
				output: `${error instanceof Error ? error.message : String(error)}（降级为全硬切）`,
			},
			tEdl,
		);
	}
	const VALID_TRANSITIONS: TransitionType[] = ["cut", "fade", "dip", "white", "wipeleft", "slideup"];
	const VALID_SFX: SfxType[] = ["whoosh", "impact", "riser"];
	const transitions: TimelineTransition[] = [];
	for (let i = 0; i < keptShots.length - 1; i += 1) {
		const raw = (edl?.transitions ?? []).find((t) => Number(t.after) === i + 1);
		const type = VALID_TRANSITIONS.includes(raw?.type as TransitionType) ? (raw!.type as TransitionType) : "cut";
		const dur = type === "cut" ? 0 : Math.min(0.8, Math.max(0.3, Number(raw?.durationSec) || 0.5));
		// 音效：合法值按 LLM 决策；非 cut 转场缺省兜底 whoosh，cut 缺省无声
		const sfxType = VALID_SFX.includes(raw?.sfx as SfxType)
			? (raw!.sfx as SfxType)
			: type !== "cut"
				? "whoosh"
				: null;
		transitions.push({ afterShotIndex: i, type, durationSec: dur, sfxType });
	}
	// 2026-09-01 拼接感兜底：邻镜 clip prompt 含运镜词且转场 ≠ cut → 强制 cut（避免 xfade + zoom 出现可见拼接缝）
	// 查的是 prompts.json（实际发给视频模型的 prompt），不是 script.json 的 visual（后者可能是 user 原稿）。
	// 这是 EDL prompt 规则 5/6 的服务端二次保险——LLM 可能漏判。
	let clipPromptsByShotId: Map<string, string> = new Map();
	try {
		const promptsDoc = await readArtifact<{ prompts?: { shotId: string; prompt: string }[] }>(run, "prompts.json");
		for (const p of promptsDoc?.prompts ?? []) clipPromptsByShotId.set(p.shotId, p.prompt);
	} catch {
		// prompts.json 不存在（理论上不会）——降级查 scriptDoc.shots[].visual
	}
	const motionDowngrades: number[] = [];
	for (let i = 0; i < keptShots.length - 1; i += 1) {
		const sourceText = clipPromptsByShotId.get(keptShots[i]?.id ?? "") ?? keptShots[i]?.visual ?? "";
		const targetText = clipPromptsByShotId.get(keptShots[i + 1]?.id ?? "") ?? keptShots[i + 1]?.visual ?? "";
		const sourceMoves = hasCameraMotion(sourceText);
		const targetMoves = hasCameraMotion(targetText);
		if ((sourceMoves || targetMoves) && transitions[i]!.type !== "cut") {
			transitions[i]!.type = "cut";
			transitions[i]!.durationSec = 0;
			transitions[i]!.sfxType = null;
			motionDowngrades.push(i);
		} else if (transitions[i]!.type === "cut" && transitions[i]!.sfxType) {
			// cut 不应该残留 sfx：残留一般来自 LLM 错误输出，这里顺手清干净
			transitions[i]!.sfxType = null;
		}
	}
	if (motionDowngrades.length > 0) {
		pushEvent(
			run,
			"editor",
			"sound",
			"status",
			`⚠️ 拼接安全：${motionDowngrades.length} 个切点邻镜含运镜词，已强制硬切（防 xfade + 镜头拉伸可见拼接），切点序号 ${motionDowngrades.map((n) => n + 1).join("、")}。`,
		);
	}
	await fs.promises
		.writeFile(
			path.join(run.dir, "transitions.json"),
			JSON.stringify({ transitions, shotDur, generatedAt: new Date().toISOString() }, null, "\t"),
			"utf-8",
		)
		.catch(() => {});
	doneSteps += 1;
	setStage(run, "export", "running", Math.round((doneSteps / totalExportSteps) * 100));

	// ---- 时间轴：镜头起点（转场重叠吃时长）+ J-cut 旁白起点 + SFX 起点 + 字幕 ----
	const shotStart: number[] = [];
	const narrStart: number[] = [];
	const sfxTimeline: TimelineSfx[] = [];
	let cursor = 0;
	for (let i = 0; i < keptShots.length; i += 1) {
		shotStart.push(cursor);
		narrStart.push(cursor); // 旁白与本镜画面同步进入（无 J-cut）
		const t = i < transitions.length ? transitions[i]! : undefined;
		const overlap = t && t.type !== "cut" ? t.durationSec : 0;
		if (t?.sfxType) {
			// 音效略先于切点入（提前 0.1s），时长对齐转场时长（0.3-0.9s）
			const tStart = cursor + shotDur[i]! - overlap;
			sfxTimeline.push({
				startSec: Math.max(0, tStart - 0.1),
				type: t.sfxType,
				durationSec: Math.min(0.9, Math.max(0.3, t.durationSec || 0.5)),
			});
		}
		cursor += shotDur[i]! - overlap;
	}
	const narrationTexts = keptShots.map((s) =>
		s.audioMode === "dialogue"
			? dialogueFor(s, opts.promptLanguage).trim() || narrationFor(s, opts.promptLanguage).trim()
			: narrationFor(s, opts.promptLanguage).trim(),
	);
	for (let i = 0; i < keptShots.length; i += 1) {
		if (!narrationTexts[i]) continue;
		if (keptShots[i]!.audioMode === "dialogue") {
			// 台词镜：字幕起止锚到实测人声（与口型/铺入的 TTS 同步）；
			// 2026-08-30 反馈"台词几乎看不到"——此前只有旁白上字幕。
			// 三层回退：①词级时间戳 → ②silencedetect 实测 → ③三重收束（见 export-subtitle.ts）。
			const nextShotStart = i + 1 < keptShots.length ? shotStart[i + 1]! : Number.POSITIVE_INFINITY;
			const speechSec = keptShots[i]!.dialogue?.rawDurationSec ?? keptShots[i]!.dialogue?.audioDurationSec ?? shotDur[i]!;
			const wordTs = keptShots[i]!.dialogue?.wordTimestamps;
			const args = {
				shotStart: shotStart[i]!,
				shotDur: shotDur[i]!,
				nextShotStart,
				speechSec,
				wordTimestamps: wordTs,
			};
			let resolved = wordTimestampSubtitleTiming(args);
			if (!resolved) {
				const ttsRel =
					[`assets/tts-dialogue-${keptShots[i]!.id}-pad.mp3`, `assets/tts-dialogue-${keptShots[i]!.id}.mp3`].find((rel) =>
						fs.existsSync(path.join(run.dir, rel)),
					) ?? null;
				if (ttsRel) {
					try {
						const segs = await detectSpeechSegments(run.dir, ttsRel, signal);
						resolved = measuredSubtitleTiming(args, segs);
					} catch {
						// 实测失败用回落值
					}
				}
			}
			const finalTiming = resolved ?? fallbackSubtitleTiming(args);
			subtitles.push({ start: finalTiming.subStart, duration: finalTiming.subDur, text: narrationTexts[i]! });
			continue;
		}
		const nextStart = i + 1 < keptShots.length ? narrStart[i + 1] : cursor;
		// 补遗 §7：旁白字幕同样不能超过当前镜视频边界。
		const dur = Math.max(0.8, Math.min(
			(narrDur[i] ?? 1.5) + 0.3,
			nextStart - narrStart[i],
			shotStart[i]! + shotDur[i]! - narrStart[i]!,
		));
		subtitles.push({ start: narrStart[i]!, duration: dur, text: narrationTexts[i]! });
	}

	// ---- 合成：xfade 转场链 + 旁白 J-cut 定位 + BGM 闪避 + SFX 音效层（失败降级 concat） ----
	const assPath = path.join("assets", "subs.ass");
	const assText = buildAssSubtitles(subtitles, width, height);
	await fs.promises.writeFile(path.join(run.dir, assPath), assText, "utf-8");
	const finalPath = path.join("assets", finalName);
	const BGM_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"];
	const bgmPath =
		BGM_EXTS.map((e) => path.join("assets", `bgm${e}`)).find((p) => fs.existsSync(path.join(run.dir, p))) ?? null;
	const timelineShots: TimelineShot[] = keptShots.map((s, k) => {
		const isDialogue = s.audioMode === "dialogue";
		return {
			path: normalized[k]!,
			durationSec: shotDur[k]!,
			// 台词镜（A3）：对白随音频驱动生成就在镜头音轨里，走 keepSourceAudio 进对白层；
			// 不再挂旁白输入，否则同一句台词会叠两次声。
			narrationPath: isDialogue
				? null
				: audios![scriptDoc.shots.indexOf(s)] != null && narrDur[k] !== null
					? path.relative(run.dir, audios![scriptDoc.shots.indexOf(s)]!)
					: null,
			narrationStartSec: narrStart[k]!,
			narrationDurationSec: narrDur[k] ?? 0,
			subtitle: narrationTexts[k] || null,
			keepSourceAudio: isDialogue,
		};
	});
	const tConcat = Date.now();
	let totalSec = cursor;
	let usedTransitions = 0;
	let sfxUsed = 0;
	let degraded = false;
	try {
		const info = await assembleTimeline({
			cwd: run.dir,
			shots: timelineShots,
			transitions,
			sfx: sfxTimeline,
			bgmPath,
			assPath,
			outPath: finalPath,
			signal,
		});
		totalSec = info.totalSec;
		usedTransitions = info.usedTransitions;
		sfxUsed = info.sfxUsed;
	} catch (error) {
		// xfade/混音滤镜失败：降级为 concat demuxer（旁白已嵌入各镜，字幕照常烧录，转场/音效/响度处理丢失）
		degraded = true;
		appendSpan(
			run,
			{
				stage: "export",
				name: "时间线合成（转场+混音）",
				kind: "ffmpeg",
				status: "error",
				input: `转场 ${usedTransitions} · SFX ${sfxTimeline.length} · BGM ${bgmPath ? "有" : "无"}`,
				output: `${error instanceof Error ? error.message : String(error)}（降级 concat 硬拼）`,
			},
			tConcat,
		);
		await concatWithSubtitles({ cwd: run.dir, shotPaths: normalized, assPath, outPath: finalPath, signal });
		totalSec = shotDur.reduce((sum, d) => sum + d, 0);
	}
	run.finalFile = finalName;
	const transSummary = transitions
		.filter((t) => t.type !== "cut")
		.map((t) => `${TRANSITION_LABEL[t.type]} ${t.durationSec.toFixed(1)}s`)
		.join("、");
	const sfxSummary = sfxTimeline.map((s) => SFX_LABEL[s.type]).join("、");
	appendSpan(
		run,
		{
			stage: "export",
			name: "时间线合成（转场+混音）",
			kind: "ffmpeg",
			status: "ok",
			input: `${transSummary || "全硬切"}${bgmPath ? " · BGM 铺底闪避" : ""}${sfxSummary ? ` · SFX ${sfxSummary}` : ""} · 响度 -14 LUFS`,
			output: `${finalName}（${keptShots.length} 镜 · ${totalSec.toFixed(1)}s · ${usedTransitions} 处转场 · ${sfxUsed} 处音效${degraded ? " · 已降级" : ""}）`,
		},
		tConcat,
	);
	doneSteps += 1;
	setStage(run, "export", "running", Math.round((doneSteps / totalExportSteps) * 100));
	pushEvent(
		run,
		"editor",
		"reviewer",
		"handoff",
		`粗剪完成（${keptShots.length} 镜 · ${totalSec.toFixed(1)}s · ${opts.resolution} ${exportAspect}${isMainAspect ? "" : " 版"}，转场：${transSummary || "全硬切"}${sfxSummary ? `，音效：${sfxSummary}` : ""}${bgmPath ? "，BGM 铺底" : ""}，响度 -14 LUFS），移交审片员质检。`,
		{ stage: "export", focus: "final", label: "播放成片" },
	);

	// ---- 质检：逐镜双帧抽检（新时间轴中点 + 后段 85% 处） → 视觉模型评分 ----
	// 抽帧位置必须与实际成片时间轴一致：xfade 路径的 shotStart 按转场重叠递减累计；
	// 降级 concat 是无重叠硬拼（总长 = ΣshotDur），若仍用旧 shotStart 会系统性偏早，
	// 累积几镜后（每处转场 0.3-0.8s）抽到前一镜画面，QA 评分失真。
	// 后段帧专治瞬时缺陷（多指/形变/乱码字形常只在一瞬间出现），单中点帧会漏。
	const qaMidpoints: number[] = [];
	const qaLateTimes: number[] = [];
	if (degraded) {
		let acc = 0;
		for (let k = 0; k < keptShots.length; k += 1) {
			qaMidpoints.push(acc + shotDur[k]! / 2);
			qaLateTimes.push(acc + shotDur[k]! * 0.85);
			acc += shotDur[k]!;
		}
	} else {
		for (let k = 0; k < keptShots.length; k += 1) {
			qaMidpoints.push(shotStart[k]! + shotDur[k]! / 2);
			qaLateTimes.push(shotStart[k]! + shotDur[k]! * 0.85);
		}
	}
	// audioSync 口径修正（2026-08-31）：旧口径「旁白 TTS 成功率」——台词镜对白走 dialogue-audio
	// 链路，audioFiles 里恒为 null，只数旁白 → G1 0/5=0 假象（批次数据被系统性拉低）。
	// 新口径 = 全语音镜语音就绪率：分母 = 应有语音的镜（narrationTexts 非空，含台词镜），
	// 分子 = 语音文件已就绪（旁白 tts-SHxx.mp3 或台词 tts-dialogue-SHxx.mp3/-pad）；
	// 无语音镜不进分母。仍是确定性计算，不编造分数。
	let voiceExpected = 0;
	let voiceReady = 0;
	for (const [k, shot] of keptShots.entries()) {
		if (!narrationTexts[k]) continue;
		voiceExpected += 1;
		const i = scriptDoc.shots.indexOf(shot);
		const dialogueReady = [
			`assets/tts-dialogue-${shot.id}.mp3`,
			`assets/tts-dialogue-${shot.id}-pad.mp3`,
		].some((rel) => fs.existsSync(path.join(run.dir, rel)));
		if (audios![i] || dialogueReady) voiceReady += 1;
	}
	const audioSync = voiceExpected > 0 ? Math.round((voiceReady / voiceExpected) * 100) : 100;
	run.verdict = await runQa(sc, keptShots, opts, finalPath, audioSync, qaMidpoints, qaLateTimes, {
		assText,
		expectedLines: narrationTexts.filter((t) => t.trim()).length,
	});
	doneSteps += 1;
	setStage(run, "export", "running", Math.round((doneSteps / totalExportSteps) * 100));

	// ---- 跨镜一致性预检（自动跑，先于用户）：发色/服装/画风突变等跨镜问题，不靠用户主动点按钮 ----
	let consistencyIssues = 0;
	try {
		const consistencyDoc = await checkConsistency(sc.ctx, run, signal);
		const flagged = consistencyDoc.shots.filter((s) => s.issues.length > 0);
		consistencyIssues = flagged.length;
		if (flagged.length > 0) {
			pushEvent(
				run,
				"reviewer",
				"client",
				"qa",
				`跨镜一致性预检 ⚠️ ${flagged.length} 处异常：${flagged
					.map((s) => `${s.shotId}${s.appearance ? `（${s.appearance.slice(0, 30)}）` : ""}`)
					.join("、")}。可在质量审读页查看详情并补拍。`,
				{ stage: "review", label: "查看一致性" },
			);
		}
	} catch (error) {
		// 一致性失败不阻断出片（仅记日志+事件）
		appendSpan(
			run,
			{
				stage: "export",
				name: "跨镜一致性预检",
				kind: "qa",
				status: "error",
				output: error instanceof Error ? error.message : String(error),
			},
			Date.now(),
		);
		pushEvent(
			run,
			"reviewer",
			"producer",
			"status",
			`跨镜一致性预检跳过 ⚠️（${error instanceof Error ? error.message : String(error)}）。可在质量审读页手动重跑。`,
		);
	}

	setStage(run, "export", "done", 100);
	const v = run.verdict;
	if (v.axes.length > 0) {
		const worst = [...v.axes].sort((a, b) => a.score - b.score)[0];
		const fails = (v.shots ?? []).filter((s) => s.verdict === "fail");
		const failNote =
			fails.length > 0
				? `不合格镜头：${fails.map((s) => `${s.id}（${s.reason}）`).join("；")}。可在质检面板逐镜重做。`
				: "";
		const consistencyNote =
			consistencyIssues > 0 ? `。另有 ${consistencyIssues} 处跨镜一致性异常请关注` : "";
		pushEvent(
			run,
			"reviewer",
			"producer",
			"qa",
			`质检结论：${v.overall === "pass" ? "通过 ✅" : v.overall === "warn" ? "有保留通过 ⚠️" : "不通过 ❌"}（综合 ${v.score}）。最短板 ${worst.id} ${worst.score} 分${consistencyNote}。${failNote}`,
		);
	}
}
