# video-agent 项目评审报告

> 评审范围：`pi/packages/video-agent{,-server,-ui}`（约 1.8 万行），以最近 26 个提交的新设计（审议闸门、成本追踪、关键帧部分确认、lastActions、SSE、组合出片）为重点。
> 评审立场：有品位、懂技术的工程师视角——先说结论，再给证据。

---

## 一、总评

**这是一个产品判断力明显高于平均水准、工程实现处于「快速迭代晚期」状态的项目。**

最大的亮点不是某个功能，而是**决策质量**：什么时候停（确认闸门）、什么时候闭嘴（QA 回归才播报）、什么时候不做多 Agent（架构文档里的证据表）、什么时候花钱（部分确认 + 预估）。这些判断在 AI 应用项目里非常稀缺。

最大的短板是**抽象速度落后于迭代速度**：pipeline.ts 长到 4066 行、UI Modal 三胞胎 80% 重复、SSE 实时层缺一道序列号防线。都是能修的结构债，不是方向性错误。

| 维度 | 评分（10） | 一句话 |
|------|-----------|--------|
| 架构决策 | 8.5 | 「单真 Agent + 确定性 DAG」判断正确且有文档自证 |
| 流程/功能设计 | 8.0 | 闸门、护栏、降级路径构成完整的「防失控体系」 |
| 代码结构 | 6.0 | 巨型文件 + 模板复制，抽象欠账 |
| 正确性 | 6.5 | 竞态、死契约、计费误差若干；核心路径有回滚保护 |
| 工程规范 | 6.5 | 有 trace、有测试、有原子写；无 lint、类型断言零散 |
| 文档诚实度 | 9.0 | director-agent.md 是全项目最有价值的资产之一 |

---

## 二、设计水平：值得肯定的地方

### 2.1 架构叙事的诚实（少见的高分项）

`director-agent.md` 明确写下：「团队频道是叙事设计，不是技术声明」「对外宣传不应使用多 Agent 措辞」，并附真伪多 Agent 场景对照表和「不做的事」清单（7 项，每项给了理由）。**知道自己在做什么、不做什么，并且写下来**——这比大多数「All-in Multi-Agent」的项目清醒一个量级。StepFun Builder 申请材料直接引用这份文档的思路即可。

### 2.2 收敛护栏体系（明显是踩过坑后的产物）

- 每镜重做 `MAX_RESHOT_PER_SHOT=3` / `MAX_RETTS_PER_SHOT=3` / 单图重绘 `MAX_IMAGE_REDRAW=3` / 组合出片 `MAX_COMPOSE_PER_RUN=2` / 审议 `MAX_DELIB_PER_RUN=3`、每轮看帧预算 4 次、LLM 轮次上限。
- 注释里自证历史教训：「防不收敛循环：历史 T6 8 轮 55 视频的教训」。护栏不是摆设，是伤疤。

### 2.3 成本透明（产品品味）

- Pre-flight 预估（启动时算一次）+ 部分关键帧确认（「未勾选的 K 镜不消耗额度」明示）+ 提案结构化成本（服务端按 action 推导金额，不信 LLM 文案）。
- 把「确认」从仪式变成了知情决策。

### 2.4 降级策略成体系

图生视频失败→退文生视频；带参考图失败→纯提示词重试；xfade 合成失败→concat 硬拼；QA 失败→保守 warn 不拖垮成片；BGM 缺失→静默跳过。**每条昂贵路径都有便宜的备胎。**

### 2.5 版本备份 + 失败回滚

所有重做路径（reshot/retts/重绘）都是「先备份旧主文件 → 生成 → 失败回滚」，且注释里记录了为什么必须这个顺序（先生成后备份会把新图误挪进版本库）。重做前后 QA 快照对比、只播报退步（防报警疲劳）——这两处细节有打磨痕迹。

---

## 三、Bug 清单（按严重度）

### P0（建议尽快修）

