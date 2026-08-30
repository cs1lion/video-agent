/**
 * 管线三个文本阶段的提示词（剧本 / 美术设计 / 镜头提示词）。
 *
 * 关键设计：
 * - 访谈得到的 GenerationDirectives 按阶段注入（空串 = 不注入）；
 * - 生成选项（镜头数/单镜时长/内容语言/运动强度/画幅）注入对应阶段；
 * - 实战教训写进提示词：画面内禁止出现文字/logo（缺陷靠后期 drawtext 烧录），
 *   旁白长度受单镜时长约束。
 */

import type { Brief, CoCreationSpace, EnrichedBrief, GenerationOptions } from "../../video-agent/src/index.ts";
import type { ChatMessage } from "./llm.ts";

/**
 * 提示词模板版本（写入 prompts.json，产物可追溯是哪一版模板生成的）。
 * 5: 逐镜 prompt 注入美术设计角色锚点（跨镜服装/发型一致性）+ few-shot 示例。
 */
export const PROMPT_VERSION = 5;

/** 每镜声音模式（音频驱动改造 A1）：narration = 画外音解说（现状，缺省）；
 *  dialogue = 角色对白驱动口型（先 TTS → 托管 → 视频参考生成）；
 *  silent = 纯画面（只有 BGM/SFX）。三态共存而非替代——一部片子天然混用。 */
export type AudioMode = "narration" | "dialogue" | "silent";

/** 台词镜子结构（仅 audioMode === "dialogue"）。
 *  台词是"驱动源"而非贴片：audioDurationSec / audioUrl 由生成链路回写。 */
export interface ShotDialogue {
	/** 绑定共创空间的角色实体（CoCharacter.name） */
	characterId: string;
	/** TTS 音色（如 StepFun voice id；来自角色卡片绑定） */
	voiceId?: string;
	/** 台词文本——每镜一条主语音，多角色对白必须拆镜（audios 多条会互相干扰） */
	lines: { zh: string; en: string };
	/** 情绪/表演指导 */
	emotion?: string;
	pace?: "slow" | "normal" | "fast";
	/** 台词内停顿（秒）。静音段是表演的一部分：2.5-flash 严格按音频包络对口型，停顿即闭嘴 */
	pausesSec?: number[];
	/** TTS 后 ffprobe 实测时长（生成链路回写） */
	audioDurationSec?: number;
	/** 跟读校验未过 → dubOver 模式：口型视频保留、export 用 TTS 原声覆盖其音轨
	 *  （模型模仿节奏说乱语是 agnes reference 的模型级行为，声音正确性优先于口型同步） */
	dubOver?: boolean;
	/** CloudBase 托管公开 URL（生成链路回写，可复用避免重复上传） */
	audioUrl?: string;
}

export interface ScriptShot {
	id: string;
	/** 中文旁白（一句，时长内可念完） */
	narrationZh: string;
	/** 英文旁白 */
	narrationEn: string;
	/** 画面描述（英文，一镜一句） */
	visual: string;
	durationSec: number;
	/** TTS 表演指导（中文一句；voice-directions.json 回写，重录时可被指令更新） */
	ttsDirection?: string;
	/** 声音模式；缺省（undefined）= narration，向后兼容既有作品 */
	audioMode?: AudioMode;
	/** 台词（仅 audioMode === "dialogue"） */
	dialogue?: ShotDialogue;
}

export interface ScriptDoc {
	title: string;
	logline: string;
	shots: ScriptShot[];
}

export interface VisualBible {
	styleKeywords: string[];
	palette: string[];
	lighting: string;
	grade: string;
}

export interface ShotPromptDoc {
	prompts: { shotId: string; prompt: string }[];
	/** 生成该产物时的提示词模板版本（PROMPT_VERSION） */
	promptVersion?: number;
}

const MOTION_HINT: Record<GenerationOptions["motionIntensity"], string> = {
	low: "slow, subtle camera movement, gentle drift",
	medium: "moderate, natural camera movement",
	high: "fast, dynamic camera movement, energetic action",
};

function briefBlock(brief: Brief | EnrichedBrief): string {
	const lines = [`一句话需求: ${brief.creative.logline}`];
	if (brief.creative.keyMessage) lines.push(`关键信息: ${brief.creative.keyMessage}`);
	return lines.join("\n");
}

/** 共创空间 → 注入各文本阶段的设定块（缺省返回空串，行为不变） */
export function coSpaceBlock(coSpace: CoCreationSpace | undefined): string {
	if (!coSpace) return "";
	const parts: string[] = [];
	if (coSpace.characters.length > 0) {
		parts.push(
			`人物形象设定（必须沿用，不得擅自改动外貌/人设）:\n${coSpace.characters
				.map((c) => `- ${c.name}：${c.description}`)
				.join("\n")}`,
		);
	}
	if (coSpace.scenes.length > 0) {
		parts.push(`场景设定（必须沿用）:\n${coSpace.scenes.map((s) => `- ${s.name}：${s.description}`).join("\n")}`);
	}
	if (coSpace.ideas.length > 0) {
		parts.push(`创意情节 / 卖点节拍（优先采纳）:\n${coSpace.ideas.map((i) => `- ${i}`).join("\n")}`);
	}
	if (coSpace.musicBrief) parts.push(`背景音乐简报: ${coSpace.musicBrief}`);
	return parts.join("\n\n");
}

