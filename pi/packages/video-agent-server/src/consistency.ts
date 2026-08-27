/**
 * 跨镜一致性预检：审校模型对全部关键帧做角色外观/画风一致性审查。
 *
 * 目标：在用户肉眼发现之前，主动标出"服装颜色跳变 / 发型变化 / 角色换人 / 画风色调断裂"
 * 这类跨镜不一致（历史 run 实测：SH02 蓝色T恤 vs SH01/SH03 灰绿色，QA 的
 * visualConsistency 85 分并未定位到具体镜头，本检查补足镜头级定位）。
 *
 * 结果落盘 consistency.json：
 *   - 质量审读页展示（主动质量信号，而非等用户投诉）
 *   - 审议循环 get_shot_evidence 取证时带上，归因"人物形象不一致"类反馈直接有据可依
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LlmConfig } from "./config.ts";
import { runFfmpeg } from "./ffmpeg.ts";
import { chat, tryParseJson } from "./llm.ts";
import { type RunRecord, readArtifact, writeJson } from "./pipeline.ts";
import type { KeyframesDoc } from "./prompts.ts";

export interface ConsistencyIssue {
	shotId: string;
	/** 该镜角色外观/画风摘要（服装颜色与类型、发型、色调质感） */
	appearance: string;
	/** 与前后镜的具体差异（无问题则为空数组） */
	issues: string[];
}

export interface ConsistencyDoc {
	checkedAt: string;
	model: string;
	/** 一句话总体一致性评价 */
	overall: string;
	shots: ConsistencyIssue[];
}

const SYSTEM_PROMPT =
	"你是一个严格的广告片审校员。只输出一个合法的 JSON 对象（无围栏、无多余文本）。" +
	"只报告画面中确实可见的差异，不要臆测；没有差异就给空数组。";

/**
 * 跑一次跨镜一致性检查（同步，约 15-40s：一次多模态调用带全部关键帧）。
 * 关键帧少于 2 张时抛错（单镜无从比较）。
 */
export async function checkConsistency(
	ctx: { llm: LlmConfig },
	run: RunRecord,
	signal?: AbortSignal,
): Promise<ConsistencyDoc> {
	const kf = await readArtifact<KeyframesDoc>(run, "keyframes.json");
	const frames = (kf.frames ?? []).filter(
		(f): f is typeof f & { file: string } =>
			f.status === "done" && Boolean(f.file) && fs.existsSync(path.join(run.dir, f.file ?? "")),
	);
	if (frames.length < 2) throw new Error("关键帧不足 2 张，无法做跨镜一致性检查");

	const order = frames.map((f, i) => `第 ${i + 1} 张 = ${f.shotId}`).join("，");
	// 关键帧原图是高分辨率 PNG（单张 1-2MB），直接 base64 会把请求撑到超时；
	// 先用 ffmpeg 压成 640px JPEG（视觉比对足够），载荷降约一个数量级。
	const images: string[] = [];
	const tmpFiles: string[] = [];
	try {
		for (const [i, f] of frames.entries()) {
			const tmp = path.join("assets", `.consistency-${i}.jpg`);
			await runFfmpeg(["-y", "-i", f.file, "-vf", "scale=640:-2", "-q:v", "4", tmp], run.dir, signal);
			tmpFiles.push(tmp);
			images.push(fs.readFileSync(path.join(run.dir, tmp)).toString("base64"));
		}
	} finally {
		for (const tmp of tmpFiles) await fs.promises.rm(path.join(run.dir, tmp), { force: true }).catch(() => {});
	}
	// 一致性检查是全帧多模态调用，比常规文本调用慢；放宽本次调用的超时
	const llm: LlmConfig = { ...ctx.llm, timeoutMs: Math.max(ctx.llm.timeoutMs, 300_000) };

	const userPrompt = [
		`下面按顺序给出一个广告片的 ${frames.length} 个分镜关键帧。帧顺序：${order}。`,
		"",
		"请逐镜检查并跨镜比较：",
		"1. 主角外观：服装颜色与类型、发型、体型是否前后一致；",
		"2. 画风：色调、光线、质感、风格是否断裂；",
		"3. 场景连续性：场景元素是否无解释地跳变。",
		"",
		"输出 JSON：",
		'{"overall": "一句话总体一致性评价", "shots": [{"shotId": "SH01", "appearance": "灰绿色针织衫、金色短发、暖色调", "issues": ["与 SH02 的蓝色T恤不一致"]}]}',
		"shots 必须覆盖全部镜头；无问题的镜头 issues 给空数组。",
	].join("\n");

	const content: Parameters<typeof chat>[1] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "user",
			content: [
				{ type: "text", text: userPrompt },
				...images.map((b64) => ({
					type: "image_url" as const,
					image_url: { url: `data:image/png;base64,${b64}` },
				})),
			],
		},
	];

	const raw = await chat(llm, content, signal);
	const parsed = tryParseJson<{ overall?: unknown; shots?: unknown }>(raw);
	const shotsRaw = Array.isArray(parsed?.shots) ? parsed.shots : [];
	const known = new Set(frames.map((f) => f.shotId));
	const shots: ConsistencyIssue[] = [];
	for (const item of shotsRaw.slice(0, 24)) {
		const s = item as { shotId?: unknown; appearance?: unknown; issues?: unknown };
		if (typeof s.shotId !== "string" || !known.has(s.shotId)) continue;
		shots.push({
			shotId: s.shotId,
			appearance: typeof s.appearance === "string" ? s.appearance.slice(0, 200) : "",
			issues: (Array.isArray(s.issues) ? s.issues : [])
				.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
				.map((x) => x.trim().slice(0, 200))
				.slice(0, 5),
		});
	}
	if (shots.length === 0) throw new Error("审校模型未返回有效的一致性结果");

	const doc: ConsistencyDoc = {
		checkedAt: new Date().toISOString(),
		model: ctx.llm.model,
		overall: typeof parsed?.overall === "string" ? parsed.overall.slice(0, 300) : "",
		shots,
	};
	await writeJson(run, "consistency.json", doc);
	return doc;
}

/** 读取缓存的一致性结果（未检查过为 null） */
export async function getConsistency(run: RunRecord): Promise<ConsistencyDoc | null> {
	try {
		const doc = await readArtifact<ConsistencyDoc>(run, "consistency.json");
		return Array.isArray(doc.shots) ? doc : null;
	} catch {
		return null;
	}
}
