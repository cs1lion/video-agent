/**
 * 字幕审核（确定性，纯函数）—— QA 视觉审核之外的第二层字幕防线。
 *
 * 视觉模型能看「渲染出来的字幕长什么样」（错字/截断/遮挡），但看不了
 * 「时间轴重叠」「旁白覆盖率」「编码错乱前兆」这类结构性缺陷——本模块补这一层。
 *
 * 起因（2026-08-30 e2e 抽帧实锤）：buildAssSubtitles 的 Dialogue 行只写 5 字段而
 * Events Format 声明 10 字段，libass 按 Format 定位列——字幕文本落进 Name 列、
 * Text 渲染列恒为空，**所有历史成片的烧录字幕实际都没渲染出来**。本模块的
 * 解析器按 Format 行做列映射，对任意合法字段布局都能读，不再依赖特定写法。
 */
/** h:mm:ss.cc（厘秒）→ 秒；非法返回 null */
function assTimeToSec(raw) {
    const m = raw.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,3})$/);
    if (!m)
        return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
}
/** 按事件区 Format 行做列映射解析 Dialogue 行（对字段增删/换序稳健） */
export function parseAssSubtitles(assText) {
    const eventsIdx = assText.indexOf("[Events]");
    if (eventsIdx === -1)
        return [];
    const body = assText.slice(eventsIdx);
    const formatLine = body
        .split(/\r?\n/)
        .find((l) => /^Format:/i.test(l.trim()));
    if (!formatLine)
        return [];
    const columns = formatLine
        .slice("Format:".length)
        .split(",")
        .map((c) => c.trim().toLowerCase());
    const startIdx = columns.indexOf("start");
    const endIdx = columns.indexOf("end");
    const textIdx = columns.indexOf("text");
    if (startIdx === -1 || endIdx === -1 || textIdx === -1)
        return [];
    const out = [];
    for (const line of body.split(/\r?\n/)) {
        if (!/^Dialogue:/i.test(line.trim()))
            continue;
        // Text 是声明中的最后一段：从 Text 列起的所有字段都归文本（文本自身可含逗号）
        const fields = line.trim().slice("Dialogue:".length).split(",");
        const startSec = assTimeToSec(fields[startIdx] ?? "");
        const endSec = assTimeToSec(fields[endIdx] ?? "");
        const text = fields.slice(textIdx).join(",").trim();
        if (startSec === null || endSec === null || !text)
            continue;
        out.push({ startSec, endSec, text });
    }
    return out;
}
/** 行文本是否含明显乱码前兆：替换符 / 控制字符（\N 换行标记除外） */
function hasMojibakeMarkers(text) {
    const cleaned = text.replace(/\\N/gi, "");
    if (cleaned.includes("\uFFFD"))
        return true;
    // C0 控制字符（除 \t 外不应出现）
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(cleaned))
        return true;
    return false;
}
const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
/**
 * 字幕结构审核。
 * @param assText      subs.ass 全文
 * @param expectedLines 期望行数（= 有旁白文本的镜头数；0 = 本片无字幕来源）
 * @param locale       文案语言（zh 时校验 CJK 存在，防编码错乱）
 */
export function auditSubtitles(assText, expectedLines, locale) {
    const parsed = parseAssSubtitles(assText);
    const issues = [];
    if (expectedLines > 0 && parsed.length === 0) {
        return { present: false, lines: 0, issues: [`字幕缺失：有 ${expectedLines} 段旁白文本，但字幕文件没有任何可解析的字幕行`] };
    }
    if (expectedLines > 0 && parsed.length < expectedLines) {
        issues.push(`字幕覆盖缺口：旁白 ${expectedLines} 段，字幕只有 ${parsed.length} 行`);
    }
    if (expectedLines === 0 && parsed.length > 0) {
        issues.push(`意外字幕：本片无旁白文本，但字幕文件有 ${parsed.length} 行`);
    }
    const sorted = [...parsed].sort((a, b) => a.startSec - b.startSec);
    for (const [i, sub] of sorted.entries()) {
        const at = `${sub.startSec.toFixed(1)}s`;
        const cleanedText = sub.text.replace(/\\N/gi, "");
        if (!cleanedText.trim())
            issues.push(`空字幕文本 @${at}`);
        if (hasMojibakeMarkers(sub.text))
            issues.push(`疑似乱码（替换符/控制字符）@${at}：「${sub.text.slice(0, 24)}」`);
        if (locale === "zh" && !CJK.test(cleanedText) && cleanedText.length > 0) {
            issues.push(`中文字幕行无 CJK 字符（疑似编码错乱）@${at}：「${sub.text.slice(0, 24)}」`);
        }
        const dur = sub.endSec - sub.startSec;
        if (sub.startSec < 0 || dur <= 0)
            issues.push(`时间轴非法（结束早于开始）@${at}`);
        else if (dur < 0.3)
            issues.push(`停留过短（${dur.toFixed(2)}s，读不完）@${at}`);
        else if (dur > 15)
            issues.push(`停留过长（${dur.toFixed(1)}s，疑似时间轴错误）@${at}`);
        const prev = i > 0 ? sorted[i - 1] : null;
        if (prev && sub.startSec < prev.endSec - 0.2) {
            issues.push(`与上一行重叠 >0.2s（叠字）@${at}`);
        }
    }
    return { present: parsed.length > 0, lines: parsed.length, issues };
}