/** 阶段一：剧本（镜头列表 + 双语旁白 + 画面描述） */
export function scriptMessages(brief: EnrichedBrief, opts: GenerationOptions): ChatMessage[] {
	const zhChars = Math.max(6, opts.clipDurationSec * 4);
	const audioDriveOn = opts.audioDrive === "dialogue";
	const audioModeRule = audioDriveOn
		? [
				"6. 每镜给出 audioMode 声音模式：dialogue（角色对白，角色自己开口说话）/ narration（画外音旁白）/ silent（纯画面）；叙事性镜头优先 dialogue；",
				"7. dialogue 镜头只能有一个说话人——两人及以上对话必须拆成多个镜头；",
				"8. dialogue 镜头附 dialogue 对象：characterId 写说话角色名（必须来自人物设定），lines.zh / lines.en 是该镜台词（各一句话，长度与旁白同约束），emotion 写情绪（两三个字）；该镜 narrationZh / narrationEn 留空；",
			]
		: [];
	const shotExample = audioDriveOn
		? `{"id": "SH01", "audioMode": "dialogue", "dialogue": {"characterId": "角色名", "lines": {"zh": "…", "en": "…"}, "emotion": "…"}, "narrationZh": "", "narrationEn": "", "visual": "…", "durationSec": ${opts.clipDurationSec}}`
		: `{"id": "SH01", "narrationZh": "…", "narrationEn": "…", "visual": "…", "durationSec": ${opts.clipDurationSec}}`;
	const user = [
		`为下面这支广告撰写剧本。`,
		briefBlock(brief),
		brief.generationDirectives.script.promptFragment
			? `创意方向约束: ${brief.generationDirectives.script.promptFragment}`
			: "",
		coSpaceBlock(brief.coSpace),
		"",
		"要求:",
		`1. 恰好 ${opts.shotCount} 个镜头，编号 SH01…SH${String(opts.shotCount).padStart(2, "0")}，按叙事顺序排列；`,
		`2. 每个镜头时长恰好 ${opts.clipDurationSec} 秒；`,
		`3. narrationZh / narrationEn 是该镜头的旁白，各一句话，中文不超过 ${zhChars} 字（${opts.clipDurationSec} 秒内从容念完），英文意思一致；`,
		"4. visual 是该镜头的画面描述，用英文一句话，写清主体、环境、动作；",
		"5. 整体有起承转合，最后一镜落到产品/CTA；",
		...audioModeRule,
		"",
		"只输出如下 JSON（不要围栏）:",
		`{"title": "广告标题", "logline": "一句话概述", "shots": [${shotExample}]}`,
	]
		.filter(Boolean)
		.join("\n");
	return [{ role: "user", content: user }];
}

/** 阶段二：美术设计（全片视觉基准的决定性源头，下游关键帧与视频素材必须严格遵循） */
export function visualBibleMessages(brief: EnrichedBrief, opts: GenerationOptions): ChatMessage[] {
	const user = [
		`为下面这支广告制定美术设计（全片决定性的视觉基准：本产物的风格、色彩与光线将直接约束后续所有关键帧和视频素材，必须一次定准）。`,
		briefBlock(brief),
		brief.generationDirectives.visual.promptFragment
			? `视觉方向约束: ${brief.generationDirectives.visual.promptFragment}`
			: "",
		brief.coSpace?.characters.length || brief.coSpace?.scenes.length ? coSpaceBlock(brief.coSpace) : "",
		"",
		"要求:",
		`1. 画面比例为 ${opts.aspectRatio}；`,
		"2. styleKeywords: 5-8 个英文风格关键词（cinematic / lifestyle / studio 等）；",
		"3. palette: 4-6 个具体颜色（英文色名或 #hex）；",
		"4. lighting: 一句英文光线方案；",
		"5. grade: 一句英文调色方案。",
		"",
		"只输出如下 JSON（不要围栏）:",
		'{"styleKeywords": ["…"], "palette": ["…"], "lighting": "…", "grade": "…"}',
	]
		.filter(Boolean)
		.join("\n");
	return [{ role: "user", content: user }];
}