**B1. SSE 快照与轮询写入竞态，UI 状态可回退**（UI）
`store.ts:77-124`：SSE `onRun` 直接 `set({run})`，90ms 后又调度 `refresh()`，2s watchdog 也调 `refresh()`——三个写入源无任何序号/时间戳比较。一条慢的轮询响应可以覆盖更新鲜的 SSE 快照。`refresh()` 也无 in-flight 去重。
**修法**：`refresh()` 加序号守卫：`const seq = ++reqSeq; ... await ...; if (seq !== reqSeq || get().runId !== runId) return;` 一并解决 B2。

**B2. 切换 run 时迟到的旧响应污染新视图**（UI）
`store.ts:115-117`：`refresh()` 开头取 `runId`，`await` 后不校验。从 `/studio/A` 切到 B 时 A 的在途响应会写进 B 的页面。

**B3. QA 视觉调用计费用了字面量**（后端）
`pipeline.ts:3955`：`trackLlmCost(run, ctx, "qa-visual", JSON.stringify(vision))` —— prompt 长度按 **9 个字符** 计，多模态输入的帧成本≈0。同病：`generateDoc` 里视觉调用的 images 不计成本。成本追踪对视觉调用系统性低估。

**B4. DeliberationPanel 采纳非原子，失败重试重复烧钱**（UI）
`DeliberationPanel.tsx:199-220`：`createPaceVariant`/`reshot` 成功后 `markAdopted` 失败会进 catch 且 `adopted` 未置位——用户再点「采纳」会对同一提案重复执行（重复生成媒体、重复扣次数）。
**修法**：执行成功即置位 `adopted`（乐观），`markAdopted` 失败降级 console.warn。

### P1（功能正确性/契约）

**B5. 闸门 3 去重条件含无效重构残留**（后端）
`deliberation.ts:630-632`：`a.kind === action || a.kind === action.replace("retts", "retts") || a.kind === action` —— `replace` 是 no-op，三个条件两个相同。现在碰巧能用（kind 与 action 同名），但这是明显的半成品重构，任何人改 kind 命名就静默失效。

**B6. `variantUrlOf` 是发进 JSON 的函数**（后端）
`server.ts:720`：`res.json({ variants, presets, variantUrlOf: (file) => ... })` —— 函数经 `JSON.stringify` 后静默消失。死契约 + 误导性代码。

**B7. lastActions 双向死契约**
- 后端：`RunView.lastActions` 有数据有注释（pipeline.ts:225-233），声称「UI 拿这个显示刚才做了什么」。
- 前端：`client.ts:150` 有类型声明，但**全 UI 无任何组件消费**（StudioPage 的 pill 只读 events）。
- 后果：架构文档 5.1 节设计的「审议 agent 避免重复提议」靠 system prompt 注入生效了，但「对话分类时直接确认已完成」这条验收项（文档 §10.4）实际未闭环。

**B8. refine 剧本后关键帧静默复用旧图**（后端）
`pipeline.ts:1335-1359`：refineRun("script"/"visual") 后重跑 keyframes 阶段，`ensureKeyframe` 对 `status==="done" && file` 的镜直接返回旧帧（1538 行）——**画面原料已变，帧还是旧的**。虽有 confirmedShotIds 重置让用户重新确认兜底，但事件文案说「分镜锁定 ✅ 全部就绪」，用户很难意识到帧是过期的。修法：refine 下游触发时按 `prompts.promptVersion`/脚本 hash 判断帧是否过期，过期标 staleRefs 走现有级联机制。

**B9. consistency.ts MIME 声明与载荷不符**
`consistency.ts:96`：帧已用 ffmpeg 压成 JPEG，dataUrl 却声明 `data:image/png`。多数网关能容错，但这是把正确性押在供应商宽容上。

