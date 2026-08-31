/**
 * 音频驱动（台词模式）的纯校验函数集（A1 / D1）。
 *
 * 独立成文件的原因：这些规则必须可单测（契约测试直接调用），
 * 且不能依赖 pipeline（避免循环依赖）——只依赖 prompts 的类型。
 *
 * D1（多角色对白前置拦截）为什么落在剧本阶段：
 * 「每镜一条主语音」是 2.5-flash 的运行时约束（audios 多条互相干扰），
 * 不前置拦截，用户写完剧本才发现要拆镜——返工且已烧 script 阶段配额。
 * 符合项目"闸门优先于派发"原则。
 */
import { sanitizeDialogue } from "./prompts.ts";
import { assignCastVoices } from "./voice-cast.ts";
/**
 * A1.4 服务端兜底闸门判定：台词模式只对共创来源开放。
 * 只藏 UI 开关不够——直接打 API 仍能传 dialogue；白名单校验只防非法值，
 * 不防"来源不符"，所以这里单独一道闸。抽成纯函数供契约测试锁定。
 * 返回 true = 应强制回落 off（请求了 dialogue 但无共创空间）。
 */
export function shouldGateAudioDrive(audioDrive, coSpace) {
    return audioDrive === "dialogue" && !coSpace;
}
/** 说话人前缀：行首「名字：」/「名字:」（中文冒号或英文冒号+空格）。
 *  剧本里多角色对白最常见的书写形态，也是唯一值得机器识别的形态。 */
const SPEAKER_PREFIX = /^\s*([^\s:：]{1,12})\s*[：:]\s*/;
/** 识别台词文本里的说话人集合（去重）。无标记 → 空集（单说话人，不拦）。 */
export function detectSpeakers(text) {
    const speakers = new Set();
    for (const line of text.split(/\r?\n/)) {
        const m = SPEAKER_PREFIX.exec(line);
        if (m?.[1])
            speakers.add(m[1]);
    }
    return [...speakers];
}
/** 该台词镜是否含多角色对白（D1 的判定依据；台词文本与 characterId 数组两个来源都查）。 */
export function hasMultipleSpeakers(shot) {
    if (shot.audioMode !== "dialogue" || !shot.dialogue)
        return false;
    const text = [shot.dialogue.lines.zh, shot.dialogue.lines.en].join("\n");
    if (detectSpeakers(text).length > 1)
        return true;
    // characterId 被写成数组（LLM 偶发形态）同样视为多角色
    const cid = shot.dialogue.characterId;
    return Array.isArray(cid) && cid.length > 1;
}
/**
 * D1 剧本落盘前的前置闸门：多角色对白必须拆镜。
 * 违规镜降级为旁白形态（台词并进旁白字段，供 TTS 正常朗读）并附警告——
 * 降级优于阻断：剧本阶段已消耗配额，整段重跑代价过高；用户可在剧本页微调后重跑。
 */
export function enforceSingleSpeaker(script) {
    const warnings = [];
    const shots = script.shots.map((shot) => {
        if (!hasMultipleSpeakers(shot))
            return shot;
        const dialogue = sanitizeDialogue(shot.dialogue);
        const zh = dialogue?.lines.zh || shot.narrationZh;
        const en = dialogue?.lines.en || shot.narrationEn;
        warnings.push(`镜头 ${shot.id} 的台词含多个说话人——台词模式每镜只能有一条主语音（多角色对白必须拆镜）。已暂按旁白处理，建议拆镜后重跑剧本。`);
        const { audioMode: _mode, dialogue: _drop, ...rest } = shot;
        return {
            ...rest,
            audioMode: "narration",
            narrationZh: zh,
            narrationEn: en,
        };
    });
    return { script: { ...script, shots }, warnings };
}
/**
 * A7 音色绑定 + 配音选角：把共创角色卡上绑定的 voiceId 写进台词镜；
 * 未绑定的角色按**人物设计描述**自动分配音色（voice-cast.ts 启发式，同片去重）。
 * LLM 拿不到 StepFun voice id——显式绑定只能来自 UI（CoCharacter.voiceId），
 * 由剧本落盘前按 characterId 确定性注入；LLM 自带的 voiceId（若有）优先不覆盖。
 * 自动分配解决「旁白和角色撞声」的前一半：角色不再全部回落同一默认音色。
 * 纯函数：无绑定/无台词镜时原样返回，幂等可重入。
 */
export function bindCharacterVoices(script, coSpace, catalog = {}) {
    const cast = coSpace?.characters ?? [];
    const byName = new Map(cast
        .filter((c) => typeof c.voiceId === "string" && c.voiceId.trim())
        .map((c) => [c.name, c.voiceId.trim()]));
    // 自动分配（显式绑定优先，推导补位，同片去重）；catalog 为空（无音色库配置）时跳过推导
    const assignment = cast.length > 0 && Object.keys(catalog).length > 0
        ? assignCastVoices(cast.map((c) => ({ name: c.name, description: c.description, voiceId: c.voiceId })), catalog)
        : null;
    return {
        ...script,
        shots: script.shots.map((shot) => {
            if (shot.audioMode !== "dialogue" || !shot.dialogue)
                return shot;
            if (shot.dialogue.voiceId)
                return shot;
            const bound = byName.get(shot.dialogue.characterId) ?? assignment?.byCharacter[shot.dialogue.characterId];
            return bound ? { ...shot, dialogue: { ...shot.dialogue, voiceId: bound } } : shot;
        }),
    };
}