/** 阶段三：逐镜生成视频模型提示词（英文，含风格/运镜/排除项 + 角色一致性锚点） */
export function shotPromptMessages(
	brief: EnrichedBrief,
	script: ScriptDoc,
	bible: VisualBible,
	opts: GenerationOptions,
	designBible?: DesignBibleDoc | null,
): ChatMessage[] {
	const avoid = opts.negativePrompt.trim() || "on-screen text, watermark";
	const characters = (designBible?.characters ?? []).filter((c) => c.design.trim().length > 0);
	const scenes = (designBible?.scenes ?? []).filter((s) => s.design.trim().length > 0);
	const anchorLines = [
		...characters.map((c) => `- 人物 ${c.name}(${c.id}): ${c.design}`),
		...scenes.map((s) => `- 场景 ${s.name}(${s.id}): ${s.design}`),
	];
	const characterBlock =
		anchorLines.length > 0
			? `美术设计锚点（来自已定稿的美术设计素材，是后续所有视频原料的决定性依据，必须逐镜严格沿用，禁止偏离或新增设定）:\n${anchorLines.join(
					"\n",
				)}\n一致性要求（最重要）: 同一角色在所有镜头中的服装颜色与款式、发型必须完全相同，且在每个提示词里用相同的英文短语显式写出（如锚点写 olive-green knit sweater，则每镜都写 wearing an olive-green knit sweater，禁止换词或换色）；场景的空间结构与材质氛围也必须与对应场景锚点一致。`
			: "";
	const user = [
		"为下面广告的每个镜头写一段视频生成模型的英文提示词。",
		briefBlock(brief),
		"",
		`美术设计: ${JSON.stringify(bible)}`,
		characterBlock,
		`镜头画面描述: ${JSON.stringify(
			script.shots.map((s) => ({
				id: s.id,
				visual: s.visual,
				// 台词镜注入说话信息：分镜为台词服务（画面是"谁在说什么"）
				...(s.audioMode === "dialogue" && s.dialogue
					? { speaking: s.dialogue.characterId, lineEn: s.dialogue.lines.en, emotion: s.dialogue.emotion ?? "" }
					: {}),
			})),
		)}`,
		brief.generationDirectives.clips.promptFragment
			? `镜头方向约束: ${brief.generationDirectives.clips.promptFragment}`
			: "",
		brief.coSpace?.characters.length || brief.coSpace?.scenes.length ? coSpaceBlock(brief.coSpace) : "",
		"",
		"要求:",
		`1. 运镜幅度: ${MOTION_HINT[opts.motionIntensity]}——写明具体镜头运动（dolly push-in / pan left / handheld follow / static locked-off 等），并让运动与该镜情绪匹配；`,
		`2. 目标画幅 ${opts.aspectRatio}，提示词里写明构图取向（不要写像素值）;`,
		opts.detailBoost ? "3. 强调高细节、材质质感;" : "3. 保持画面简洁;",
		"4. 每段提示词 60-110 个英文单词，一段连贯文字，必含五要素：主体及其外观锚点短语 / 环境与空间深度 / 光线（方向+性质，如 low warm side light） / 镜头运动 / 风格与调性；",
		"5. 画面内不得出现任何文字、字幕、logo、UI（这些由后期烧录，模型画字必乱码）；",
		`6. 在提示词末尾追加一句: "Strictly avoid: ${avoid}"`,
		"",
		"示例（仅示意结构，不要照抄内容）:",
		"示例一（静态情绪镜）: Cinematic wide shot of a young boy in an olive-green knit sweater sitting on a sunlit wooden floor, dust motes drifting in the light, golden hour sun streaming low through sheer curtains, static locked-off composition with shallow depth of field, warm nostalgic grade, cozy lifestyle style. Strictly avoid: on-screen text, watermark",
		"示例二（运动镜）: Handheld tracking shot following a silver-haired 68-year-old man in a navy wool coat walking through a narrow Lyon alley, morning fog softening the background, cool blue dawn light rim-lighting his silhouette, camera moves with him at walking pace then slows to hold on his weathered hands, cinematic documentary tone. Strictly avoid: on-screen text, watermark",
		"",
		"只输出如下 JSON（不要围栏）:",
		`{"prompts": [{"shotId": "SH01", "prompt": "…"}, …]}（覆盖全部 ${script.shots.length} 个镜头）`,
	]
		.filter(Boolean)
		.join("\n");
	return [{ role: "user", content: user }];
}

/** 按内容语言取旁白 */
export function narrationFor(shot: ScriptShot, locale: GenerationOptions["promptLanguage"]): string {
	return locale === "en" ? shot.narrationEn : shot.narrationZh;
}

/** 按内容语言取台词（仅台词镜有意义；非台词镜返回空串） */
export function dialogueFor(shot: ScriptShot, locale: GenerationOptions["promptLanguage"]): string {
	if (shot.audioMode !== "dialogue" || !shot.dialogue) return "";
	return locale === "en" ? shot.dialogue.lines.en : shot.dialogue.lines.zh;
}

/**
 * 台词子结构宽容清洗（A1 闸门的一部分）：
 * characterId 与至少一条台词文本是必要条件，缺一即整体丢弃（回退旁白语义）。
 * 数值/数组字段只保留合法项——LLM 产物永远不可信，入库前先洗。
 */
