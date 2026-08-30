# video-agent 端到端流程测试方案（七套完整产物）

> 目标：**真实跑通** 剧本 → 美术设计 → 关键帧 → 片段生成 → 音频 → 剪辑导出 → 质检 的完整链路，
> 七套用例各自从**设计脚本**到**中间产物**再到**最终视频**完整落盘，可回溯、可复跑、可对比。

## 0. 最新版功能清单（已确认，取自代码）

| 层 | 能力 | 关键实现 |
|----|------|---------|
| 前置 | 访谈澄清 10 固定题 + 5 定制题、共创模式、参考图上传 | `clarify/*.ts`、`/api/cocreate/*` |
| 管线 | 剧本 → 美术设计（含人物/道具/场景概念图）→ 分镜提示词 → 关键帧 → 片段 → 音频 → 导出 | `stages/*.ts` |
| 片段 | 图生视频（关键帧锚定）、i2v→t2v 降级、**台词 reference 模式**（TTS→托管→口型驱动） | `stages/clips.ts`、`dialogue-audio.ts`、`hosting/tcb.ts` |
| 音频 | 旁白 TTS（逐镜表演指导）、BGM 上传 + 闪避、音色选择 | `stages/audio.ts`、`/api/voices`、`/api/runs/:id/bgm` |
| 导出 | 归一化 → EDL 转场决策 → xfade 时间线 → SFX → 字幕烧录 → 响度 -14 LUFS | `stages/export.ts`、`ffmpeg.ts` |
| 闸门 | 设计闸门 A、关键帧闸门 B（**支持部分确认**）、A1 台词来源闸门、D1 多角色对白拆镜 | `pipeline.ts`、`audio-mode.ts` |
| 质检 | 五轴评分 + 逐镜三态裁决（三态多数决）、跨镜一致性预检、**设计图自审**、**关键帧自审**、派发后回归回灌（只报退步） | `qa/review.ts`、`consistency.ts`、`design-review.ts` |
| 重做 | 补拍（级联重绘关键帧）、旁白重录（可改文案）、重新导出（多画幅）、组合出片（限次）、设计图/关键帧单卡重绘、文本阶段微调 | `redo/*.ts` |
| 审议 | 节奏变体（变速）、导演 ReAct 归因（**跑在 pi 的 runAgentLoop 上**）、提案采纳 | `deliberation.ts` |
| 制片 | 配额账本（reserve/settle/release + RPM 令牌桶 + 每日秒数 + 幂等）、队列并发与 429 降速、kitchen 快照、只读观察建议、L2 守卫执行、导演优先级契约、预算告警、A/B 度量 | `quota.ts`、`producer.ts`、`guard.ts`、`kitchen.ts`、`metrics.ts` |
| 可观测 | traces.ndjson + OTLP、SSE + 轮询、成本追踪（CJK token 精估 + 图片 token + 币种守卫） | `pipeline.ts`、`pricing.ts`、`server.ts` |

## 1. 测试目标与判定

系统级验收（不是单元测试，单测已有 `video-agent-server/test/*.test.ts`）：

| 目标 | 判定方式 |
|------|---------|
| 全链路跑通 | `run.status === "done"` 且 7 阶段全 `done` |
| 成片真实产出 | `final.mp4` 落盘且 ≥ 50KB |
| 中间产物齐备 | 每镜关键帧 + 片段 + 音轨（按形态）+ 字幕 + 转场表 |
| 闸门可自动放行 | 设计闸门 / 关键帧闸门被挂起并被 resume 推进 |
| 音频形态全覆盖 | 台词驱动 / 旁白 / 纯 BGM |
| 重做与分发 | 补拍版本化、重录、组合出片、多画幅重导出 |
| 制片体系 | 观察可产出建议、建议可经守卫执行、度量可读 |
| 质检闭环 | 五轴分数 + 逐镜裁决 + 一致性 + 自审结论 |

## 2. 用例矩阵（七套）