**B10. 会话 Map 无清理**（后端）
`server.ts:92`：`sessions = new Map<string, Clarifier>()` 只增不减，cookie Max-Age 86400 但服务端不驱逐。长跑进程内存泄漏。

**B11. 审议退避重试不可中止**
`deliberation.ts:336`：`sleep(20_000 * (attempt + 1))` 未传 signal——用户取消审议最多要在退避里干等 60s。

### P2（小问题，攒着一起修）

| # | 位置 | 问题 |
|---|------|------|
| B12 | `pipeline.ts:3196` | retts 有音色时事件文案出现双句号「。。」（三元拼接逻辑画蛇添足） |
| B13 | `pipeline.ts:699` | 注释「verdict中 指定镜头」中英夹杂笔误 |
| B14 | `pipeline.ts:713` | `computeQaDeltas` 生产代码零调用（只有测试用），与 `computeQaRegressionText` 90% 重复 |
| B15 | `deliberation.ts:13` | 头注释写 `DELB_MAX_TURNS=8`，实际 12 —— 文档漂移 |
| B16 | `pipeline.ts:541` vs `596` | 内存 events 上限 500、落盘 400，重启后事件「变少」 |
| B17 | `pipeline.ts:3722` | directorChat 对运行中 run 回复「等这轮结束我就安排」——实际无排队机制，承诺不会兑现 |
| B18 | `client.ts:444/462` | `ConsistencyIssue/Doc` 类型重复声明两份，靠接口合并侥幸不报错 |
| B19 | UI store | watchdog 检测到 SSE 停流后 `transport` 仍是 "live"，LIVE pill 说谎 |
| B20 | `pricing.ts:212` | `CHARS_PER_TOKEN=4` 一刀切——中文文本成本被低估约 4 倍，与文件头注释的约定（中文 1.5 字符/token）不一致 |
| B21 | `pricing.ts` | `trackLlmCost/trackMediaCost` 忽略 `entry.currency` 直接累加进 CNY 口径的 spent——目录混币种时总数无意义（当前全 CNY，属潜伏 bug） |
| B22 | `stageScript` 二次生成后不再校验镜头数 | LLM 两次都给错数量就静默接受 |

---

## 四、不优雅之处与改进方案

### 4.1 pipeline.ts 巨石化（4066 行）

现状：RunStore、事件流、trace、7 个阶段、5 类重做、组合出片、导演对话、QA 全在一个文件。找任何东西都要滚屏。

**拆分方案**（按依赖方向，无环）：
```
run-store.ts      RunStore / RunRecord / persistRun / runView
events.ts         TeamEvent / pushEvent / 角色表
trace.ts          appendSpan / OTLP 桩
cost.ts           trackLlmCost / trackMediaCost / pushLastAction
stages/
  script.ts visual.ts prompts.ts keyframes.ts clips.ts audio.ts export.ts
redo/
  reshot.ts retts.ts reexport.ts compose.ts redraw.ts   ← 共享 backup+rollback 工具
director/
  chat.ts (planDirectorReply)  deliberation.ts
pipeline.ts       仅剩 executeStages 编排 + 闸门（~300 行）
```
最大的直接收益：**重做路径的「备份→生成→回滚」三段式在 reshot/retts/两处重绘里复制了 4 遍**，抽成 `withVersionedAsset(run, mainPath, versions, generate)` 高阶函数后，B12 类的文案小错和未来的回滚漏洞都会少一个量级。

### 4.2 状态管理：单例 store 的模板九胞胎

`store.ts:159-237`：reshot/retts/designAdjust/keyframeAdjust/compose 等 9 个 action 是同一段 15 行模板的复制。抽 `guarded(apiFn)` 高阶函数后 store 能缩到 120 行以内。同时 `StudioPage` 的 `useStudio()` 无 selector，每条 SSE 快照触发 635 行整页重渲染——改 `useShallow` 按字段订阅。

### 4.3 Modal 三胞胎与可访问性欠账