export function sanitizeDialogue(raw: unknown): ShotDialogue | null {
	if (!raw || typeof raw !== "object") return null;
	const d = raw as Partial<ShotDialogue> & { lines?: unknown };
	const characterId = typeof d.characterId === "string" ? d.characterId.trim() : "";
	const linesRaw = (d.lines ?? {}) as { zh?: unknown; en?: unknown };
	const zh = typeof linesRaw.zh === "string" ? linesRaw.zh.trim() : "";
	const en = typeof linesRaw.en === "string" ? linesRaw.en.trim() : "";
	if (!characterId || (!zh && !en)) return null;
	const out: ShotDialogue = { characterId, lines: { zh, en } };
	if (typeof d.voiceId === "string" && d.voiceId.trim()) out.voiceId = d.voiceId.trim();
	if (typeof d.emotion === "string" && d.emotion.trim()) out.emotion = d.emotion.trim().slice(0, 200);
	if (d.pace === "slow" || d.pace === "normal" || d.pace === "fast") out.pace = d.pace;
	if (Array.isArray(d.pausesSec)) {
		const pauses = d.pausesSec.filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 30);
		if (pauses.length > 0) out.pausesSec = pauses.slice(0, 20);
	}
	if (typeof d.audioDurationSec === "number" && Number.isFinite(d.audioDurationSec) && d.audioDurationSec > 0) {
		out.audioDurationSec = d.audioDurationSec;
	}
	if (typeof d.audioUrl === "string" && /^https:\/\//.test(d.audioUrl)) out.audioUrl = d.audioUrl;
	return out;
}

/**
 * 台词精简重写（A4 时长对齐·超长分支）：台词是驱动源，必须 ≤ 镜长（否则尾段嘴瓢）。
 * 目标字数按中文 ~4 字/秒 折算；保持人物口吻与关键信息，禁止舞台指示。
 * 只输出 JSON {"zh": "…", "en": "…"}。
 */
export function dialogueCondenseMessages(shotId: string, lineZh: string, lineEn: string, targetChars: number): string {
	const user = [
		`镜头 ${shotId} 的台词音频实测超过镜长，需要精简台词后重新配音。`,
		"",
		`当前台词:`,
		`- 中文: ${lineZh}`,
		`- 英文: ${lineEn}`,
		"",
		"要求:",
		`1. 中文压缩到不超过 ${targetChars} 字（${targetChars} 字约对应镜长内可自然说完的量），英文同步精简；`,
		"2. 保留人物口吻、情绪与关键信息，优先删修饰词和重复语义，不改变事实内容；",
		"3. 仍是一句口语台词，适合 TTS 朗读，不含舞台指示、旁白腔或省略号；",
		"4. 两句都直接可读，不要引号包裹。",
		"",
		"只输出如下 JSON（不要围栏）:",
		'{"zh": "…", "en": "…"}',
	].join("\n");
	return user;
}

/**
 * 旁白重录·指令解析：按客户指令判断是「改文案」还是「纯表演指导」。
 * - copy-edit：改写旁白（语气/口语化/内容调整），输出新文案（中英双语，±20%）；
 * - voice-only：文案不动，只给 TTS 表演指导（instruction，中文 ≤80 字），
 *   如「兴奋一点、语速加快」「压低声音带神秘感」。
 */
export function rettsNarrationMessages(shot: ScriptShot, instruction: string, opts: GenerationOptions): string {
	const langNote =
		opts.promptLanguage === "en"
			? "成片以英文旁白播出（narrationEn 为主，narrationZh 给出对应中文）"
			: "成片以中文旁白播出（narrationZh 为主，narrationEn 给出对应英文）";
	const user = [
		"客户对这一镜的旁白提出了重录指令。先判断指令类型：",
		"- 若是内容/措辞层面的修改（改说法、加卖点、换口吻、增删信息）→ mode=copy-edit，按指令改写文案；",
		"- 若是纯语音表演层面的要求（音色/语速/情绪/停顿/能量，如「兴奋点、语速加快」）→ mode=voice-only，文案保持原句不变（逐字保留），并给出一句中文 TTS 表演指导。",
		"",
		`镜头 ${shot.id} 当前旁白:`,
		`- narrationZh: ${shot.narrationZh}`,
		`- narrationEn: ${shot.narrationEn}`,
		`镜头画面: ${shot.visual}`,
		`当前表演指导: ${shot.ttsDirection ?? "（无）"}`,
		"",
		`客户指令: ${instruction}`,
		"",
		"要求:",
		`1. copy-edit 时：${langNote}；改动要体现客户指令；仍是一句话，长度与原文相当（±20%），适合 TTS 朗读，不含舞台指示；`,
		"2. voice-only 时：narrationZh/narrationEn 必须与原文逐字相同；",
		"3. instruction 是给 TTS 的表演指导（中文，≤80 字）：写清情绪、语速、重音与气息（如「语气兴奋上扬，语速比常速快，关键词『清爽』加重音」）；copy-edit 时也要给出与新文案匹配的指导；",
		"",
		"只输出如下 JSON（不要围栏）:",
		'{"mode": "voice-only", "narrationZh": "…", "narrationEn": "…", "instruction": "…"}',
	].join("\n");
	return user;
}

