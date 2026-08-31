/**
 * 出图审核（视觉模型 step-3.7）：两类源头产物的「画面 vs 契约」比对。
 *
 * 1) 设计概念图 vs 设计要点（reviewDesignBible）：
 *    美术设计是全片视觉的决定性源头——银发老头若在设计卡上就画成了棕发，
 *    后续关键帧与视频只会把错误放大（历史 run：SH03 棕发即源于此）。
 * 2) 分镜关键帧 vs 其锚定的设计定稿（reviewKeyframes）：
 *    关键帧是视频首帧，帧上外观漂移会直接定格进成片。
 *
 * 与 consistency.ts（跨镜一致性）互补：
 * - 本模块：单产物 vs 契约（年龄/发色/服装/品类是否画对）；
 * - 一致性预检：跨镜 vs 彼此（前后镜外观是否跳变）。
 *
 * 结论写回各产物 json 的 review 字段（artifacts 视图自动透出）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runFfmpeg } from "./ffmpeg.ts";
import { chat, tryParseJson } from "./llm.ts";
import { trackLlmCost } from "./pricing.ts";
async function readArtifact(run, name) {
    return JSON.parse(await fs.promises.readFile(path.join(run.dir, name), "utf-8"));
}
async function writeJson(run, name, data) {
    await fs.promises.writeFile(path.join(run.dir, name), JSON.stringify(data, null, "\t"), "utf-8");
}
const SYSTEM_PROMPT = "你是一个严格的美术审校员。只输出一个合法的 JSON 对象（无围栏、无多余文本）。" +
    "只报告画面中确实可见的偏差，不要臆测；契约里没写的不要当问题。";
/** 压缩为 640px JPEG base64（原图 1-2MB PNG 直接送审会把请求撑到超时） */
async function compressForReview(run, items, signal, tmpPrefix) {
    const images = [];
    const tmpFiles = [];
    try {
        for (const [i, item] of items.entries()) {
            const tmp = path.join("assets", `.${tmpPrefix}-${i}.jpg`);
            await runFfmpeg(["-y", "-i", item.file, "-vf", "scale=640:-2", "-q:v", "4", tmp], run.dir, signal);
            tmpFiles.push(tmp);
            images.push(fs.readFileSync(path.join(run.dir, tmp)).toString("base64"));
        }
    }
    finally {
        for (const tmp of tmpFiles)
            await fs.promises.rm(path.join(run.dir, tmp), { force: true }).catch(() => { });
    }
    return images;
}
/** 宽容解析 LLM 审核结果：id → { verdict, issues }（未知 id 丢弃，非法值回退 ok） */
function parseVerdicts(raw, knownIds) {
    const sheets = Array.isArray(raw?.sheets)
        ? raw.sheets
        : [];
    const checkedAt = new Date().toISOString();
    const byId = new Map();
    for (const item of sheets.slice(0, 24)) {
        const s = item;
        if (typeof s.id !== "string" || !knownIds.has(s.id))
            continue;
        const verdict = s.verdict === "ok" || s.verdict === "warn" || s.verdict === "fail" ? s.verdict : "ok";
        byId.set(s.id, {
            verdict,
            issues: (Array.isArray(s.issues) ? s.issues : [])
                .filter((x) => typeof x === "string" && x.trim().length > 0)
                .map((x) => x.trim().slice(0, 200))
                .slice(0, 5),
            checkedAt,
        });
    }
    return byId;
}
/** 单次多模态审核调用（全帧送审比逐帧调用快且省额度；超时放宽到 5 分钟） */
async function visionReview(
/** 需带 priceCatalog：审核是多模态调用，成本须计入 run.metrics.cost */
ctx, run, items, signal, userPrompt) {
    const images = await compressForReview(run, items, signal, "vision-review");
    const llm = { ...ctx.llm, timeoutMs: Math.max(ctx.llm.timeoutMs, 300_000) };
    const content = [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                { type: "text", text: userPrompt },
                ...images.map((b64) => ({
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${b64}` },
                })),
            ],
        },
    ];
    const raw = await chat(llm, content, signal);
    trackLlmCost(run, ctx, userPrompt, raw, images.length); // images 参与多模态计费
    const byId = parseVerdicts(tryParseJson(raw), new Set(items.map((i) => i.id)));
    if (byId.size === 0)
        throw new Error("审校模型未返回有效的审核结果");
    return byId;
}
const CATEGORY_ZH = {
    character: "人物",
    prop: "道具",
    scene: "场景",
};
/**
 * 审核设计出图（同步，一次多模态调用带全部设计图，约 10-30s）。
 * @param entityIds 可选：只复审指定卡（自动重绘后定向复审）；缺省审核全部已完成卡
 */
export async function reviewDesignBible(
/** 需带 priceCatalog：审核是多模态调用，成本须计入 run.metrics.cost */
ctx, run, signal, entityIds) {
    const doc = await readArtifact(run, "design-bible.json");
    const only = entityIds ? new Set(entityIds) : null;
    const entities = [...doc.characters, ...doc.props, ...doc.scenes].filter((e) => e.status === "done" && e.file && fs.existsSync(path.join(run.dir, e.file)) && (!only || only.has(e.id)));
    if (entities.length === 0)
        throw new Error("没有可审核的设计图（均未生成或文件缺失）");
    const order = entities.map((e, i) => `第 ${i + 1} 张 = ${e.id}（${e.name}）`).join("，");
    const spec = entities
        .map((e) => `- ${e.id}（${e.name}，${CATEGORY_ZH[e.category]}）设计要点: ${e.design}`)
        .join("\n");
    const userPrompt = [
        `下面按顺序给出 ${entities.length} 张美术概念设计图。图顺序：${order}。`,
        "",
        "每张图对应的设计要点（这是唯一契约，画面必须与之相符）：",
        spec,
        "",
        "逐张对照设计要点审查：",
        "1. 人物：年龄、发型发色、体型、服装颜色与款式是否与要点一致（要点写 silver-gray hair 的 68 岁老人，画面就必须是银灰发老年男性）；",
        "2. 道具/场景：品类、形态、材质、色彩、空间结构是否与要点一致；",
        "3. 画面缺陷：乱码文字、水印、logo、明显畸变。",
        "",
        "verdict 取值：ok（与要点相符）/ warn（有小偏差但可用）/ fail（明显不符或不可用）。",
        "issues 用中文写清具体偏差（如「设计要点为银灰发，画面为棕色头发」），ok 时给空数组。",
        "",
        '只输出 JSON: {"sheets": [{"id": "CH01", "verdict": "ok", "issues": []}]}（覆盖全部送审卡）',
    ].join("\n");
    const byId = await visionReview(ctx, run, entities.map((e) => ({ id: e.id, file: e.file, spec: e.design })), signal, userPrompt);
    for (const e of entities) {
        const review = byId.get(e.id);
        if (review)
            e.review = review;
    }
    await writeJson(run, "design-bible.json", doc);
    return { doc, reviewed: entities };
}
/**
 * 审核关键帧（同步，一次多模态调用带全部帧，约 10-30s）。
 * 只审有设计实体依赖（refs）的帧：比对帧上人物/场景外观与设计定稿要点；
 * 纯文本锚点的帧无从比对契约，跳过（一致性预检另行覆盖跨镜维度）。
 * @param shotIds 可选：只复审指定镜（自动重绘后定向复审）；缺省审核全部可审帧
 */
export async function reviewKeyframes(
/** 需带 priceCatalog：审核是多模态调用，成本须计入 run.metrics.cost */
ctx, run, signal, shotIds) {
    const kf = await readArtifact(run, "keyframes.json");
    const design = await readArtifact(run, "design-bible.json");
    const entityById = new Map([...design.characters, ...design.props, ...design.scenes].map((e) => [e.id, e]));
    const only = shotIds ? new Set(shotIds) : null;
    // 每帧契约 = 其 refs 指向的（最新）设计定稿要点
    const candidates = kf.frames.filter((f) => f.status === "done" &&
        f.file &&
        fs.existsSync(path.join(run.dir, f.file)) &&
        (!only || only.has(f.shotId)) &&
        (f.refs ?? []).some((id) => entityById.get(id)?.file));
    if (candidates.length === 0)
        throw new Error("没有可审核的关键帧（无设计实体依赖或文件缺失）");
    const specOf = (frame) => (frame.refs ?? [])
        .filter((id) => entityById.has(id))
        .map((id) => {
        const e = entityById.get(id);
        return `- ${CATEGORY_ZH[e.category]}「${e.name}」要点: ${e.design}`;
    })
        .join("\n");
    const order = candidates.map((f, i) => `第 ${i + 1} 张 = ${f.shotId}`).join("，");
    const spec = candidates.map((f) => `【${f.shotId}】该帧画面必须匹配以下设计定稿：\n${specOf(f)}`).join("\n\n");
    const userPrompt = [
        `下面按顺序给出一个广告片的 ${candidates.length} 个分镜关键帧（视频首帧）。帧顺序：${order}。`,
        "",
        "每帧锚定的设计定稿要点（这是唯一契约，帧上对应元素必须与之一致）：",
        spec,
        "",
        "逐帧审查：",
        "1. 帧上人物的外观（年龄、发型发色、体型、服装颜色与款式）是否与对应人物设计定稿一致（定稿是银灰发老年男性，帧上就不能是棕发中年人）；",
        "2. 帧上场景/道具的形态与材质是否与对应定稿一致；",
        "3. 画面缺陷：乱码文字、水印、logo、明显畸变。",
        "",
        "verdict 取值：ok（与定稿相符）/ warn（有小偏差但可用）/ fail（明显不符或不可用）。",
        "issues 用中文写清具体偏差（如「人物应为银灰发老年男性，帧上为棕发中年男性」），ok 时给空数组。",
        "",
        '只输出 JSON: {"sheets": [{"id": "SH01", "verdict": "ok", "issues": []}]}（覆盖全部送审帧）',
    ].join("\n");
    const byId = await visionReview(ctx, run, candidates.map((f) => ({ id: f.shotId, file: f.file, spec: specOf(f) })), signal, userPrompt);
    for (const f of candidates) {
        const review = byId.get(f.shotId);
        if (review)
            f.review = review;
    }
    await writeJson(run, "keyframes.json", kf);
    return { doc: kf, reviewed: candidates };
}
/** 读取设计审核结论（artifacts 视图已随 design 透出，此函数供管线内部复用） */
export async function getDesignReview(run) {
    try {
        return await readArtifact(run, "design-bible.json");
    }
    catch {
        return null;
    }
}
