/**
 * composeCut —— 组合出片（按勾选版本装配交付版 cut{N}.mp4，N 从 1 起）。
 *
 * 关键设计：
 * 1. 限次护栏：MAX_COMPOSE_PER_RUN = 2（不烧模型额度，仅本地 ffmpeg 装配）
 * 2. 版本选择：listShotVersions 列出每镜视频/音频版本，用户勾选后 pickVersion 解析
 * 3. 剪辑复用：复用 stageExport 的转场/混音/字幕逻辑（不重复维护两套算法）
 * 4. 同步占位 + 异步 IIFE：与 reexportRun 模式一致（立即返 ok，IIFE 跑实际装配）
 * 5. 计数落盘：每次成功组合写 cuts.json（cuts.used），超上限拒
 * 6. run.redoActive 标记与清理
 *
 * 调用方：POST /api/runs/:id/compose
 * 依赖：pipeline.ts 的 cuts.json 持久化 + ffmpeg normalizeShot/assembleTimeline
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	assembleTimeline,
	buildAssSubtitles,
	normalizeShot,
	probeDuration,
	type SfxType,
	type SubtitleEntry,
	type TimelineSfx,
	type TimelineShot,
	type TimelineTransition,
	type TransitionType,
} from "../ffmpeg.ts";
import { narrationFor, type ScriptDoc } from "../prompts.ts";
import { pixelDimensions } from "../../../video-agent/src/generation/options.ts";
import {
	optionsOf,
	persistRun,
	pushEvent,
	readArtifact,
	type RunRecord,
	writeJson,
} from "../pipeline.ts";

/** 组合出片限次：单任务上限 2 次（不烧模型额度，仅本地 ffmpeg 装配） */
export const MAX_COMPOSE_PER_RUN = 2;

/** 旁白尾留白：J-cut 旁白结束后画面留白 */
const COMPOSE_NARR_TAIL_PAD = 0.7;

/** J-cut：下一镜旁白较画面切点提前 */
const COMPOSE_JCUT_LEAD = 0.35;

/** cuts.json 账本（每镜可组合的视频/音频版本） */
export interface CutsDoc {
	used: number;
	renders: {
		file: string;
		at: string;
		selections: Record<string, { video: string | null; audio: string | null }>;
	}[];
}

/** 视图层 CutsView（API 端点用） */
export interface CutsView {
	used: number;
	max: number;
	renders: { file: string; at: string }[];
}

/** 每镜可用版本清单（最新在前，历史 _v{n} 随后；仅含实际存在的文件） */
export interface ShotVersionInfo {
	shotId: string;
	video: { file: string; url: string; label: string }[];
	audio: { file: string; url: string; label: string }[];
}

/** 中止检查（pipeline.ts 内部 helper 的副本） */
function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("已中止");
}

/** 汇总每镜可组合的视频/音频版本（供剪辑台选择） */
export async function listShotVersions(run: RunRecord): Promise<ShotVersionInfo[]> {
	let shots: { id: string }[] = [];
	try {
		shots = (await readArtifact<ScriptDoc>(run, "script.json")).shots;
	} catch {
		return [];
	}
	const assetsDir = path.join(run.dir, "assets");
	const urlOf = (file: string): string =>
		`/api/runs/${encodeURIComponent(run.id)}/files/${file.split(/[\\/]/).join("/")}`;
	const listOf = (shotId: string, prefix: "clip" | "tts", ext: string): ShotVersionInfo["video"] => {
		const list: ShotVersionInfo["video"] = [];
		const main = `${prefix}-${shotId}${ext}`;
		if (fs.existsSync(path.join(assetsDir, main))) list.push({ file: main, url: urlOf(main), label: "最新" });
		const history = prefix === "clip" ? run.shotVersions[shotId] : run.ttsVersions[shotId];
		for (const v of history ?? []) {
			if (!fs.existsSync(path.join(run.dir, v))) continue;
			const n = /_v(\d+)\./.exec(v)?.[1] ?? String(list.length);
			list.push({ file: path.basename(v), url: urlOf(path.basename(v)), label: `v${n}` });
		}
		return list;
	};
	return shots.map((s) => ({
		shotId: s.id,
		video: listOf(s.id, "clip", ".mp4"),
		audio: listOf(s.id, "tts", ".mp3"),
	}));
}

function pickVersion(want: unknown, list: ShotVersionInfo["video"]): string | null {
	if (want == null || want === "") return list[0]?.file ?? null;
	return list.find((v) => v.file === want)?.file ?? null;
}

/** SFX 类型白名单（与 ffmpeg.ts 同步） */
const VALID_SFX: readonly string[] = ["whoosh", "impact", "riser"];

async function readCuts(run: RunRecord): Promise<CutsDoc> {
	try {
		return await readArtifact<CutsDoc>(run, "cuts.json");
	} catch {
		return { used: 0, renders: [] };
	}
}