/**
 * 台词重录·指令解析（A5 级联重做）：与 rettsNarrationMessages 同构，但面向
 * 台词镜的 dialogue.lines（人物对白，非旁白）。voice-only 时台词逐字保留。
 */
export function rettsDialogueMessages(shot: ScriptShot, instruction: string, opts: GenerationOptions): string {
	const langNote =
		opts.promptLanguage === "en"
			? "成片以英文台词播出（lines.en 为主，lines.zh 给出对应中文）"
			: "成片以中文台词播出（lines.zh 为主，lines.en 给出对应英文）";
	const user = [
		"客户对这一镜的人物台词提出了重录指令。先判断指令类型：",
		"- 若是内容/措辞层面的修改（改说法、换口吻、增删信息）→ mode=copy-edit，按指令改写台词；",
		"- 若是纯表演层面的要求（情绪/语速/停顿/能量，如「更愤怒一点」）→ mode=voice-only，台词保持原句不变（逐字保留），并给出一句中文 TTS 表演指导。",
		"",
		`镜头 ${shot.id} 当前台词（角色：${shot.dialogue?.characterId ?? "未知"}，情绪：${shot.dialogue?.emotion ?? "无"}）:`,
		`- zh: ${shot.dialogue?.lines.zh ?? ""}`,
		`- en: ${shot.dialogue?.lines.en ?? ""}`,
		`镜头画面: ${shot.visual}`,
		`当前表演指导: ${shot.ttsDirection ?? "（无）"}`,
		"",
		`客户指令: ${instruction}`,
		"",
		"要求:",
		`1. copy-edit 时：${langNote}；改动要体现客户指令；仍是一句口语台词，长度与原文相当（±20%），适合 TTS 朗读，不含舞台指示或旁白腔；`,
		"2. voice-only 时：linesZh/linesEn 必须与原文逐字相同；",
		"3. instruction 是给 TTS 的表演指导（中文，≤80 字）：写清情绪、语速、重音与气息；copy-edit 时也要给出与新台词匹配的指导；",
		"",
		"只输出如下 JSON（不要围栏）:",
		'{"mode": "voice-only", "linesZh": "…", "linesEn": "…", "instruction": "…"}',
	].join("\n");
	return user;
}

/** EDL 转场决策产物（宽容解析：缺失/非法项回退为 cut，音效缺省兜底） */
export interface EdlDoc {
	/** after = 第几个镜头之后（1-based，即切点编号）；type 白名单外按 cut 处理 */
	transitions: { after: number; type: string; durationSec: number; sfx?: string }[];
}

/** 阶段四·五之间：剪辑师转场决策（读剧本节奏，输出每个切点的转场类型与音效） */
export function edlPrompt(shots: { id: string; durationSec: number; narration: string; visual: string }[]): string {
	const lines = shots
		.map((s, i) => `${i + 1}. ${s.id}（${s.durationSec.toFixed(1)}s）旁白:「${s.narration}」 画面: ${s.visual}`)
		.join("\n");
	return [
		"你是广告片的剪辑师。下面是按顺序排列的镜头表（含每镜时长、旁白与画面描述），",
		"请为相邻镜头之间的每个切点选择转场方式与转场音效，让影片衔接自然、有节奏感。",
		"",
		"镜头表:",
		lines,
		"",
		"转场类型（只能从中选择）:",
		"- cut: 硬切。默认选择——同场景/连贯动作/快节奏时用，商业广告的主力。",
		"- fade: 叠化。时间流逝、情绪缓冲、同主体不同景别。",
		"- dip: 黑场过渡。段落结束、夜晚/沉重情绪、或结尾收黑。",
		"- white: 白闪。高光时刻、产品揭晓、强转折。",
		"- wipeleft / slideup: 风格化擦除/滑动。快节奏或年轻化风格，全片最多 1 次。",
		"",
		"转场音效 sfx（只能从中选择）:",
		"- none: 无音效。默认选择——大部分 cut 不需要。",
		"- whoosh: 嗖声扫频。配合 fade/wipe/slide 等平滑转场。",
		"- impact: 低频冲击。配合 white 白闪或产品揭晓时刻的 cut。",
		"- riser: 上升音。段落推进、情绪抬升，全片最多 1 次。",
		"",
		"规则:",
		"1. 5 镜广告通常 2-4 个 cut，1-2 个其他转场；最后一个切点若临近结尾优先 dip 或 fade；",
		"2. durationSec 取 0.3-0.8（cut 恒为 0）；",
		"3. 音效克制使用：全片最多 2 处，宁缺毋滥——好的商业片声音层次是干净的；",
		`4. transitions 必须恰好覆盖镜头之间的全部切点（共 ${shots.length - 1} 个），after 用 1-based 切点编号；`,
		"",
		"只输出如下 JSON（不要围栏）:",
		'{"transitions": [{"after": 1, "type": "cut", "durationSec": 0, "sfx": "none"}, {"after": 2, "type": "fade", "durationSec": 0.5, "sfx": "whoosh"}]}',
	].join("\n");
}

