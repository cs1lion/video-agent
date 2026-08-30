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
| 质检 | 六轴评分（含物理正确性）+ 逐镜三态裁决（三态多数决）、跨镜一致性预检、**设计图自审**、**关键帧自审**、派发后回归回灌（只报退步） | `qa/review.ts`、`consistency.ts`、`design-review.ts` |
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
| 音频形态全覆盖 | 台词驱动（全部用例）+ BGM（F3）+ 台词镜重录（F2） |
| 重做与分发 | 补拍版本化、重录、组合出片、多画幅重导出 |
| 制片体系 | 观察可产出建议、建议可经守卫执行、度量可读 |
| 质检闭环 | 六轴分数 + 逐镜裁决 + 物理/文字审核 + 一致性 + 自审结论 |

## 2. 用例矩阵（十套样片 · 2026-08-30 第五版 · 古今中外）

> **全部「台词驱动 + 剧情成片 + 写实真人」**，十个时代地域铺开；考核面：
> 台词链（跟读双关卡：包络 + ASR 字面重合）、配音选角（24 官方音色分龄分性池，
> 旁白与角色错开）、字幕烧录与结构审核、七轴质检（物理/人物/文字/字幕）。

| 用例 | 时代 · 地域 | 题材 | 音频形态 | 镜数 |
|------|------------|------|---------|------|
| `F1-modern-alley` | 现代 · 中国 | 深巷面馆，老板与女代驾 | 台词 | 3 |
| `F2-ancient-bianjing` | 北宋 · 汴京 | 汴河夜雨，书生与更夫 | 台词 | 5 |
| `F3-republic-ferry` | 1937 · 长江 | 三峡夜航，船员夫妻 | 台词+BGM | 5 |
| `F4-western-stagecoach` | 1885 · 美国西部 | 驿站黄昏，车夫与枪手 | 台词 | 4 |
| `F5-london-1941` | 1941 · 伦敦 | 防空洞婚礼，士兵与未婚妻 | 台词 | 5 |
| `F6-tang-lantern` | 盛唐 · 长安 | 上元灯市，扎灯少女/书吏/糖童 | 台词 | 5 |
| `F7-florence-fresco` | 1504 · 佛罗伦萨 | 学徒的壁画，老画师与学徒 | 台词 | 4 |
| `F8-edo-snow` | 江户 · 日本 | 雪夜面摊，老板娘与武士 | 台词 | 4 |
| `F9-paris-bookshop` | 1924 · 巴黎 | 左岸书店，店主与记者 | 台词 | 4 |
| `F10-beijing-tape` | 1985 · 北京 | 胡同磁带，青年/母亲/大爷 | 台词 | 5 |

写实风格两处钉死：① `brief` 明写"写实真人/剧情"；② `negativePrompt` 显式排除
`anime / cartoon / 3d render / illustration / cgi plastic skin / garbled text`。
角色描述钉死性别/年龄/发色/服装——人物一致性、配音选角、审核全依赖它。

## 3. 目录结构（主文件夹 = 批次，子文件夹 = 用例）

```
e2e/results/<时间戳>/
├── index.html / summary.md / summary.json / env.json
└── F1-smoke-subtitles-alley-noodle-smoke/      ← 三个子文件夹同构
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
node e2e/run-e2e.mjs --only=F1-smoke-subtitles   # 先跑冒烟
node e2e/run-e2e.mjs                   # 全量七套（串行，视 RPM 需数小时）
node e2e/run-e2e.mjs --base=http://127.0.0.1:8790 --timeout=1800000
node e2e/run-e2e.mjs --batch=<既有目录名> --only=F3-multiformat-bgm  # 中断后续跑（合并写回）
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
| 6 | TTS 音轨存在（台词/旁白，全部用例） | TTS 或台词托管失败 |
| 7 | BGM 入时间线（F3） | BGM 上传或混音失败 |
| 8 | 台词镜 > 0（全部用例） | 台词模式被降级（A1/D1 闸门，见事件日志） |
| 9 | 质检有分 | QA 被跳过 |
| 10 | **审核轴齐备**：`physicalAccuracy` + `characterConsistency` + `textQuality`（全部用例） | QA 升级未生效/被跳过 |
| 11 | **字幕结构审核通过**（`verdict.subtitles.issues` 为空，全部用例） | 字幕缺失/覆盖缺口/时间轴重叠/编码错乱 |
| 12 | 设计图/关键帧自审有结论（F2） | 自审调用失败 |
| 13 | 补拍产生 `_v1` 历史版本（F2） | 版本化备份失效 |
| 14 | 组合出片产出 `cut{N}.mp4`（F2，无连字符） | compose 失败或超限次 |
| 15 | 竖屏分发版 `final-9x16.mp4`（F3） | 多画幅重导出失败 |
| 16 | 制片主任观察可用（F3） | producer observe 异常 |

**四类缺陷审核**（服务端 `qa/review.ts` + `qa/subtitles.ts`）：
- **物理错误 / 人物不一致 / 文字乱码**：每镜抽**两帧**（中段 + 后段 85% 处）交视觉模型打
  七轴分；逐镜三态标注 reason 带「物理: / 人物: / 文字: / 字幕:」前缀。人物一致性重点
  比对同一角色跨镜的脸型/发型发色/服装/年龄段（多角色同框时不许串脸）。
- **字幕错误双层**：① 视觉层审渲染效果（乱码/错字/截断/遮挡，烧录字幕带不算画面文字问题）；
  ② **确定性结构层**（`auditSubtitles`）：解析 subs.ass 按列映射校验——字幕缺失/旁白覆盖缺口/
  时间轴重叠 >0.2s/停留过短/中文行无 CJK（编码错乱前兆）。起因：e2e 抽帧实锤 Dialogue 行
  5 字段 vs Format 10 字段导致**字幕从未渲染**（2026-08-30 已修）。

## 7. 已知限制（如实记录）

- **台词镜数量由脚本 LLM 按剧情决定**：brief 明确要求对白，但 D1 拆镜后具体几镜是台词、
  几镜是旁白/静音由脚本质量决定；断言只锁「台词镜 > 0」。全部台词镜被降级（托管失败等）
  会同时反映在 TTS 条数与事件日志里。
- **QA 审核（物理/文字）是视觉模型主观判断**：分数与逐镜标注用于质检与重做归因，
  e2e 只锁「审核轴齐备」；物理/文字 false negative（模型漏报）靠双帧采样缓解但不根除。
- **设计图失败不阻断**：单卡失败标记 failed 后继续（管线既定降级策略），快照落盘供人工复核。
- **审议循环（deliberations）未纳入本批次**：它需要人工对比 A/B 版本才有意义，自动化价值低；
  其底层 ReAct 能力已由 C7 的制片主任链路间接覆盖。
- **访谈/共创流程未纳入**：七套都直接进 `/api/generate`（每套带 `coSpace` 覆盖共创来源路径）。
- **结果目录建议加 `.gitignore`**：产物体积大。

## 8. 结果怎么用

- `index.html`：一眼看批次结论（用例 / 耗时 / 终态 / 质检分 / PASS-FAIL），可点进各用例 `report.md`。
- `07-qa/consistency.json` + `verdict.json`：画面质量是否达标。
- `logs/post-actions.json`：重做/自审/制片动作的原始回执（含被拒原因）。
- 跨批次对比：两个 `summary.json` 里同名用例的 `timings` 与 `metrics`（配额利用率/吞吐/P95/浪费率）拉出来比，可量化优化效果。
