/**
 * 音色分配（配音选角）—— 解决「旁白和角色撞声」「没有角色设计感」问题。
 *
 * 起因（2026-08-30 用户反馈）：旁白 TTS 从不传 voice 参数、角色未绑音色时也回落
 * 适配器默认音色——旁白开场后人物一开口是同一个声音，分不清谁在说话。
 *
 * 规则（确定性，纯函数，无 pipeline 依赖）：
 *   1. 显式绑定（CoCharacter.voiceId，来自 UI）优先，永不覆盖；
 *   2. 未绑定的角色从**人物设计描述**启发式推导（性别 × 年龄段 → 分龄音色池，
 *      池内按气质偏好排序），同片内去重——第一个角色拿池内首选，冲突顺延；
 *   3. 旁白音色**必须避开全部角色已占用的音色**（播音腔偏好序取第一个空闲）；
 *      显式指定旁白音色时优先，但若与角色撞声会记 note。
 *
 * 音色库（models.json voices）已按 stepfun 官方音色清单扩到 24 个（男 12 / 女 12），
 * 分龄池让「8 岁女孩」与「68 岁爷爷」天然不同声——角色设计感来自选型而非运气。
 */
/** 分龄分性音色池（组内顺序即气质偏好序；值 = StepFun voice id，须存在于 models.json voices） */
const VOICE_POOLS = {
    maleElder: ["shenchennanyin", "cixingnansheng", "ruyananshi"],
    maleAdult: ["zixinnansheng", "cixingnansheng", "zhengpaiqingnian", "shuangkuainansheng"],
    maleYoung: ["qingniandaxuesheng", "wenrougongzi", "yuanqinansheng"],
    femaleElder: ["wenroushunv", "jingdiannvsheng"],
    femaleAdult: ["jingdiannvsheng", "youyanvsheng", "lengyanyujie", "linjiajiejie", "wenrounvsheng", "tianmeinvsheng"],
    femaleYoung: ["qingchunshaonv", "jilingshaonv", "yuanqishaonv", "livelybreezy-female"],
    femaleChild: ["ruanmengnvsheng", "qingchunshaonv"],
};
/** 旁白音色偏好序（播音腔优先；逐个跳过被角色占用的） */
const NARRATOR_PREFERENCE = [
    "boyinnansheng",
    "jingdiannvsheng",
    "linjiajiejie",
    "ruyananshi",
    "wenrounvsheng",
    "cixingnansheng",
    "wenrounansheng",
];
const MALE_HINTS = /男|叔|伯|爷|爸|父|夫|哥|弟|兄|先生|师傅|师父|老公|男孩|小伙|男子|郎|绅士|公子|士兵|车夫|枪手|水手|老板/;
const FEMALE_HINTS = /女|奶|婆|母|娘|姨|姐|妹|婶|嫂|妻|媳妇|姑娘|女士|少女|女孩|御姐|小姐/;
const ELDER_HINTS = /爷爷|老爷|奶奶|老太太|老先生|老人|老翁|老爸|老妈|翁|婆|花白|白发|退休|暮年/;
const CHILD_HINTS = /儿童|孩子|小孩|孙女|孙子|童|幼|小女|小男|小姑|小娃/;
/** 从「角色名 + 人物设计」推测年龄段与性别 → 音色池 */
export function voicePoolForDescription(text) {
    const isMale = MALE_HINTS.test(text);
    const isFemale = !isMale && FEMALE_HINTS.test(text);
    const isElder = ELDER_HINTS.test(text);
    const isChild = CHILD_HINTS.test(text);
    // 数字年龄：≤12 儿童、≥55 老年，其余按关键词
    const age = /(\d{1,2})\s*岁/.exec(text)?.[1];
    const ageNum = age !== undefined ? Number(age) : undefined;
    const elder = isElder || (ageNum !== undefined && ageNum >= 55);
    const child = !elder && (isChild || (ageNum !== undefined && ageNum <= 12));
    const young = !elder && !child && (ageNum !== undefined && ageNum <= 24);
    if (child)
        return VOICE_POOLS.femaleChild; // 男童也走女童池反串（配音惯例；官方无男童声线）
    if (isMale) {
        if (elder)
            return VOICE_POOLS.maleElder;
        if (young)
            return VOICE_POOLS.maleYoung;
        return VOICE_POOLS.maleAdult;
    }
    if (elder)
        return VOICE_POOLS.femaleElder;
    if (young)
        return VOICE_POOLS.femaleYoung;
    return VOICE_POOLS.femaleAdult;
}
/** 从目录里取第一个未被占用的音色（顺序 = 传入顺序）；全被占用返回 undefined */
function firstFree(pool, catalogValues, used) {
    for (const v of pool) {
        if (!catalogValues.has(v) || used.has(v))
            continue;
        return v;
    }
    return undefined;
}
/**
 * 配音选角：给全部角色分配音色并选出旁白音色（角色声与旁白声保证错开）。
 * @param cast     共创角色卡（name + description 人物设计 + 可选显式 voiceId）
 * @param catalog  可用音色表（label → id；来自 TTS 适配器配置）
 * @param opts.narratorVoiceId 显式指定旁白音色（调用方自行 resolve 成 id）
 */
