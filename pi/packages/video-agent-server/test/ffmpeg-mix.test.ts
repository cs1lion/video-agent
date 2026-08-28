/**
 * 混音链（DME 三层）行为测试 —— 音频驱动改造的 Phase 0 前置补债。
 *
 * 为什么必须先补这个测试：设计报告「额外发现②」指出，export 的混音链只取 `[i:v]`、
 * **完全丢弃视频源音轨**（ffmpeg.ts:492）。台词模式下视频自带的就是角色对白音轨，
 * 照现有逻辑会被静默丢弃——不报错、能正常导出，问题只在观看时暴露。
 * A3 要动这条链来修它，而它此前**零测试**，等于闭眼改。
 *
 * 两层测试：
 *   A. `buildDmeFilters` 纯函数 —— 滤镜串构造的精确断言（快，不需要 ffmpeg）
 *   B. `assembleTimeline` 集成 —— 真跑 ffmpeg 验证产物（慢，但能抓住真正的 bug）
 *
 * 关键设计（冲突②的回归锁，见用例「镜头自带响亮音轨，但成片静音」）：
 *   给镜头塞一条**很响**的音轨，但不给旁白 / BGM / SFX —— 若源音轨被丢弃，成片必然静音。
 *   该用例带**前置自检**：先断言素材本身确实可闻，否则"输出静音"会退化成假通过。
 *   等 A3 打开 keepSourceAudio 后这条会立刻变红 —— 那正是我们要的：改动必须被验证，
 *   而不是静默生效。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import {
	assembleTimeline,
	buildDmeFilters,
	type DmeInput,
	type TimelineShot,
} from "../src/ffmpeg.ts";

const exec = promisify(execFile);

/** 低于此值视为静音；ffmpeg volumedetect 对纯静音轨报 -91 dB */
const SILENCE_DB = -60;

async function ff(args: string[], cwd: string): Promise<void> {
	await exec("ffmpeg", ["-y", "-loglevel", "error", ...args], {
		cwd,
		timeout: 120_000,
		windowsHide: true,
	});
}

async function ffCapture(args: string[], cwd: string): Promise<string> {
	const { stderr } = await exec("ffmpeg", ["-y", ...args], {
		cwd,
		timeout: 120_000,
		windowsHide: true,
	});
	return String(stderr);
}

async function probe(args: string[], cwd: string): Promise<string> {
	const { stdout } = await exec("ffprobe", ["-v", "error", ...args], {
		cwd,
		timeout: 30_000,
		windowsHide: true,
	});
	return String(stdout).trim();
}

/** 生成测试片段：320x240 彩条 + 440Hz 满幅正弦音轨（与旁白的 880Hz 区分） */
async function makeClip(dir: string, name: string, sec: number): Promise<void> {
	await ff(
		[
			"-f",
			"lavfi",
			"-i",
			`testsrc=duration=${sec}:size=320x240:rate=25`,
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=440:duration=${sec}`,
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-shortest",
			name,
		],
		dir,
	);
}

/** 生成音频轨（默认 880Hz 正弦，用于旁白 / BGM） */
async function makeTone(dir: string, name: string, sec: number, freq = 880): Promise<void> {
	await ff(["-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${sec}`, name], dir);
}

/** volumedetect 读回音量（dB）；解析失败返回极小值（视为静音） */
async function loudness(file: string, cwd: string): Promise<{ mean: number; max: number }> {
	const stderr = await ffCapture(["-i", file, "-af", "volumedetect", "-f", "null", "-"], cwd);
	const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)?.[1];
	const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)?.[1];
	return { mean: mean ? Number(mean) : -999, max: max ? Number(max) : -999 };
}

