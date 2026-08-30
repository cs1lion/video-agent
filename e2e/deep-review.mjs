/**
 * 整片深审（一次性脚本）：成片视频(base64) + 剧本设计预期 + 审阅要求 → step-3.7-flash
 * 视频理解 → 问题清单。用户要求：不抽帧，直接发视频让模型看完挑问题。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = "http://127.0.0.1:8790";
const KEY = JSON.parse(fs.readFileSync(".pi-studio/models.json", "utf-8")).vision.apiKey;
const batchDir = process.argv[2];

const runs = JSON.parse(fs.readFileSync(path.join(batchDir, "summary.json"), "utf-8")).results;

for (const r of runs) {
  const caseDir = path.join(batchDir, r.dir);
  const finalPath = path.join(caseDir, "06-export", "final.mp4");
  if (!fs.existsSync(finalPath)) continue;
  const script = JSON.parse(fs.readFileSync(path.join(caseDir, "01-script", "script.json"), "utf-8"));
  const brief = JSON.parse(fs.readFileSync(path.join(caseDir, "00-input", "brief.json"), "utf-8"));
  const vc = (() => { try { return JSON.parse(fs.readFileSync(path.join(caseDir, "05-audio", "voice-cast.json"), "utf-8")); } catch { return null; }})();

  const design = {
    logline: brief.logline,
    keyMessage: brief.keyMessage,
    shots: script.shots.map((s) => ({
      id: s.id,
      audioMode: s.audioMode,
      台词: s.dialogue?.lines?.zh ?? "",
      说话角色: s.dialogue?.characterId ?? "",
      旁白: s.narrationZh ?? "",
      画面设计: s.visual,
    })),
    音色分配: vc ? { 旁白: vc.narratorVoiceId, ...vc.characters } : undefined,
  };

  const requirements = `你是一名严格的成片审校。下面给你【设计预期 JSON】与【成片视频】。请逐项核对成片是否兑现设计，找出所有可观察到的问题：
1. 台词：人物说出的话是否与设计台词一致、是否清晰可懂（有无含糊吞字/胡言乱语/说着与字幕无关的内容）；
2. 字幕：字幕文本是否与所说台词/旁白对应，有无错别字、乱码，出现与消失时机是否自然；
3. 声音：旁白与对白是否清晰，有无突然的长时间死寂、重复声、异常噪声或嘶嘶声；
4. 口型：说话镜头里人物口型是否在动、大致与所说内容匹配；
5. 人物一致性：同一角色跨镜的性别/年龄/服装/发型是否一致，是否符合设计里的角色描述；
6. 物理与画面：肢体手指畸形、面部崩坏、物体形变穿模、与设定无关的画面内容；
7. 剪辑节奏：切换是否自然，有无大段无意义的静止或死寂，转场是否克制。
每个问题给出出现的时间点（秒）与证据描述；没有问题的项也要说明"核对通过"。`;

  const user = [
    { type: "video_url", video_url: { url: `data:video/mp4;base64,${fs.readFileSync(finalPath).toString("base64")}` } },
    { type: "text", text: `${requirements}\n\n【设计预期 JSON】\n${JSON.stringify(design, null, 1)}\n\n只输出 JSON: {"overall":"一句话总评","score":0,"problems":[{"aspect":"台词|字幕|声音|口型|人物|物理|剪辑","severity":"high|medium|low","at":"时间点/镜号","description":"…"}]}` },
  ];

  const res = await fetch("https://api.stepfun.com/step_plan/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "step-3.7-flash",
      messages: [{ role: "user", content: user }],
      max_tokens: 16000,
    }),
  });
  const body = await res.json();
  const msg = body.choices?.[0]?.message ?? {};
  let raw = msg.content || "";
  if (!raw && msg.reasoning) {
    // 推理模型可能把结论落在思考尾部：提取最后一个 JSON 对象
    const m = msg.reasoning.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];
  }
  if (!raw) raw = JSON.stringify(body).slice(0, 300);
  console.log(`\n===== ${r.id} =====`);
  try {
    const review = JSON.parse(raw);
    console.log(`总评(${review.score}): ${review.overall}`);
    for (const p of review.problems ?? []) console.log(`  [${p.severity}] ${p.aspect} @${p.at}: ${p.description}`);
    fs.writeFileSync(path.join(caseDir, "07-qa", "deep-review.json"), JSON.stringify(review, null, "\t"), "utf-8");
  } catch {
    console.log(raw.slice(0, 800));
  }
}
