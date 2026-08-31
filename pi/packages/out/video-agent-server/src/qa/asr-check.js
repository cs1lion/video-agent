/**
 * ASR 转写校验——「模型自行配音/胡言乱语」的语义级防线。
 *
 * 包络相关（audio-follow.ts）只能证明"节奏像"，证明不了"说的是这句话"。
 * 2026-08-30 Step Plan 开放 ASR（step_plan/v1/audio/asr/sse，stepaudio-2.5-asr）：
 * 把成片段音轨转写成文本，与台词原文做字面重合比对——乱语的重合率趋近 0，
 * 正常跟读 ≥0.6。包络判节奏、ASR 判内容，双关卡齐过才算跟读成功。
 *
 * 容错：ASR 调用失败（网络/额度）→ 返回 null，调用方退回仅包络判定（不阻断产线）。
 */
import { decodeMonoPcm } from "../ffmpeg.ts";
const ASR_ENDPOINT = "https://api.stepfun.com/step_plan/v1/audio/asr/sse";
/** 字面重合率：去标点空白后的字符多重集 F1（0-1）。中文单字粒度，对同音错字鲁棒。 */
export function normalizedOverlap(expected, actual) {
    const clean = (t) => t.replace(/[\s\spp。，、！？：；「」『』""''（）\[\]{}…—·,.'!?;:()"-]/gu, "");
    const a = clean(expected);
    const b = clean(actual);
    if (a.length === 0 || b.length === 0)
        return 0;
    const count = new Map();
    for (const ch of a)
        count.set(ch, (count.get(ch) ?? 0) + 1);
    let common = 0;
    for (const ch of b) {
        const left = count.get(ch) ?? 0;
        if (left > 0) {
            common += 1;
            count.set(ch, left - 1);
        }
    }
    return (2 * common) / (a.length + b.length);
}
/** ASR 转写结果（SSE 流拼接） */
export async function transcribeAudio(pcmBase64, opts) {
    const body = {
        audio: {
            data: pcmBase64,
            input: {
                transcription: { model: "stepaudio-2.5-asr", language: opts.language ?? "zh", enable_itn: true },
                format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 },
            },
        },
    };
    const res = await fetch(ASR_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}`, accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: opts.signal,
    });
    if (!res.ok)
        throw new Error(`ASR HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const raw = await res.text();
    // SSE：取 transcript.text.done 的完整文本；缺失则拼接 deltas
    let doneText;
    const deltas = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:"))
            continue;
        try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === "transcript.text.done" && typeof evt.text === "string")
                doneText = evt.text;
            else if (evt.type === "transcript.text.delta" && typeof evt.delta === "string")
                deltas.push(evt.delta);
        }
        catch {
            // 非 JSON 行忽略
        }
    }
    const text = doneText ?? deltas.join("");
    if (!text)
        throw new Error("ASR 响应无文本");
    return text;
}
/** 字面重合判定阈值（0.5：同音错字/标点差异不误伤，乱语趋 0 必拦） */
export const ASR_OVERLAP_THRESHOLD = 0.5;
/**
 * 校验成片段音轨是否说出了预期的台词（语义级可懂判定）。
 * 流程：clip 音轨 → 16k 单声道 PCM → base64 → ASR SSE → 与 expectedLine 字面比对。
 */
export async function referenceIntelligible(cwd, clipPath, expectedLine, opts) {
    const threshold = opts.threshold ?? ASR_OVERLAP_THRESHOLD;
    const pcm = await decodeMonoPcm(cwd, clipPath, 16000, opts.signal);
    const pcmBase64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
    const transcribed = await transcribeAudio(pcmBase64, { apiKey: opts.apiKey, signal: opts.signal });
    const overlap = normalizedOverlap(expectedLine, transcribed);
    return { intelligible: overlap >= threshold, overlap, transcribed };
}