| 用例 | 题材（写实） | 音频形态 | 参数 | 覆盖点 |
|------|------------|---------|------|-------|
| `C1-dialogue` | 雨夜公交站，父女对白《雨夜末班》 | **台词驱动** | 5 镜 16:9 720p | reference 出片、口型驱动、A1 来源闸门、D1 单说话人 |
| `C2-narration` | 渔港清晨，老渔妇出海《开海》 | 旁白 | 5 镜 16:9 720p | TTS 旁白、表演指导、字幕烧录 |
| `C3-bgm-only` | 城市空镜《空城六分钟》 | **纯 BGM 无旁白** | 6 镜 16:9 720p | BGM 上传、混音闪避、无旁白时间线 |
| `C4-smoke` | 面馆后厨，三镜讲完 | 旁白 | 3 镜 9:16 480p | 最低成本冒烟（**首次必跑**）、竖屏 |
| `C5-longfilm-review` | 公路人生《一千公里》 | 旁白 | **10 镜** 16:9 720p | 长片叙事、设计图自审、关键帧自审、配额压力 |
| `C6-redo-chain` | 理发店谢幕《最后一剪》 | 旁白 | 5 镜 16:9 720p | **补拍**（版本化 + 级联重绘）、**重录旁白**、**组合出片** |
| `C7-producer-multiformat` | 夜市收摊 | 旁白 + BGM | 5 镜 16:9 720p | **制片主任 observe/apply**、导演优先级、**9:16 竖屏重导出**、A/B 度量 |

写实风格两处钉死：① `brief` 明写"写实真人/纪录风"；② `negativePrompt` 显式排除
`anime / cartoon / 3d render / illustration / cgi plastic skin`。

## 3. 目录结构（主文件夹 = 批次，子文件夹 = 用例）

```
e2e/results/<时间戳>/
├── index.html / summary.md / summary.json / env.json
└── C1-dialogue-city-rain-dialogue/          ← 七个子文件夹同构
    ├── 00-input/     brief · options · coSpace · request · cost-estimate
    ├── 01-script/    script.json · voice-directions.json · prompts
    ├── 02-design/    visual-bible · design-bible · design-*.png · 闸门A快照
    ├── 03-keyframes/ keyframes.json · key-*.png · 参考板 · 闸门B快照
    ├── 04-clips/     clip-*.mp4（含 _v1 历史版本）
    ├── 05-audio/     tts-*.mp3（含历史版本）· bgm.*
    ├── 06-export/    final.mp4 · final-9x16.mp4 · cut{N}.mp4 · shot-*.mp4 · transitions.json · subs.ass
    ├── 07-qa/        consistency.json · verdict.json · run-state.json · traces
    ├── 08-assets/    assets 原始目录全量备份（兜底：未归类产物不丢）
    ├── logs/         events.jsonl · timings.json · gate-decisions.json · post-actions.json · api.log.json
    └── report.md     断言明细 + 阶段耗时 + 闸门决策 + 后动作结果
```

## 4. 运行

```bash
node e2e/selfcheck.mjs                 # 离线自检（不烧钱）：用例结构 + WAV + 断言正反例
node e2e/run-e2e.mjs --dry-run         # 打印入参与成本预估 + 生成目录骨架
node e2e/run-e2e.mjs --only=C4-smoke   # 先跑冒烟
node e2e/run-e2e.mjs                   # 全量七套（串行，视 RPM 需数小时）
node e2e/run-e2e.mjs --base=http://127.0.0.1:8790 --timeout=1800000
node e2e/run-e2e.mjs --batch=<既有目录名> --only=C7-producer-multiformat  # 中断后续跑（合并写回）
```

退出码：全 PASS = 0，有 FAIL = 1，服务不可达 = 2，预检不一致 = 3（目标无 `/api/health` = 旧代码服务，或 features 能力缺项）。

## 5. 脚本关键机制

- **预检（08-30 F1 升级）**：启动先打 `GET /api/health` 校验 features 能力清单——
  无 health 端点（旧代码服务）或能力缺项 → exit 3 并提示指向 8790。
  背景：C7 事故因旧预检对无 health 的服务降级放行，白烧约 13 分钟配额；
  详见根目录《问题与修复记录-2026-08-30》F1。