// ============================================================================
// 定制访谈题（10 固定 + 5 LLM 定制的后半段）
// ============================================================================

/** 定制题 LLM 输出（归一化前的原始形态） */
export interface TailoredQuestionRaw {
	category?: string;
	text?: string;
	stage?: string;
	options?: { label?: string; hint?: string; promptTags?: unknown }[];
}

/**
 * 定制访谈题生成：输入一句话需求 + 已答风格摘要，
 * 产出 5 条与该品类强相关的创意决策题（中文文案 + 英文 promptTags + 注入阶段）。
 */
export function tailoredQuestionsMessages(brief: Brief, answeredSummary: string): ChatMessage[] {
	const coSpace = (brief as { coSpace?: CoCreationSpace }).coSpace;
	const user = [
		"为一支广告的创意访谈生成 5 道定制选择题。前面的固定问题已确定风格界限，这 5 题要挖掘「这个具体需求才需要决策」的创意维度。",
		briefBlock(brief),
		answeredSummary ? `用户已确定的风格界限: ${answeredSummary}` : "",
		coSpace ? coSpaceBlock(coSpace) : "",
		"",
		"出题方向（按需求特点挑最关键的 5 个，不要重复风格界限已覆盖的维度）:",
		"- 主角设定：镜头主角是谁/什么（人物性格、产品拟人、符号物）；",
		"- 核心场景：故事发生在哪里（贴合品类使用情境）；",
		"- 卖点表达：核心卖点用哪种方式演绎（对比、夸张、实证、氛围暗示）；",
		"- 品类专属决策：如食品的食欲感、科技的未来感、美妆的质感表达；",
		"- 文字策略 / CTA 力度 / 手部与产品互动方式 等执行细节。",
		"",
		"硬性要求:",
		"1. 恰好 5 题；每题 3-4 个选项；题目与选项文案全部中文且贴合该需求的具体品类（禁止泛泛而问）；",
		"2. 每个选项给 hint（一句效果说明）和 promptTags（3-6 个英文关键词，供生成模型使用）；",
		"3. 每题标注 stage（答案注入哪个生成阶段），只能取 script / visual / clips / audio / export 之一；",
		"4. 不要输出 id（系统自动编号）；",
		"",
		'只输出 JSON: {"questions": [{"category": "主体", "text": "…", "stage": "clips", "options": [{"label": "…", "hint": "…", "promptTags": ["…"]}]}]}',
	]
		.filter(Boolean)
		.join("\n");
	return [{ role: "user", content: user }];
}

// ============================================================================
// 美术设计（人物 / 道具 / 场景概念设计图）
// ============================================================================

/** 设计卡审核结论（视觉模型对照 design 要点审查出图，step-3.7） */
export interface DesignReview {
	verdict: "ok" | "warn" | "fail";
	/** 与设计要点的具体偏差（无问题为空数组） */
	issues: string[];
	checkedAt: string;
}

/** 设计实体（design-bible.json 内的单张设计卡） */
export interface DesignEntity {
	id: string;
	category: "character" | "prop" | "scene";
	name: string;
	/** 英文设计要点（概念图 prompt 的主体描述） */
	design: string;
	/** assets 下相对路径（生成成功后回填） */
	file?: string;
	/** HTTP 预览地址（server 组装 artifacts 视图时回填） */
	url?: string;
	status: "pending" | "done" | "failed";
	error?: string;
	attempts: number;
	/** 历史版本文件名（调整重绘时备份） */
	versions: string[];
	/** 最近一次出图审核结论（未审核/旧 run 缺省） */
	review?: DesignReview;
}

export interface DesignBibleDoc {
	characters: DesignEntity[];
	props: DesignEntity[];
	scenes: DesignEntity[];
	generatedAt?: string;
}

interface DesignSeed {
	name?: unknown;
	design?: unknown;
}

function normalizeSeeds(raw: unknown, category: DesignEntity["category"], prefix: string): DesignEntity[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((s): s is DesignSeed => Boolean(s) && typeof (s as DesignSeed).name === "string")
		.slice(0, 3)
		.map((s, i) => ({
			id: `${prefix}${String(i + 1).padStart(2, "0")}`,
			category,
			name: String(s.name).slice(0, 40),
			design: typeof s.design === "string" ? s.design.slice(0, 600) : "",
			status: "pending",
			attempts: 0,
			versions: [],
		}));
}