async function audioStreamCount(file: string, cwd: string): Promise<number> {
	const out = await probe(
		["-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
		cwd,
	);
	return out ? out.split("\n").filter(Boolean).length : 0;
}

function shot(p: string, sec: number, narration: string | null = null): TimelineShot {
	return {
		path: p,
		durationSec: sec,
		narrationPath: narration,
		narrationStartSec: 0,
		narrationDurationSec: narration ? sec : 0,
		subtitle: null,
	};
}

const DME_BASE: DmeInput = {
	narrBase: 2,
	bgmIdx: -1,
	narrations: [],
	sfx: [],
	totalSec: 10,
};

describe("混音链（DME 三层）", () => {
	const roots: string[] = [];
	let hasFfmpeg = false;

	before(async () => {
		try {
			await exec("ffmpeg", ["-version"], { timeout: 15_000, windowsHide: true });
			hasFfmpeg = true;
		} catch {
			hasFfmpeg = false;
		}
	});

	async function freshDir(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-ffmpeg-mix-"));
		await mkdir(path.join(dir, "assets"), { recursive: true });
		roots.push(dir);
		return dir;
	}

	after(async () => {
		await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }).catch(() => {})));
	});

	// ---- A. 纯函数：滤镜串构造（不需要 ffmpeg） ----

	it("三层全空 → 静音源兜底（anullsrc），不因无音频而崩", () => {
		const r = buildDmeFilters({ ...DME_BASE });
		assert.equal(r.silent, true);
		assert.equal(r.preLoud, "premix");
		assert.ok(
			r.filters.some((f) => f.includes("anullsrc")),
			`应补静音源，实际：${r.filters.join(" | ")}`,
		);
	});

	it("旁白按 J-cut 起点做 adelay 定位（秒 → 毫秒）", () => {
		const r = buildDmeFilters({
			...DME_BASE,
			narrations: [{ narrationPath: "n0.wav", narrationStartSec: 1.25 }],
		});
		const f = r.filters.find((x) => x.includes("[nd0]"));
		assert.ok(f, `应生成旁白定位滤镜，实际：${r.filters.join(" | ")}`);
		assert.match(f, /adelay=1250:all=1/, "1.25s 应换算为 1250ms");
		assert.equal(r.silent, false);
	});

	it("BGM 按成片总时长裁齐，并加淡入淡出", () => {
		const r = buildDmeFilters({ ...DME_BASE, bgmIdx: 2, totalSec: 8 });
		const f = r.filters.find((x) => x.includes("[2:a]"));
		assert.ok(f, "应生成 BGM 滤镜");
		assert.match(f, /atrim=0:8\.000/, "应裁到 totalSec");
		assert.match(f, /afade=t=in:st=0:d=0\.7/);
		assert.match(f, /afade=t=out:st=7\.100:d=0\.9/, "淡出起点 = totalSec - 0.9");
	});

	it("BGM + 旁白同时存在 → sidechaincompress 闪避", () => {
		const r = buildDmeFilters({
			...DME_BASE,
			bgmIdx: 2,
			narrations: [{ narrationPath: "n0.wav", narrationStartSec: 0 }],
		});
		assert.ok(
			r.filters.some((f) => f.includes("sidechaincompress")),
			`说话时 BGM 应自动闪避，实际：${r.filters.join(" | ")}`,
		);
	});

	it("只有 BGM、无旁白 → 不需要闪避", () => {
		const r = buildDmeFilters({ ...DME_BASE, bgmIdx: 2 });
		assert.ok(
			!r.filters.some((f) => f.includes("sidechaincompress")),
			"无旁白时不应挂 sidechain",
		);
	});

	it("多个 SFX → 先混成一路 sfxmix 再进总混", () => {
		const r = buildDmeFilters({
			...DME_BASE,
			sfx: [
				{ startSec: 0, type: "whoosh", durationSec: 0.5 },
				{ startSec: 2, type: "impact", durationSec: 0.4 },
			],
		});
		assert.ok(
			r.filters.some((f) => f.includes("[sfxmix]")),
			`多音效应先合成一路，实际：${r.filters.join(" | ")}`,
		);
	});

	// ---- B. 集成：真跑 ffmpeg 验证产物 ----

	it("基础装配：两镜硬切 → 成片时长≈各镜之和，且含音轨", async (t) => {
		if (!hasFfmpeg) return t.skip("环境无 ffmpeg，跳过集成用例");
		const dir = await freshDir();
		await makeClip(dir, "c0.mp4", 3);
		await makeClip(dir, "c1.mp4", 3);
		await makeTone(dir, "n0.wav", 2);

		const res = await assembleTimeline({
			cwd: dir,
			shots: [shot("c0.mp4", 3, "n0.wav"), shot("c1.mp4", 3)],
			transitions: [],
			sfx: [],
			bgmPath: null,
			assPath: null,
			outPath: "out.mp4",
		});

		assert.ok(fs.existsSync(path.join(dir, "out.mp4")), "应产出成片");
		assert.ok(Math.abs(res.totalSec - 6) < 0.6, `总时长应≈6s，实际 ${res.totalSec}`);
		assert.equal(await audioStreamCount("out.mp4", dir), 1, "成片应恰好一条音轨");
	});

	it("回归锁：镜头自带响亮音轨，但成片静音（源音轨被丢弃的铁证）", async (t) => {
		if (!hasFfmpeg) return t.skip("环境无 ffmpeg，跳过集成用例");
		const dir = await freshDir();
		await makeClip(dir, "loud.mp4", 3);

		// 前置自检：素材本身的音轨必须确实可闻。
		// 少了这一步，"输出静音"在素材也静音时会退化成假通过。
		const src = await loudness("loud.mp4", dir);
		assert.ok(src.mean > -30, `素材音轨应可闻（mean=${src.mean}dB），否则本用例无意义`);

		await assembleTimeline({
			cwd: dir,
			shots: [shot("loud.mp4", 3)],
			transitions: [],
			sfx: [],
			bgmPath: null,
			assPath: null,
			outPath: "out.mp4",
		});

		const out = await loudness("out.mp4", dir);
		assert.ok(
			out.mean < SILENCE_DB,
			`成片应静音（源音轨被丢弃），实测 mean=${out.mean}dB。` +
				`若 A3 已打开 keepSourceAudio，请同步更新本用例——它变红正是设计意图。`,
		);
	});

	it("旁白进入混音：成片可闻", async (t) => {
		if (!hasFfmpeg) return t.skip("环境无 ffmpeg，跳过集成用例");
		const dir = await freshDir();
		await makeClip(dir, "c0.mp4", 3);
		await makeTone(dir, "n0.wav", 3);

		await assembleTimeline({
			cwd: dir,
			shots: [shot("c0.mp4", 3, "n0.wav")],
			transitions: [],
			sfx: [],
			bgmPath: null,
			assPath: null,
			outPath: "out.mp4",
		});

		const out = await loudness("out.mp4", dir);
		assert.ok(out.mean > SILENCE_DB, `有旁白时成片应可闻，实测 mean=${out.mean}dB`);
	});

	it("BGM 铺底：无旁白时成片同样可闻", async (t) => {
		if (!hasFfmpeg) return t.skip("环境无 ffmpeg，跳过集成用例");
		const dir = await freshDir();
		await makeClip(dir, "c0.mp4", 3);
		await makeTone(dir, "bgm.wav", 6, 220);

		await assembleTimeline({
			cwd: dir,
			shots: [shot("c0.mp4", 3)],
			transitions: [],
			sfx: [],
			bgmPath: "bgm.wav",
			assPath: null,
			outPath: "out.mp4",
		});

		const out = await loudness("out.mp4", dir);
		assert.ok(out.mean > SILENCE_DB, `有 BGM 时成片应可闻，实测 mean=${out.mean}dB`);
	});
});