- **闸门自动处理**：设计闸门直接 resume（失败设计图写快照不阻断）；关键帧闸门只放行 `done 且无 staleRefs`
  的镜头，并作为 `confirmedShotIds` 传回（顺带验证"部分确认"路径）。
- **成片后动作序列**（`postActions`，按用例配置）：
  `designReview` / `keyframeReview`（出图自审）、`reshot`（自动挑质检最差镜 → 等完成）、
  `retts`（挑首个有旁白的镜）、`compose`（组合出片）、`reexport`（指定画幅，等完成）、
  `kitchenObserve` / `kitchenApply`（制片主任观察 → 经 L2 守卫执行）、`metrics`（A/B 度量）。
  每个动作容错并记录，被守卫/限次合法拒绝只留痕不判失败。
- **采集在动作之后**：版本化片段、`cut{N}.mp4`、`final-9x16.mp4` 才能一并归档。
- **增量落盘**：每完成一个用例立即按 id 合并写回 `summary.json`（进程被杀不丢已完成用例；
  `--batch` 复用目录续跑时旧结果保留、同名用例新结果覆盖）。
- **全程留痕**：事件流按 id 去重写 `events.jsonl`、阶段墙钟耗时、API 调用日志、后动作结果。
- **串行 + 超时**：单用例 25 分钟上限，用例间 3 秒缓冲（RPM/每日秒数限制，不并发）。

## 6. 断言清单（`lib/report.mjs`）

| # | 断言 | 失败含义 |
|---|------|---------|
| 1 | `status === done` | 管线中途失败 |
| 2 | 7 阶段全 done | 某阶段卡住/跳过 |
| 3 | 成片归档 + ≥50KB | 导出异常或空文件 |
| 4 | 镜头数 ≥ 期望 | 制作集被裁剪（可能触发预算告警） |
| 5 | 关键帧数 ≥ 片段数（**排除 _vN 历史版本**） | 关键帧缺失导致退回文生视频 |
| 6 | 旁白音轨存在（C2/C4/C5/C6/C7） | TTS 失败 |
| 7 | BGM 入时间线（C3/C7） | BGM 上传或混音失败 |
| 8 | 台词镜 > 0（C1） | 台词模式被降级（A1/D1 闸门，见事件日志） |
| 9 | 五轴质检有分 | QA 被跳过 |
| 10 | 设计图/关键帧自审有结论（C5） | 自审调用失败 |
| 11 | 补拍产生 `_v1` 历史版本（C6） | 版本化备份失效 |
| 12 | 组合出片产出 `cut{N}.mp4`（C6，无连字符） | compose 失败或超限次 |
| 13 | 竖屏分发版 `final-9x16.mp4`（C7） | 多画幅重导出失败 |
| 14 | 制片主任观察可用（C7） | producer observe 异常 |

## 7. 已知限制（如实记录）

- **C3「无旁白」靠 brief 约束，不是硬闸门**：LLM 仍可能生成旁白。脚本不判失败，只记录 TTS 条数
  （这本身是"brief 遵循能力"的观测点）。要硬约束应在 script 阶段加 `audioMode=silent` 的程序性闸门。
- **设计图失败不阻断**：单卡失败标记 failed 后继续（管线既定降级策略），快照落盘供人工复核。
- **审议循环（deliberations）未纳入本批次**：它需要人工对比 A/B 版本才有意义，自动化价值低；
  其底层 ReAct 能力已由 C7 的制片主任链路间接覆盖。
- **访谈/共创流程未纳入**：七套都直接进 `/api/generate`（C1 通过 `coSpace` 覆盖共创来源路径）。
- **结果目录建议加 `.gitignore`**：产物体积大。

## 8. 结果怎么用

- `index.html`：一眼看批次结论（用例 / 耗时 / 终态 / 质检分 / PASS-FAIL），可点进各用例 `report.md`。
- `07-qa/consistency.json` + `verdict.json`：画面质量是否达标。
- `logs/post-actions.json`：重做/自审/制片动作的原始回执（含被拒原因）。
- 跨批次对比：两个 `summary.json` 里同名用例的 `timings` 与 `metrics`（配额利用率/吞吐/P95/浪费率）拉出来比，可量化优化效果。