Reshot/Retts/Refine 三个 Modal 结构 80% 同构（遮罩+spring+kicker+textarea+hint chips+限次护栏+按钮），且都：不支持 Escape 关闭、无焦点陷阱、组件常驻挂载即请求（RettsModal 挂载就 `fetchVoices`）。抽 `ModalShell` + `useResetOnChange(target)`。

### 4.4 事件流是「日志」不是「通知」

`pushEvent` 每次触发 `persistRun`（全量 state JSON 重写，含 400 条历史事件）。一个 run 生命周期写几百次 run-state.json。事件系统独立成 append-only `events.ndjson`（反正 traces.ndjson 已经是这个模式），run-state 只在状态跃迁时写。同时 UI 端错误只有单槽横幅，chatBusy 中断、refresh 失败、操作失败互相覆盖——按严重度分级（toast / banner / inline）。

### 4.5 计费系统：口径要先立规矩

三处口径不一致：注释说中文 1.5 字符/token，代码用 4；视觉调用图片不计价；混币种直接相加。建议：
1. `trackLlmCost` 增加 `images?: number` 参数，按 catalog 的 per-image 或 token 折算；
2. 累加前 `assert entry.currency === run.metrics.cost.currency`（不一致记 warn 并换算或丢弃）；
3. 把换算约定写进 pricing.ts 头注释并删掉旧说法。

### 4.6 阶段切换丢状态（UX 断裂）

`StudioPage.tsx:476-483`：`AnimatePresence mode="wait"` + `key={stage}` 每次切换卸载重建。Review 的一致性预检进度、Export 的逐镜勾选都会丢。审阅者在 Review/Export 之间来回对照是核心工作流，这里最不该丢状态。改法：stage 面板保活（`display:none` 或状态提升到 store），动画只留给首屏。

### 4.7 面向演示的诚实度

- 成本 pill「已花」恒 0（后端其实已接 `metrics.cost.spent`，怀疑是旧 run 数据 / UI 注释未更新，建议核实后要么展示真实值要么隐藏该半边）。
- Team 频道的角色叙事 OK（文档已声明），但 directorChat 的「等这轮结束我就安排」是唯一一处系统会食言的地方——要么做 pending 队列（本轮结束自动派发），要么改话术「本轮结束后请再发一次」。

---

## 五、给 Builder Program 申请 / 面试叙事的建议

1. **最有说服力的三件事**（直接对应代码可查证）：
   - 4 道闸门 + 收敛护栏 + 成本透明的「防失控体系」——说明你理解 AI 产品的核心风险是失控烧钱和不收敛循环，且有 T6 8 轮 55 视频的实战教训；
   - 「单真 Agent」的架构论证——说明你不会为了叙事堆 Agent 数，能用证据表反驳自己；
   - 降级链路——i2v→t2v、xfade→concat、参考图→纯提示词，每条昂贵路径有备胎。
2. **演示脚本建议**：故意断网/换错 key 展示降级，比展示happy path 更能体现工程成熟度。
3. 修复 B1-B4 后再录演示视频（SSE 竞态在演示中可能出现画面回跳，最伤观感）。

---

## 六、修复优先级路线图

| 优先级 | 内容 | 预估 |
|--------|------|------|
| 本周 | B1/B2 序号守卫（~20 行）、B4 乐观置位（5 行）、B5 清理残留条件（3 行） | 半天 |
| 本周 | B3 视觉计费 + B20/B21 计费口径统一 | 半天 |
| 下周 | B7 lastActions UI 消费闭环、B6 删 variantUrlOf、B10 会话驱逐 | 1 天 |
| 迭代内 | 4.1 pipeline 拆分（先抽 redo 公共层）、4.2 store 模板收敛、4.3 ModalShell | 2-3 天 |
| 有余力 | 4.4 事件流 ndjson 化、4.6 stage 保活、B8 关键帧过期级联 | 各半天-1 天 |