/** 宽容解析 LLM 的设计实体推导结果 */
export function normalizeDesignDoc(raw: Partial<Record<"characters" | "props" | "scenes", unknown>>): DesignBibleDoc {
	return {
		characters: normalizeSeeds(raw.characters, "character", "CH"),
		props: normalizeSeeds(raw.props, "prop", "PR"),
		scenes: normalizeSeeds(raw.scenes, "scene", "SC"),
	};
}

/** 美术设计实体推导：从剧本 + 美术设计拆出需要出概念设计图的实体（人物与场景是后续视频原料的决定性基准） */
export function designBibleMessages(brief: EnrichedBrief, script: ScriptDoc, bible: VisualBible): ChatMessage[] {
	const user = [
		"为下面这支广告推导「美术设计」实体清单：列出开拍前美术组要出概念设计图的实体。人物形象与核心场景描述是决定性的，后续关键帧与视频素材都会严格围绕它们生成，务必精确、可复用。",
		briefBlock(brief),
		coSpaceBlock(brief.coSpace),
		`剧本: ${JSON.stringify({ title: script.title, logline: script.logline, shots: script.shots.map((s) => s.visual.slice(0, 100)) })}`,
		`美术设计: ${JSON.stringify(bible)}`,
		"",
		"要求:",
		"1. characters（出场人物/拟人形象）1-3 个；props（关键道具/产品包装等实物）1-3 个；scenes（核心场景）1-3 个；总数控制在 4-8 个，只列真正会出现在画面里的；",
		"2. name 用中文短名（≤10 字）；",
		"3. design 用英文写 40-70 词的设计要点：外观、材质、色彩、关键特征、视角建议（正面全身/三视图/环境氛围），供文生图模型直接使用；",
		"4. 若提供了人物/场景设定，必须与其保持一致；",
		"",
		'只输出 JSON: {"characters": [{"name": "…", "design": "…"}], "props": […], "scenes": […]}',
	]
		.filter(Boolean)
		.join("\n");
	return [{ role: "user", content: user }];
}

/** 设计实体 → 文生图 prompt（概念设计图风格，挂美术设计锚点） */
export function designSheetPrompt(entity: DesignEntity, bible: VisualBible, extra?: string): string {
	const kind =
		entity.category === "character"
			? "Character concept design sheet"
			: entity.category === "prop"
				? "Product & prop concept design sheet"
				: "Environment concept art";
	const style = [
		bible.styleKeywords.slice(0, 5).join(", "),
		bible.palette.length > 0 ? `color palette: ${bible.palette.slice(0, 5).join(", ")}` : "",
		bible.lighting,
	].join(", ");
	const instruction =
		entity.category === "scene"
			? "wide establishing view, atmospheric depth"
			: "centered presentation on a clean neutral background, concept art quality";
	return [
		`${kind} of ${entity.name}: ${entity.design}`,
		style,
		instruction,
		"no text, no watermark, no logo, no labels",
		extra ? `Adjustment: ${extra}` : "",
	]
		.filter(Boolean)
		.join(", ");
}

// ============================================================================
// 分镜关键帧
// ============================================================================

/** 关键帧单镜记录（keyframes.json 内的一项） */
export interface KeyframeEntry {
	shotId: string;
	/** assets 下相对路径 */
	file?: string;
	/** HTTP 预览地址（server 组装 artifacts 视图时回填） */
	url?: string;
	status: "pending" | "done" | "failed";
	error?: string;
	/** 本帧参考板包含的设计实体 id；顺序与合成板一致，也是设计源更新的精确级联依据 */
	refs?: string[];
	/** 服务端合成的多实体参考板；缺省表示无视觉参考或旧版单图 run */
	refSheet?: string;
	/** 这些实体的设计定稿在出图后又更新过：当前画面相对新设定已过期 */
	staleRefs?: string[];
	/** 出图时所依据的分镜提示词签名（prompt 前 200 字符的 hash）。
	 *  上游 refine（剧本/美术/提示词）重跑后签名变化 → 该帧标过期，防止旧画面顶着新分镜进入确认闸门。 */
	promptSig?: string;
	/** 用户在本轮关键帧确认时放行该镜；未勾选镜头不会进入视频生成 */
	confirmed?: boolean;
	/** 最近一次出图审核结论（帧 vs 其锚定的设计定稿；未审核/旧 run 缺省） */
	review?: DesignReview;
	/** 重绘总次数（手动+auto），上限 MAX_IMAGE_REDRAW */
	attempts: number;
	/** auto 路径独立计数（autoReviewKeyframes/autoReviewDesign 专用），上限 MAX_IMAGE_AUTO_REDRAW。
	 *  与 attempts 分离：不占用户手动配额。 */
	autoAttempts?: number;
	versions: string[];
}

export interface KeyframesDoc {
	frames: KeyframeEntry[];
	/** 部分确认通过后的制作清单；缺省/空 = 尚未记录（全量旧 run 兜底为全部） */
	confirmedShotIds?: string[];
	generatedAt?: string;
}

