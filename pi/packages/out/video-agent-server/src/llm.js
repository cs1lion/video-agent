/**
 * 极简 OpenAI 兼容 chat/completions 客户端 + 严格 JSON 输出模式。
 *
 * 管线三个文本阶段（剧本/美术设计/镜头提示词）都要求 LLM 返回 JSON：
 * - chatJson 负责剥掉 ```json 围栏、截取 JSON 主体并解析；
 * - 解析失败自动带错误反馈重试一次；
 * - 429/5xx 自动退避重试一次。
 */
const JSON_SYSTEM_PROMPT = "你是一个严格遵循输出格式的助手。只输出一个合法的 JSON 对象（UTF-8，无注释、无多余文本、无 markdown 围栏）。";
export class LlmError extends Error {
}
async function chatOnce(llm, messages, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`LLM 请求超时 (${llm.timeoutMs}ms)`)), llm.timeoutMs);
    const onOuterAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
        const response = await fetch(llm.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
            },
            body: JSON.stringify({ model: llm.model, messages, temperature: 0.7 }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            // 451 内容审核有误伤（同一 prompt 复发概率低），与 429/5xx 一样值得重试
            const retryable = response.status === 429 || response.status === 451 || response.status >= 500;
            throw new LlmError(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`, {
                cause: { retryable },
            });
        }
        const payload = (await response.json());
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content) {
            throw new LlmError(`LLM 响应缺少 choices.0.message.content: ${JSON.stringify(payload).slice(0, 200)}`);
        }
        return content;
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
    }
}
function isRetryable(error) {
    if (error instanceof LlmError) {
        const cause = error.cause;
        return cause?.retryable === true;
    }
    if (error instanceof Error)
        return /timeout|network|fetch failed|econn/i.test(error.message);
    return false;
}
/** 单轮对话（自动重试一次可重试错误） */
export async function chat(llm, messages, signal) {
    try {
        return await chatOnce(llm, messages, signal);
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        if (!isRetryable(error))
            throw error;
        await sleep(3000, signal);
        return chatOnce(llm, messages, signal);
    }
}
/** 要求 LLM 输出 JSON 并解析；解析失败带反馈重试一次 */
export async function chatJson(llm, userPrompt, signal) {
    const attempt = async (extra) => chat(llm, [
        { role: "system", content: JSON_SYSTEM_PROMPT },
        { role: "user", content: extra ? `${userPrompt}\n\n${extra}` : userPrompt },
    ], signal);
    const content = await attempt();
    const parsed = tryParseJson(content);
    if (parsed !== undefined)
        return parsed;
    // 带解析错误反馈重试一次
    const retry = await attempt("你上次的输出不是合法 JSON（或包含围栏/多余文本），请重新只输出 JSON 对象本身。");
    const reparsed = tryParseJson(retry);
    if (reparsed !== undefined)
        return reparsed;
    throw new LlmError(`LLM 两次均未返回合法 JSON: ${content.slice(0, 160)}…`);
}
/** 多模态（带图）JSON 调用：images 为 JPEG base64 数组 */
export async function chatVisionJson(llm, userPrompt, images, signal) {
    if (images.length === 0)
        throw new LlmError("chatVisionJson 需要至少一张图片");
    const buildContent = (extra) => [
        { type: "text", text: extra ? `${userPrompt}\n\n${extra}` : userPrompt },
        ...images.map((b64) => ({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${b64}` },
        })),
    ];
    const content = await chat(llm, [
        { role: "system", content: JSON_SYSTEM_PROMPT },
        { role: "user", content: buildContent() },
    ], signal);
    const parsed = tryParseJson(content);
    if (parsed !== undefined)
        return parsed;
    const retry = await chat(llm, [
        { role: "system", content: JSON_SYSTEM_PROMPT },
        {
            role: "user",
            content: buildContent("你上次的输出不是合法 JSON，请重新只输出 JSON 对象本身。"),
        },
    ], signal);
    const reparsed = tryParseJson(retry);
    if (reparsed !== undefined)
        return reparsed;
    throw new LlmError(`视觉模型两次均未返回合法 JSON: ${content.slice(0, 160)}…`);
}
/** 宽容 JSON 提取：剥围栏、截取首尾大括号间内容 */
export function tryParseJson(raw) {
    const stripped = raw
        .replace(/```(?:json)?\s*/gi, "")
        .replace(/```/g, "")
        .trim();
    const candidates = [stripped];
    const first = stripped.search(/[{[]/);
    const lastBrace = Math.max(stripped.lastIndexOf("}"), stripped.lastIndexOf("]"));
    if (first >= 0 && lastBrace > first)
        candidates.push(stripped.slice(first, lastBrace + 1));
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        }
        catch {
            // 尝试下一个候选
        }
    }
    return undefined;
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("已中止"));
        }, { once: true });
    });
}