async function persistCuts(run: RunRecord, doc: CutsDoc): Promise<void> {
	await writeJson(run, "cuts.json", doc);
}

interface ScriptShotLike {
	id: string;
	visual: string;
	narrationZh: string;
	narrationEn: string;
	durationSec: number;
}
interface ScriptDocLike {
	shots: ScriptShotLike[];
}

/** 组合出片：按每镜选定的视频/音频版本装配一条 cut{N}.mp4 */
export async function composeCut(
	run: RunRecord,
	selections: Record<string, { video?: unknown; audio?: unknown }>,
): Promise<{ ok: boolean; error?: string; remaining?: number; file?: string }> {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };

	// ---- 读取 cuts 持久化账本，超上限拒 ----
	const cuts = await readCuts(run);
	if (cuts.used >= MAX_COMPOSE_PER_RUN) {
		return { ok: false, remaining: 0, error: `组合出片已用满 ${MAX_COMPOSE_PER_RUN} 次（单次任务上限）。如需再调整，请在对应阶段微调后重新导出成片。` };
	}
	const seq = cuts.used + 1;

	// ---- 读取剧本 + 镜头版本清单 + 用户选择 ----
	let shots: ScriptShotLike[];
	try {
		shots = (await readArtifact<ScriptDocLike>(run, "script.json")).shots;
	} catch {
		return { ok: false, error: "剧本产物缺失，无法定位镜头" };
	}
	const versions = await listShotVersions(run);
	if (versions.length === 0) return { ok: false, error: "暂无可组合的镜头资产" };

	const chosen = new Map<string, { video: string | null; audio: string | null }>();
	for (const shot of versions) {
		const sel = selections[shot.shotId] ?? {};
		const video = pickVersion(sel.video, shot.video);
		const audio = pickVersion(sel.audio, shot.audio);
		if ((sel.video != null && sel.video !== "" && !video) || (!video && shot.video.length > 0)) {
			return { ok: false, error: `镜头 ${shot.shotId} 的视频版本不可用` };
		}
		if (sel.audio != null && sel.audio !== "" && !audio) {
			return { ok: false, error: `镜头 ${shot.shotId} 的音频版本不可用` };
		}
		chosen.set(shot.shotId, { video, audio });
	}

	pushEvent(
		run,
		"editor",
		"client",
		"user",
		`请求组合出片（第 ${seq}/${MAX_COMPOSE_PER_RUN} 次）：${versions
			.map((s) => {
				const c = chosen.get(s.shotId);
				const vLabel = c?.video ? s.video.find((v) => v.file === c.video)?.label ?? "无" : "无";
				const aLabel = c?.audio ? s.audio.find((a) => a.file === c.audio)?.label ?? "自定" : "无声";
				return `${s.shotId}(画${vLabel}/音${aLabel})`;
			})
			.join("、")}。`,
	);

	// ---- 装配 ----
	const script = await readArtifact<ScriptDocLike>(run, "script.json");
	const opts = optionsOf(run);
	const signal = run.abort.signal;
	const keptShots = script.shots.filter((shot) => chosen.get(shot.id)?.video != null);
	if (keptShots.length === 0) return { ok: false, error: "所选组合中没有可装配的镜头" };

	// ---- 转场沿用剪辑师决策表（无则全硬切） ----
	type SavedTransition = { afterShotIndex: number; type: string; durationSec?: number; sfxType?: string };
	let savedTransitions: SavedTransition[] = [];
	try {
		const t = await readArtifact<{ transitions?: SavedTransition[] }>(run, "transitions.json");
		savedTransitions = t?.transitions ?? [];
	} catch {
		savedTransitions = [];
	}
	const VALID: TransitionType[] = ["cut", "fade", "dip", "white", "wipeleft", "slideup"];
	const transitions: TimelineTransition[] = [];
	for (let i = 0; i < keptShots.length - 1; i += 1) {
		const raw = savedTransitions.find((x) => x.afterShotIndex === i);
		const type = VALID.includes(raw?.type as TransitionType) ? (raw!.type as TransitionType) : "cut";
		const dur = type === "cut" ? 0 : Math.min(0.8, Math.max(0.3, Number(raw?.durationSec) || 0.5));
		const sfxType: SfxType | null = (() => {
		const v = raw?.sfxType;
		if (v && (VALID_SFX as readonly string[]).includes(v)) return v as SfxType;
		return type !== "cut" ? ("whoosh" as SfxType) : null;
	})();
		transitions.push({ afterShotIndex: i, type, durationSec: dur, sfxType });
	}

	// ---- 时长按所选旁白实际长度重排（与主成片同一节奏公式） ----
	const { width, height } = pixelDimensions(opts.resolution, opts.aspectRatio);
	const shotDur: number[] = [];
	const narrDur: (number | null)[] = [];
	for (const shot of keptShots) {
		const audioRel = chosen.get(shot.id)?.audio ? `assets/${chosen.get(shot.id)!.audio}` : null;
		const dur = audioRel ? await probeDuration(audioRel, run.dir) : null;
		narrDur.push(dur);
		shotDur.push(
			dur === null
				? opts.clipDurationSec
				: Math.min(opts.clipDurationSec, Math.max(1.4, dur + COMPOSE_NARR_TAIL_PAD)),
		);
	}

	// ---- 同步占位 + 异步 IIFE ----
	const prevStatus = run.status;
	run.status = "running";
	try {
		// ---- 时间轴定位 + J-cut 旁白 + SFX + 字幕 ----
		const shotStart: number[] = [];
		const narrStart: number[] = [];
		const sfxTimeline: TimelineSfx[] = [];
		let cursor = 0;
		for (let i = 0; i < keptShots.length; i += 1) {
			shotStart.push(cursor);
			narrStart.push(i > 0 ? Math.max(0, cursor - COMPOSE_JCUT_LEAD) : 0);
			const t = i < transitions.length ? transitions[i]! : undefined;
			const overlap = t && t.type !== "cut" ? t.durationSec : 0;
			if (t?.sfxType) {
				const tStart = cursor + shotDur[i]! - overlap;
				sfxTimeline.push({
					startSec: Math.max(0, tStart - 0.1),
					type: t.sfxType,
					durationSec: Math.min(0.9, Math.max(0.3, t.durationSec || 0.5)),
				});
			}
			cursor += shotDur[i]! - overlap;
		}

		// ---- 归一化每镜（ffmpeg 切到统一画幅 + 重采样 + 烧字幕） ----
		const normalized: string[] = [];
		for (const [k, shot] of keptShots.entries()) {
			throwIfAborted(signal);
			const videoBase = chosen.get(shot.id)!.video!;
			const out = `cut${seq}-shot-${shot.id}.mp4`;
			await normalizeShot({
				cwd: run.dir,
				clipPath: `assets/${videoBase}`,
				audioPath: chosen.get(shot.id)?.audio ? `assets/${chosen.get(shot.id)!.audio}` : null,
				outPath: path.join("assets", out),
				width,
				height,
				fps: opts.fps,
				durationSec: shotDur[k]!,
				signal,
			});
			normalized.push(`assets/${out}`);
		}

		// ---- 合成时间轴 ----
		const narrationTexts = keptShots.map((s) => narrationFor(s, opts.promptLanguage).trim());
		const subtitles: SubtitleEntry[] = [];
		for (let i = 0; i < keptShots.length; i += 1) {
			if (!narrationTexts[i]) continue;
			const nextStart = i + 1 < keptShots.length ? narrStart[i + 1]! : cursor;
			subtitles.push({
				start: narrStart[i]!,
				duration: Math.max(0.8, Math.min((narrDur[i] ?? 1.5) + 0.3, nextStart - narrStart[i]!)),
				text: narrationTexts[i]!,
			});
		}

		const timelineShots: TimelineShot[] = keptShots.map((s, k) => ({
			path: normalized[k]!,
			durationSec: shotDur[k]!,
			narrationPath: chosen.get(s.id)?.audio ? `assets/${chosen.get(s.id)!.audio}` : null,
			narrationStartSec: narrStart[k]!,
			narrationDurationSec: narrDur[k] ?? 0,
			subtitle: narrationTexts[k] || null,
		}));

		const assPath = path.join("assets", `cut${seq}-subs.ass`);
		await fs.promises.writeFile(path.join(run.dir, assPath), buildAssSubtitles(subtitles, width, height), "utf-8");
		const finalPath = path.join("assets", `cut${seq}.mp4`);

		const info = await assembleTimeline({
			cwd: run.dir,
			shots: timelineShots,
			transitions,
			sfx: sfxTimeline,
			bgmPath: null,
			assPath,
			outPath: finalPath,
			signal,
		});

		// ---- 持久化账本（cuts.json） ----
		const selectionsSnapshot: CutsDoc["renders"][number]["selections"] = {};
		for (const [shotId, c] of chosen) {
			selectionsSnapshot[shotId] = { video: c.video, audio: c.audio };
		}
		await persistCuts(run, {
			used: seq,
			renders: [...cuts.renders, { file: finalPath, at: new Date().toISOString(), selections: selectionsSnapshot }],
		});

		// ---- 事件 + redoActive 清理 ----
		pushEvent(
			run,
			"editor",
			"client",
			"user",
			`交付版 #${seq} 装配完成 ✅（${keptShots.length} 镜 · ${info.totalSec.toFixed(1)}s）。按你勾选的版本组合合成，主成片不受影响。`,
		);
		return { ok: true, remaining: MAX_COMPOSE_PER_RUN - seq, file: `cut${seq}.mp4` };
	} finally {
		run.status = prevStatus;
		persistRun(run);
	}
}