export function assignCastVoices(cast, catalog, opts = {}) {
    const catalogValues = new Set(Object.values(catalog));
    const used = new Set();
    const byCharacter = {};
    const notes = [];
    for (const member of cast) {
        const explicit = member.voiceId?.trim();
        if (explicit) {
            byCharacter[member.name] = explicit;
            if (catalogValues.has(explicit))
                used.add(explicit);
            else
                notes.push(`角色「${member.name}」显式音色 ${explicit} 不在音色库中，播放时将由适配器回退默认`);
            continue;
        }
        // 启发式读「角色名 + 人物设计」：性别/年龄线索常只在名字里（爷爷/孙女/叔叔…）
        const pool = voicePoolForDescription(`${member.name}；${member.description ?? ""}`);
        let picked = firstFree(pool, catalogValues, used);
        if (!picked) {
            // 池内耗尽 → 同性别相邻年龄段补位 → 异性别兜底，如实留痕
            const sameGenderFallbacks = pool === VOICE_POOLS.maleElder || pool === VOICE_POOLS.maleAdult || pool === VOICE_POOLS.maleYoung
                ? [VOICE_POOLS.maleElder, VOICE_POOLS.maleAdult, VOICE_POOLS.maleYoung].filter((p) => p !== pool)
                : [VOICE_POOLS.femaleAdult, VOICE_POOLS.femaleYoung, VOICE_POOLS.femaleElder, VOICE_POOLS.femaleChild].filter((p) => p !== pool);
            for (const p of [...sameGenderFallbacks, VOICE_POOLS.maleElder, VOICE_POOLS.femaleAdult]) {
                picked = firstFree(p, catalogValues, used);
                if (picked) {
                    notes.push(`角色「${member.name}」的音色池已用尽，跨池借用 ${picked}（同片可能与他人同声）`);
                    break;
                }
            }
        }
        if (!picked) {
            notes.push(`角色「${member.name}」无可用音色，回退适配器默认（可能与旁白/他人同声）`);
            continue;
        }
        byCharacter[member.name] = picked;
        used.add(picked);
    }
    // 旁白：显式指定优先（撞声留痕）；否则播音腔偏好序取第一个角色未占用的
    let narratorVoiceId;
    if (opts.narratorVoiceId) {
        narratorVoiceId = opts.narratorVoiceId;
        if (used.has(narratorVoiceId))
            notes.push(`旁白显式指定音色 ${narratorVoiceId} 与角色撞声（显式优先）`);
    }
    else {
        narratorVoiceId = NARRATOR_PREFERENCE.filter((v) => catalogValues.has(v)).find((v) => !used.has(v));
        if (!narratorVoiceId) {
            narratorVoiceId = NARRATOR_PREFERENCE.filter((v) => catalogValues.has(v))[0];
            notes.push(`音色库被角色占满，旁白回退 ${narratorVoiceId}（与角色同声，建议扩音色库或显式指定旁白音色）`);
        }
    }
    return { byCharacter, narratorVoiceId, notes };
}
/**
 * 旁白音色速查（重录/重配路径用）：避开台词镜已占用的音色。
 * @param usedVoiceIds 台词镜当前绑定的音色集合（dialogue.voiceId）
 */
export function narratorVoiceFor(catalog, usedVoiceIds, explicit) {
    if (explicit)
        return explicit;
    const catalogValues = new Set(Object.values(catalog));
    const used = new Set(usedVoiceIds.filter((v) => Boolean(v)));
    const preference = NARRATOR_PREFERENCE.filter((v) => catalogValues.has(v));
    // 全被角色占用时回落偏好序首位——旁白总得有个声，宁可撞声（留痕在 assignCastVoices 语境）也不无声
    return preference.find((v) => !used.has(v)) ?? preference[0];
}