/** 分镜关键帧 → 文生图 prompt（视频首帧锚定图） */
export function keyframePrompt(shotPrompt: string, bible: VisualBible, characterAnchors?: string): string {
	return [
		"Cinematic still frame, first frame of a video shot:",
		shotPrompt,
		characterAnchors ? `character/scene appearance anchors (MUST match exactly, no drift): ${characterAnchors}` : "",
		bible.grade ? `color grade: ${bible.grade}` : "",
		"photographic quality, crisp focus, no text, no watermark",
	]
		.filter(Boolean)
		.join(", ");
}

/**
 * 关键帧依赖矩阵（P0）：从美术设计定稿推导一个镜头实际要锚定的实体。
 *
 * 规则刻意保持可解释、可测试：
 * - 主角默认入场（跨镜身份一致性是最强约束）；画面点名的角色最多取 2 个；
 * - 场景作为环境锚点入场；
 * - 道具只有在画面中点名时才入场，避免把无关产品压进每个镜头。
 */
export function pickKeyframeReferences(
	doc: Pick<DesignBibleDoc, "characters" | "props" | "scenes"> | null | undefined,
	haystack: string,
): DesignEntity[] {
	const text = haystack.toLowerCase();
	const available = [...(doc?.characters ?? []), ...(doc?.scenes ?? []), ...(doc?.props ?? [])].filter(
		(entity): entity is DesignEntity => entity.status === "done" && Boolean(entity.file),
	);
	const byNameHits = (a: DesignEntity, b: DesignEntity): number =>
		text.split(b.name.toLowerCase()).length - text.split(a.name.toLowerCase()).length || a.id.localeCompare(b.id);
	const mentionsOf = (entity: DesignEntity): number => text.split(entity.name.toLowerCase()).length - 1;

	const characters = available.filter((entity) => entity.category === "character").sort(byNameHits);
	const namedCharacters = characters.filter((entity) => mentionsOf(entity) > 0).slice(0, 2);
	const primaryCharacters = namedCharacters.length > 0 ? namedCharacters : characters.slice(0, 1);

	const scenes = available.filter((entity) => entity.category === "scene").sort(byNameHits);
	const props = available
		.filter((entity) => entity.category === "prop" && mentionsOf(entity) > 0)
		.sort(byNameHits)
		.slice(0, 1);

	return [...primaryCharacters, ...scenes.slice(0, 1), ...props];
}

// ============================================================================
// TTS 表演指导（stepaudio-2.5-tts 的 instruction 全局语境参数）
// ============================================================================

/**
 * 配音前为每一镜旁白生成表演指导（语气/语速/情绪/停顿），
 * 作为 TTS 的 instruction 参数注入 —— 让语音有情绪起伏而非平铺直叙。
 */
export function voiceDirectionsMessages(
	brief: EnrichedBrief,
	script: ScriptDoc,
	opts: GenerationOptions,
): ChatMessage[] {
	const lines = script.shots
		.map((s) => `- ${s.id}｜旁白:「${narrationFor(s, opts.promptLanguage)}」｜画面: ${s.visual.slice(0, 60)}`)
		.join("\n");
	const user = [
		"你是广告片的配音导演。为下面每一镜旁白写一句中文「表演指导」，交给 TTS 模型的 instruction 参数（全局语境控制）。",
		briefBlock(brief),
		brief.generationDirectives.audio.promptFragment
			? `声音方向约束: ${brief.generationDirectives.audio.promptFragment}`
			: "",
		"",
		"旁白表:",
		lines,
		"",
		"要求:",
		"1. 指导要具体可演：情绪基调 + 语速快慢 + 重音位置 + 气息/停顿（如「兴奋上扬，语速稍快，『冰爽一夏』重读并带笑意」）；",
		"2. 全片要有情绪曲线：开场抓人 → 中段推进 → 结尾收束或高潮，避免每镜同一个调；",
		"3. 每条 ≤80 字，纯指导语（不要复述旁白内容，不要舞台指示括号）；",
		"",
		'只输出 JSON: {"directions": [{"shotId": "SH01", "instruction": "…"}]}（覆盖全部镜头）',
	]
		.filter(Boolean)
		.join("\n");
	return [{ role: "user", content: user }];
}

/** 无 LLM 兜底：按情绪意图映射基础表演指导 */
export function fallbackVoiceDirection(brief: EnrichedBrief): string {
	const emotion = brief.intent.primaryEmotion;
	switch (emotion) {
		case "excited":
			return "语气兴奋饱满，语速比常速快，充满能量与笑意";
		case "calm":
			return "语气松弛温柔，语速放缓，气息平稳带呼吸感";
		case "nostalgic":
			return "语气温情怀旧，语速偏慢，尾音柔和下沉";
		case "confident":
			return "语气沉稳笃定，语速适中，关键词干脆有力";
		default:
			return "语气自然亲和，抑扬顿挫，关键词适当重读";
	}
}
