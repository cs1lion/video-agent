---
name: pi-video-agent
version: 0.3.0
description: "pi-video-agent —— 一句话到成片的 AI 制片管线：访谈澄清、六阶段生成（剧本/美术设计/分镜提示词/片段/配音/导出）、美术设计与关键帧双人工确认闸门、审议优化循环、跨镜一致性预检、组合出片与多画幅分发。当用户想用自然语言生成广告片或短片、对比成片候选、对成片提出修改意见时使用本 skill。前置条件：本地服务已启动（API :8790，PORT 可覆盖）。"
metadata:
  emoji: "🎬"
  homepage: "https://pi.dev"
---

# pi-video-agent

驱动本地 pi-video-agent 制片管线：从一句话需求到成片交付，含人工审议闭环。

## 基础约定

- **Base URL**: `http://localhost:8790`（启动：`PORT=8790 npx tsx src/server.ts`，工作目录 `pi/packages/video-agent-server`）
- 所有请求/响应均为 JSON。错误统一 `{"error": "…"}`，非 2xx 即失败。
- **轮询约定**：run 运行中每 2-3s 轮询一次 `GET /runs/:id`，直到 `status` 进入 `awaiting | done | failed | cancelled`。`status=awaiting` 表示到达确认闸门，必须先把内容交给用户过目，经用户确认（或修改再确认）并调 `/resume` 后才能继续。
- **预算护栏**（服务端强制，勿绕过）：每镜重做 ≤3、审议 ≤3 轮/run、候选 ≤4、组合出片 ≤2 次。

## 核心工作流

### 1. 快速制片（跳过访谈）

```
POST /api/generate
{"brief": {"logline": "25 秒的气泡水广告，突出夏日傍晚天台的清爽感",
           "keyMessage": "品牌名 FIZZ"},
 "options": {"shotCount": 5, "clipDurationSec": 4.5, "aspectRatio": "9:16"},
 "imageIds": []}
→ {"runId": "run-xxx"}
```

随后只轮询 `GET /api/runs/:id`。`stages` 数组含六阶段进度；`verdict` 为 QA 五轴裁决；`videoUrl` 就绪即成片可播（`GET /api/runs/:id/video`，下载 `/download`）。

### 1.5 确认闸门（强制人工闭环，未确认不烧视频额度）

美术设计素材对全片起决定性作用——人物形象与主要场景描述是后续关键帧和视频生成的唯一基准，因此流程中设两道停机确认：

1. **gate=design（美术设计确认）**：风格/色板 + 人物·道具·场景概念图完成后 `status=awaiting, run.gate="design"`。把设计图交给用户：可直接确认走 `POST /api/runs/:id/resume`；有意见则先 `POST /api/runs/:id/design/adjust {"entityId","instruction"}` 单卡重绘（≤3 次），改完再让用户确认后才 resume。此时管线停在关键帧之前，不会消耗视频额度。
2. **gate=keyframes（关键帧确认）**：分镜提示词与全部首帧关键帧完成后 `status=awaiting, run.gate="keyframes"`。逐镜首帧交用户审阅：单镜重绘走 `POST /api/runs/:id/keyframes/adjust {"shotId","instruction"}`（≤3 次）；用户确认后才 resume 进入片段生成。

一致性传导实现说明：关键帧与单卡重绘默认把对应**美术设计定稿图**作为参考图（`params.image`）随提示词提交——设计图不再是纯文本描述的间接约束；供应商不支持该字段时自动降级为纯提示词并记录事件。

任何在 awaiting 状态下直接触发生成的行为都被禁止；refine 重跑视觉或提示词阶段会自动重新挂上对应闸门。

### 2. 访谈制片（质量更高）

```
POST /api/clarify/start {"brief": {...}}          （Set-Cookie 会话，后续带 cookie）
POST /api/clarify/next                              → 当前题（10 固定 + 5 定制）
POST /api/clarify/answer {"answerId": "..."}        → 下一题
POST /api/clarify/skip                              → 跳过全部
```
答完后再调 `/api/generate`（同一 cookie 会话，访谈结论自动并入 brief）。

### 3. 中途修改（管线运行中或完成后）

| 动作 | 端点 |
|---|---|
| 与导演对话（自动识别 reshot/retts/reexport 意图） | `POST /api/runs/:id/chat {"text": "把 SH03 重拍，镜头推近产品"}` |
| 微调某文本阶段 | `POST /api/runs/:id/refine {"stageId": "script", "instruction": "…"}`（配 `/resume` 推进下游） |
| 镜头重做 / 旁白重录 | `POST /api/runs/:id/reshot` / `retts` `{"shotId": "SH03", "instruction": "…"}` |
| 跨镜一致性预检 | `POST /api/runs/:id/consistency`（同步 15-40s，返回逐镜外观与不一致清单） |

### 4. 审议优化（成片完成后）

```
GET  /api/runs/:id/cutvariants        → 候选清单（首次自动登记主成片）
POST /api/runs/:id/cutvariants        → L1 节奏变体 {"baseId", "speed": 1.18}
POST /api/runs/:id/deliberations
{"baseId": "cv-x", "challengerId": "cv-y"?,   ← 可空 = 单版诊断
 "verdict": "base"|"challenger"|"neither",
 "tags": ["节奏","画面","旁白","整体感觉"], "note": "…"}
→ 同步 1-3 分钟，返回导演归因 {"doc": {rootCause, findings[], proposals[]}}
```
proposals 的 action：`reedit`（可带 speed，采纳即生成新候选）/ `reshot` / `retts`（带 shotId，采纳走对应端点）/ `rescript`（需人工在剧本阶段微调后重跑）。采纳后回写：
`POST /api/runs/:id/deliberations/:roundId/adopt {"action", "target"}`。

### 5. 交付

```
GET  /api/runs/:id/video                成片播放
GET  /api/runs/:id/download             成片下载
POST /api/runs/:id/reexport {"aspectRatio": "9:16"}   多画幅分发版
GET  /api/runs/:id/traces               运行追踪 spans
```

## 决策分级（对齐 human-in-the-loop 边界）

- **自动执行**：查询类（runs/artifacts/versions/traces/consistency 读）、候选清单刷新
- **需用户确认**：一切生成/重做/审议发起（花模型额度或视频额度）；rescript 级别必须二次确认
- **禁止**：绕过护栏上限的重复调用；管线 running 期间发起新动作（会 400）

## 错误处理

- `400`：参数缺失/护栏到顶（错误信息会说明哪一个上限）→ 如实转告用户
- `404`：runId 不存在 → 服务可能重启过，run 列表无查询端点，请用户提供 runId
- LLM/媒体上游 429/5xx：服务端已自动退避重试，仍失败则稍后重试该端点
