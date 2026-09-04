/**
 * 密集对话脚本批量运行器 v2
 *
 * 相比 v1：
 *   - 自动 resume 设计/关键帧两道闸门（v1 卡在 awaiting 直接超时）
 *   - 解析脚本里的「人物」「场景」注入 coSpace（避免 Clarifier 追问）
 *   - 顺手把 brief/script 落盘成 e2e 风格目录，给 deep-review.mjs 直接吃
 *
 * 用法：node doc/scripts/dense-dialogues/run-scripts-v2.mjs
 * 前置：video-agent-server 已在 :8790 运行
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, ".");
const BATCH_ROOT = path.resolve(__dirname, "../../../e2e/results");
const API_BASE = process.env.VIDEO_AGENT_API ?? "http://127.0.0.1:8790";
const POLL_MS = Number(process.env.POLL_MS ?? 8000);
const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 45 * 60 * 1000); // 单 run 45 分钟
const BATCH_NAME = process.env.BATCH_NAME ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(`[${new Date().toLocaleTimeString("zh-CN")}]`, ...args);

/** 简易 md 解析：抽 logline / 人物 / 场景 / 镜头数 / 镜头数据（visual + dialogue + 旁白） */
function parseScript(text) {
	const title = (text.match(/^#\s+(.+)$/m) ?? [, ""])[1].trim();
	const logline = (text.match(/## 一句话需求\s*\n([^\n]+)/) ?? [, ""])[1].trim();

	// 人物段（- **姓名**（男/女，X 岁）：描述；也支持老格式 - **姓名**：描述）一直到下一个 ## 标题
	const charBlock = text.match(/## 人物\s*\n([\s\S]*?)(?=\n## )/);
	const characters = [];
	if (charBlock) {
		for (const line of charBlock[1].split(/\r?\n/)) {
			// 新格式：**姓名**（男，35 岁）：描述 或 **姓名**（Lin，男，35 岁）：描述（带可选英文名）
			const newFmt = line.match(
				/-\s*\*\*(.+?)\*\*[（(](?:([A-Za-z][A-Za-z\s]+?)[，,]\s*)?(男|女)[，,]\s*(\d+)\s*岁[）)]\s*[：:]\s*(.+)/,
			);
			if (newFmt) {
				characters.push({
					name: newFmt[1].trim(),
					englishName: newFmt[2]?.trim() || undefined,
					gender: newFmt[3] === "男" ? "male" : "female",
					// 年龄并回描述里（不靠额外字段）—— voicePoolForDescription 纯函数按文本 regex 抽年龄。
					// 格式：**姓名**（男，35 岁）：描述 → coSpace.description = "35 岁，描述..."
					description: `${newFmt[4].trim()} 岁，${newFmt[5].trim()}`,
				});
				continue;
			}
			// 老格式：**姓名**：描述（gender 留空，落回 regex；这是 2026-08-31 五剧跑批的根因场景）
			const oldFmt = line.match(/-\s*\*\*(.+?)\*\*[：:]\s*(.+)/);
			if (oldFmt) characters.push({ name: oldFmt[1].trim(), description: oldFmt[2].trim() });
		}
	}
	// 场景段（- **xxx**：描述）
	const sceneBlock = text.match(/## 场景\s*\n([\s\S]*?)(?=\n## )/);
	const scenes = [];
	if (sceneBlock) {
		for (const line of sceneBlock[1].split(/\r?\n/)) {
			const m = line.match(/-\s*\*\*(.+?)\*\*[：:]\s*(.+)/);
			if (m) scenes.push({ name: m[1].trim(), description: m[2].trim() });
		}
	}

	// 镜头
	const shotSection = text.match(/## 镜头（(\d+) 镜[\s\S]*?(?=\n## |\n*$)/);
	const shotCount = shotSection ? Number(shotSection[1]) : 0;
	const shots = [];
	if (shotSection) {
		const re = /### (SH\d+)\s*·\s*([^\n]+)\n([\s\S]*?)(?=\n### |\n## |\n*$)/g;
		let m;
		while ((m = re.exec(shotSection[0])) !== null) {
			const [, id, , body] = m;
			const get = (key) => {
				const r = new RegExp(`-\\s*\\*\\*${key}\\*\\*[：:]\\s*(.+)`);
				const mm = body.match(r);
				return mm ? mm[1].trim() : "";
			};
			const linesZh = (() => {
				const m2 = body.match(/lines\.zh[：:]\s*[「"'](.+?)[」"']/);
				return m2 ? m2[1] : "";
			})();
			const emotion = (() => {
				const m2 = body.match(/emotion[：:]\s*([^\n]+)/);
				return m2 ? m2[1].trim() : "";
			})();
			const visual = get("visual");
			const characterId = (() => {
				const m2 = body.match(/characterId[：:]\s*([^\n]+)/);
				return m2 ? m2[1].trim() : "";
			})();
			shots.push({ id, title: m[2].trim(), visual, characterId, dialogue_z: linesZh, emotion });
		}
	}

	// 旁白
	const narrationZh = (text.match(/narrationZh[：:]\s*[「"'](.+?)[」"']/) ?? [, ""])[1].trim();

	// 逐镜台词意图（注入 coSpace.ideas 让 director “优先采纳”）
	// 解决 2026-08-31 B剧 SH06 整镜被改写为旁白的 bug —— LLM director 默认会重写台词，
	// 加上 user 意图后会被作为创意点保留进剧本阶段 prompt。
	const ideas = [];
	for (const s of shots) {
		if (s.dialogue_z) {
			ideas.push(`${s.id}（${s.characterId || "?"}，dialogue）：“${s.dialogue_z}”`);
		}
		if (s.visual) {
			// vision 提示也一并入 ideas（让 director 看到画面设计意图）
			ideas.push(`${s.id} 画面设计：${s.visual}`);
		}
	}

	// keyMessage 用一句话 + 一句主题
	const keyMessage = (() => {
		const m = text.match(/## 美术风格\s*\n([^\n]+)/);
		if (m) return m[1].trim().slice(0, 60);
		return "密集对话剧情短片";
	})();

	return { title, logline, keyMessage, characters, scenes, shotCount, shots, narrationZh, ideas };
}

async function api(method, urlPath, body) {
	const res = await fetch(`${API_BASE}${urlPath}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let data;
	try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
	return data;
}

async function downloadFile(urlPath, targetPath) {
	const res = await fetch(`${API_BASE}${urlPath}`);
	if (!res.ok) throw new Error(`HTTP ${res.status} on ${urlPath}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, buf);
	return buf.length;
}

function writeJson(p, data) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, "\t"), "utf-8");
}

/** 把脚本化的 shot 数据转成 server 期望的 script.json 形态 */
function buildScriptDoc(parsed) {
	return {
		title: parsed.title,
		logline: parsed.logline,
		shots: parsed.shots.map((s, idx) => ({
			id: s.id,
			visual: s.visual,
			durationSec: 5,
			audioMode: "dialogue",
			dialogue: s.characterId
				? { characterId: s.characterId, lines: { zh: s.dialogue_z, en: "" }, emotion: s.emotion }
				: undefined,
		})),
	};
}

export async function runScript(filePath, batchDir) {
	const text = fs.readFileSync(filePath, "utf-8");
	const parsed = parseScript(text);
	if (!parsed.logline) {
		throw new Error("脚本缺少 logline（## 一句话需求）");
	}
	const slug = path.basename(filePath, ".md").replace(/^script-\d+-/, "");
	const caseId = `DD-${slug.replace(/-/g, "_").slice(0, 32)}`;
	const caseDir = path.join(batchDir, `${caseId}-${slug}`);
	fs.mkdirSync(caseDir, { recursive: true });

	log(`\n===== ${parsed.title} =====`);
	log(`脚本 → ${parsed.shotCount} 镜  · ${parsed.characters.length} 人物 ·  ${parsed.scenes.length} 场景`);

	// 0) 落 00-input
	const brief = { logline: parsed.logline, keyMessage: parsed.keyMessage };
	const options = {
		resolution: "720p",
		aspectRatio: "16:9",
		shotCount: parsed.shotCount,
		clipDurationSec: 5,
		fps: 24,
		motionIntensity: "medium",
		detailBoost: true,
		promptLanguage: "zh",
		negativePrompt: "anime, cartoon, illustration, 3d render, cgi plastic skin, painting, watermark, garbled text, on-screen captions, UI overlays, debug frames, low resolution, blur, distorted face, asymmetric eyes, distorted hands, extra fingers, morphing objects",
		audioDrive: "dialogue",
	};
	const coSpace = {
		characters: parsed.characters.map((c) => {
			const out = { name: c.name, description: c.description };
			if (c.gender) out.gender = c.gender;
			if (c.englishName) out.englishName = c.englishName;
			return out;
		}),
		scenes: parsed.scenes.map((s) => ({ name: s.name, description: s.description })),
		ideas: parsed.ideas,  // ← 逐镜台词 + 画面设计意图（让 director 优先采纳）
		musicBrief: parsed.scenes[0]?.description?.slice(0, 80) ?? "",
		// 2026-09-01 补遗 §4 根治点：user 提供逐镜剧本意图时 server 跳过 LLM 编剧，直接采用。
		// 每个 shot 都带 audioMode / dialogue / characterId / visual，让 director 不能重写。
		scriptIntent: {
			title: parsed.title,
			logline: parsed.logline,
			shots: parsed.shots.map((s) => ({
				id: s.id,
				audioMode: s.dialogue_z ? "dialogue" : (parsed.narrationZh && s.id === parsed.shots.at(-1)?.id ? "narration" : undefined),
				visual: s.visual || s.title || "",
				durationSec: 5,
				...(s.dialogue_z
					? {
							dialogue: {
								characterId: s.characterId,
								lines: { zh: s.dialogue_z },
								emotion: s.emotion,
							},
						}
					: {}),
			})),
		},
	};
	writeJson(path.join(caseDir, "00-input", "brief.json"), brief);
	writeJson(path.join(caseDir, "00-input", "options.json"), options);
	writeJson(path.join(caseDir, "00-input", "coSpace.json"), coSpace);

	// 1) 启动
	const created = await api("POST", "/api/generate", { brief, options, coSpace });
	const runId = created.runId ?? created.id;
	log(`runId=${runId}`);
	const apiLog = [];
	apiLog.push({ at: new Date().toISOString(), action: "generate", runId, options });

	// 2) 轮询 + 自动 resume 闸门
	const deadline = Date.now() + TIMEOUT_MS;
	let lastStatus = "";
	const gates = [];
	let eventsSeen = new Set();
	const eventsFile = path.join(caseDir, "logs", "events.jsonl");
	fs.mkdirSync(path.dirname(eventsFile), { recursive: true });

	while (Date.now() < deadline) {
		const run = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
		if (run.status !== lastStatus) {
			const gate = run.gate ? ` gate=${run.gate}` : "";
			const stages = (run.stages ?? []).map((s) => `${s.id}:${s.status[0]}`).join(" ");
			log(`status=${run.status}${gate} stages=${stages}`);
			lastStatus = run.status;
		}
		// 事件追加
		if (Array.isArray(run.events)) {
			const lines = [];
			for (const e of run.events) {
				if (eventsSeen.has(e.id)) continue;
				eventsSeen.add(e.id);
				lines.push(JSON.stringify({ id: e.id, at: e.at, from: e.from, to: e.to, kind: e.kind, text: e.text }) + "\n");
			}
			if (lines.length) fs.appendFileSync(eventsFile, lines.join(""), "utf-8");
		}
		if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
			apiLog.push({ at: new Date().toISOString(), action: "polled-final", status: run.status });
			break;
		}
		if (run.status === "awaiting" && run.gate) {
			try {
				const r = await api("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {});
				gates.push({ gate: run.gate, at: new Date().toISOString(), action: "resume" });
				apiLog.push({ at: new Date().toISOString(), action: "resume", gate: run.gate, result: r });
				log(`闸门 ${run.gate} 已 resume`);
			} catch (error) {
				apiLog.push({ at: new Date().toISOString(), action: "resume-failed", gate: run.gate, error: error.message });
				log(`闸门 ${run.gate} resume 失败：${error.message}`);
				// 关键帧闸门可能因为 stale 需要先重绘，这里等下一次轮询再判断
			}
		}
		await sleep(POLL_MS);
	}

	// 3) 最终一次拿全 run
	const finalRun = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
	apiLog.push({ at: new Date().toISOString(), action: "polled-final", status: finalRun.status, gate: finalRun.gate });
	writeJson(path.join(caseDir, "logs", "api.log.json"), apiLog);
	writeJson(path.join(caseDir, "logs", "gate-decisions.json"), gates);

	// 4) 落 07-qa/run-state.json
	try {
		await downloadFile(`/api/runs/${encodeURIComponent(runId)}/files/run-state.json`, path.join(caseDir, "07-qa", "run-state.json"));
	} catch (error) {
		log(`run-state.json 下载失败：${error.message}`);
	}

	// 5) 拿 artifacts（脚本/设计/关键帧/旁白音色等）
	const artifacts = await api("GET", `/api/runs/${encodeURIComponent(runId)}/artifacts`).catch(() => null);
	if (artifacts) {
		// script.json（服务器加工后的剧本）
		if (artifacts.script) writeJson(path.join(caseDir, "01-script", "script.json"), artifacts.script);
		if (artifacts.voiceDirections) writeJson(path.join(caseDir, "01-script", "voice-directions.json"), artifacts.voiceDirections);
		if (artifacts.bible) writeJson(path.join(caseDir, "02-design", "visual-bible.json"), artifacts.bible);
		if (artifacts.design) writeJson(path.join(caseDir, "02-design", "design-bible.json"), artifacts.design);
		if (artifacts.keyframes) writeJson(path.join(caseDir, "03-keyframes", "keyframes.json"), artifacts.keyframes);
	}

	// 6) 拿 assets 清单，逐个下载到对应子目录
	let assets = [];
	if (artifacts && Array.isArray(artifacts.assets)) assets = artifacts.assets;
	const bucketOf = (name) => {
		if (/^design-/.test(name)) return "02-design";
		if (/^key-/.test(name)) return "03-keyframes";
		if (/^clip-/.test(name)) return "04-clips";
		if (/^tts-/.test(name)) return "05-audio";
		if (/^bgm/.test(name)) return "05-audio";
		if (/^shot-|^cut\d?-shot-/.test(name)) return "06-export";
		if (/^final|^cut\d+\.mp4$/.test(name)) return "06-export";
		if (/^qa-/.test(name) || /\.ass$/.test(name)) return "06-export";
		return "08-assets";
	};

	let downloaded = 0;
	for (const a of assets) {
		const rel = `assets/${a.name}`;
		const bucket = bucketOf(a.name);
		try {
			await downloadFile(
				`/api/runs/${encodeURIComponent(runId)}/files/${rel}`,
				path.join(caseDir, bucket, a.name),
			);
			downloaded += 1;
		} catch (error) {
			// 静默：asset 列表里可能有历史版本或临时文件
		}
	}

	// 7) 兜底：尝试下载 voice-cast.json / transitions.json（deep-review 需要 voice-cast）
	for (const [dir, name] of [
		["05-audio", "voice-cast.json"],
		["06-export", "transitions.json"],
		["07-qa", "consistency.json"],
	]) {
		try {
			await downloadFile(
				`/api/runs/${encodeURIComponent(runId)}/files/${name}`,
				path.join(caseDir, dir, name),
			);
		} catch {
			// 缺省 OK（这个 run 不一定有这些产物）
		}
	}

	const finalFile = finalRun.finalFile ?? artifacts?.export?.finalFile ?? null;
	const verdict = finalRun.verdict ?? null;
	if (verdict) writeJson(path.join(caseDir, "07-qa", "verdict.json"), verdict);

	log(`完成 status=${finalRun.status} · downloaded=${downloaded} · final=${finalFile ?? "-"}`);
	return {
		id: caseId,
		title: parsed.title,
		audioForm: "dialogue",
		dir: path.basename(caseDir),
		slug,
		run: { id: runId, status: finalRun.status, verdict },
		finalFile,
	};
}

async function main() {
	const health = await api("GET", "/api/health").catch(() => null);
	if (!health) {
		console.error(`服务不可达：${API_BASE}/api/health`);
		process.exit(2);
	}
	log(`服务健康 features=${(health.features ?? []).join(",")}`);

	const files = fs
		.readdirSync(SCRIPTS_DIR)
		.filter((f) => /^script-\d+-.*\.md$/.test(f))
		.sort();
	if (files.length === 0) {
		console.error("未找到脚本文件（script-NN-*.md）");
		process.exit(1);
	}
	log(`共 ${files.length} 份脚本：${files.join(", ")}`);

	const batchDir = path.join(BATCH_ROOT, BATCH_NAME);
	fs.mkdirSync(batchDir, { recursive: true });
	writeJson(path.join(batchDir, "env.json"), {
		base: API_BASE,
		startedAt: new Date().toISOString(),
		node: process.version,
		platform: process.platform,
		batch: BATCH_NAME,
		scripts: files,
	});

	const results = [];
	for (const f of files) {
		try {
			const r = await runScript(path.join(SCRIPTS_DIR, f), batchDir);
			results.push(r);
			// 每个 run 写一次 summary，防进程被杀丢失
			writeJson(path.join(batchDir, "summary.json"), {
				base: API_BASE,
				startedAt: new Date().toISOString(),
				results,
			});
		} catch (error) {
			log(`${f} 失败：${error.message}`);
			results.push({ file: f, error: error.message });
			writeJson(path.join(batchDir, "summary.json"), {
				base: API_BASE,
				startedAt: new Date().toISOString(),
				results,
			});
		}
		// run 之间留 RPM 缓冲
		await sleep(30000);
	}

	writeJson(path.join(batchDir, "summary.json"), {
		base: API_BASE,
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		results,
	});
	log(`\n批次完成 → ${batchDir}`);
	log(`summary: ${path.join(batchDir, "summary.json")}`);
	const okRuns = results.filter((r) => r.run?.status === "done").length;
	log(`本次成功：${okRuns}/${results.length}`);
}

// ESM main guard：只在直接执行本文件时跑 main()，避免被 run-single.mjs / 其它消费者误触发。
// Windows 路径分隔符与 URL encoding 要走 pathToFileURL，不能手拼 file://${process.argv[1]}。
import { pathToFileURL } from "node:url";
const isMainModule = (() => {
	try {
		return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
	} catch {
		return false;
	}
})();
if (isMainModule) {
	main().catch((error) => {
		console.error("批量运行失败:", error);
		process.exit(1);
	});
}
