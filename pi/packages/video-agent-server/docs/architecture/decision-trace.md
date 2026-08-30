# 决策轨迹层与 RLHF 数据管线 · 设计文档

> **状态：调研完成，待批准实施**（2026-08-30）。尚未动任何代码。
>
> **来源**：仓库根目录 `video-agent_意图澄清与RLHF轨迹框架设计.html`（外部设计稿）
> + 对本仓库三包的源码实测核查。外部稿件的文件/行号引用已逐一复核，
> **与本文冲突处以本文为准**（实测修正见第二节）。

## 1. 为什么做

RLHF 需要的三元组是 `(state, action, reward)`。现状盘点：

| 要素 | 现状 | 缺口 |
|---|---|---|
| state | brief / intent / stage / QA 分都在 | 没有按决策点做快照 |
| action | `TraceSpan` 只记"调了什么"（pipeline.ts:721 `appendSpan`） | **不记"在哪些候选里选了哪个、为什么"** |
| reward | QA 5 轴分、采纳/未采纳、重做前后快照 | 散落，未结构化串联 |

补上**决策轨迹（Decision Trace, L2）**这一层，整条链路即通：审议模块天然产出
"提案 + 采纳"，候选集一旦被记录，采纳/未采纳直接构成偏好对，无需人工标注。

## 2. 实测修正（对外部设计稿的勘误，实施前必读）

外部设计稿总体方向正确，但 8 处与代码实际不符：

| # | 外部稿声称 | 实测 | 设计影响 |
|---|---|---|---|
| 1 | "无偏好数据结构" | **`PreferenceRecord` 已存在**（deliberation.ts:148），落盘 `preferences.jsonl`，`get_preferences` 工具已在线上消费；记录的是 A/B 成片级偏好（base/challenger/neither） | **扩展现有文件，绝不新建并行偏好文件** |
| 2 | 审议天然产出 3–5 提案 | prompt 写死"**最多 2 个**动作"（deliberation.ts:706） | 不改 prompt 就没有 rejected 侧；见 §5.4 |
| 3 | 调度决策点在"调度器 submit" | `GenerationQueue.submit` 在 `coding-agent/examples/extensions/studio/media/queue.ts`；kitchen.ts 是只读快照层 | 真正的选池决策点是 **`pickPool()`（quota.ts，确定性无 LLM）**，埋它 |
| 4 | 重做成败"需新增配对逻辑" | `snapshotShotVerdict` → `computeQaRegressionText` 已存在（pipeline.ts:789–835；reshot.ts:113/:352），只推事件未落盘 | 信号 C 只需把现有 before/after 快照写进记录 |
| 5 | QA 轴列举 4 个 | 实为 **5 轴**（多 `textQuality`，pipeline.ts:113） | state 快照字段对齐 |
| 6 | events 上限 20 | 事件上限 400（:642）；`lastActions` 才是 20（:772） | 无实质影响 |
| 7 | 澄清跳过"无显式处理" | 已有 `skip()`/`skipCurrent()`（clarifier.ts:174/:184），只是信号未被利用 | 只需"消费"，不需"新建" |
| 8 | 行号漂移 | 如 `planDirectorReply` 实际在 pipeline.ts:1932 | 实施按实际行号 |

另两个关键事实：**无 episode 概念**（一期 `episodeId = runId`，一 run 一目录）；
**免费期真实瓶颈是 RPM（2 RPM/key）而非配额秒数**——误判一次重做浪费的是一个
30 秒提交窗口，歧义反问的价值论证因此更强。

## 3. 数据设计：三层轨迹

```
Run 目录（.pi-studio/video-agent-runs/{ts}-{slug}-{id}/）
├─ traces.ndjson        L1 执行轨迹（已有，不动）
├─ decisions.ndjson     L2 决策轨迹（新增）
├─ preferences.jsonl    L3 偏好事件（扩展现有文件，加 kind 判别）
└─ episode.json         Episode 汇总（新增，run 完成时写）
```

### 3.1 DecisionSpan（新增核心）

```ts
interface DecisionSpan {
  decisionId: string; episodeId: string; runId: string; at: string;
  schemaVersion: 1;                    // 第一天就带，应对 prompt/模型漂移
  modelVersion?: string;
  kind: "intent" | "clarify" | "director" | "redo" | "schedule" | "qa-gate";
  stage: StageId | "chat";
  state: {
    briefLogline: string;
    intent: Intent;
    stageStatus: Record<string, string>;
    qaScore?: number;
    qaAxes?: Partial<Record<AxisId, number>>;      // 实际 5 轴
    quotaContext?: { poolId: string; rpmAvailable: number };  // RPM 是真瓶颈
    shotId?: string;
  };
  candidates: DecisionCandidate[];     // 不能省：这就是偏好对的 rejected 侧
  chosenId: string;
  rationale?: string;
  confidence?: number;
  spanIds: string[];                   // 关联 L1
}
interface DecisionCandidate {
  id: string; label: string; payload: unknown;
  estimatedCostSec?: number;
}
```

### 3.2 PreferenceRecord 扩展（判别联合，向后兼容）

旧行无 `kind` 字段 → 视为 `"cut-ab"`；`get_preferences` 工具无需立即改。

```ts
type PreferenceRecordV2 =
  | (PreferenceRecord & { kind?: "cut-ab" })           // 已有：A/B 成片选择
  | { kind: "proposal-adoption"; at: string; runId: string; roundId: string;
      decisionId: string; chosen: string; rejected: string[]; tags: string[] }
  | { kind: "clarify-override"; episodeId: string; intentKey: IntentKey | string;
      answeredId: AnswerId;
      overriddenBy: { trigger: "director-chat" | "refine" | "reshot";
                      at: string; rawText: string; effectiveValue?: string } };
```

### 3.3 episode.json

run 完成时汇总：brief / finalIntent / intentHistory / outcome
（qaVerdict、delivered、totalRedoCount、quotaUsedSec、decisionCount）。

## 4. 埋点（四个，纯旁路、静默失败，仿 appendSpan）

| 埋点 | 位置 | 记录什么 |
|---|---|---|
| 导演意图决策 | `planDirectorReply`（pipeline.ts:1932） | 用户消息 → intent/shotId/instruction + confidence + 歧义反问 |
| 审议提案决策 | `markAdopted`（deliberation.ts:890） | proposals 候选集 + adopted → `proposal-adoption` 偏好对 |
| 澄清选题 | `clarifier.next()/answer()`（video-agent 包） | 当前题选项集 = 候选集；`skipped` 也落 |
| 调度选池 | `pickPool()`（quota.ts） | 候选 = 各池 + 各自 `rpmWaitMs`；chosen = 选中池 |

`appendDecision()` 与 `appendSpan` 并置于 pipeline.ts（符合"横切不外提"既定妥协；
将来若拆 `trace.ts` 随之迁移）。写失败静默——决策记录不得阻断产线。

## 5. 增强设计（按优先级）

### 5.1 意图置信度 + 歧义反问（DirectorPlan 扩展）

```ts
interface DirectorPlan {
  intent: DirectorIntent; shotId?: string; instruction?: string; reply: string;
  confidence?: number;                 // 0..1，缺省视为高（向后兼容）
  ambiguity?: { missingSlot: "shotId" | "aspect" | "instruction" | "intent";
                clarifyingQuestion: string };
}
```

行为规则：`confidence < 0.6` 或关键槽位缺失 → 返回反问而非派发。
保持 1-shot，不违反"directorChat 不升 ReAct"的既定决策；反问是"多一次确认"，
误伤代价低，漏问代价是一次视频生成 + 30s RPM 窗口。

### 5.2 意图变更历史（加法字段）

`intentHistory: IntentChange[]`（video-agent 包 `EnrichedBrief`）：
`{at, key, from?, to, trigger: "interview" | "director-chat" | "script-edit" | "refine"}`。
`intentFromLog`（directives.ts:106）覆盖写之前留痕。用途：回放看演化 +
"后续被改 = 前期澄清没问准"的检测基础。

### 5.3 澄清失效检测（最强负信号，启发式，不加 LLM）

触发源现成：`refineRun`（pipeline.ts:1684）指令、reshot instruction、导演对话原文。
一期用关键词规则比对既有 intent（"太慢/拖→pacing"、"色调→colorPalette"…）
+ `intentHistory` 前后 diff，产出 `clarify-override` 事件。
**宁缺毋滥**：规则匹配不上只落 `rawText` 留人工复核——这直接是未来负样本标签。

### 5.4 提案候选集修复（前置条件，便宜且必做）

`DIRECTOR_SYSTEM_PROMPT`（deliberation.ts:706）"最多 2 个动作" →
"**产出 2–4 个差异化方案，至少一个低成本方案**"。保留成本优先哲学，
恢复 rejected 侧供给；闸门 2（low confidence 二次确认）对多提案照常生效。
提案只是文本输出，不增加生成成本。

### 5.5 信息增益澄清（后置，改动用户可见行为）

静态 `impact` 权重 × 当前 `uncertainty` 排序选题，低于阈值停问。
先人工标注权重，积累数百 episode 后再用"答案与 QA 分相关性"校准。
不一上来就学——数据不足会学歪。

## 6. 回放与报表

- `buildTimeline(run)`：三路 ndjson 按 `at` 归并 → 统一 `TimelineItem`。
- 新增只读路由：`GET /api/runs/:id/decisions`、`GET /api/runs/:id/timeline`
  （与现有 `GET /api/runs/:id/traces` 并列，加法）。
- UI：StudioPage 新增"决策时间线"只读标签页（新组件，不动既有组件契约）。
- 离线报表 `scripts/analyze-decisions.ts`：澄清推翻率按维度、提案采纳分布、
  意图误判率。**不训练就有收益**（改题库文案与 director prompt）。
- **确定性重放不做承诺**：视频/图像模型无 seed 承诺，只承诺"输入可完整重建"，
  回放用于定位问题而非逐帧复现。

## 7. 五阶段实施计划

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
| **① 数据结构 + 2 埋点** | `DecisionSpan`/扩展写入器；`appendDecision`；埋 `planDirectorReply` + `markAdopted` | 1–2 天 | 新测试含变异验证；`tsc` clean；243+ 套件全过；手工跑一次制作见 `decisions.ndjson` 条目 |
| **② 候选集 + 置信度** | §5.4 提案 prompt；审议埋全候选集；DirectorPlan 置信度 + 反问规则；澄清选题与 `pickPool` 埋点 | 2–3 天 | 审议一轮 ≥2 提案且落盘；模糊消息（"感觉不太行"）触发反问而非派发；闸门行为不变 |
| **③ 只读回放** | `buildTimeline` + 两条路由 + StudioPage 时间线标签页 | 3–5 天 | 浏览器手测完整链路（意图→澄清→决策→执行→反馈）；旧契约路由响应不变 |
| **④ 历史 + 推翻检测 + 报表** | `intentHistory`；`clarify-override` 启发式；报表脚本 | 2–3 天 | 构造"选 fast → 嫌拖"场景产出 1 条 `clarify-override`；报表对真实 run 可运行 |
| **⑤ 导出与训练（不排期）** | 去重/脱敏/`rewardDelta<3` 丢弃/按 episode 时间切分的导出脚本；门槛达标才上 RM / DPO | — | 门槛：≥50 episode 报表优化；≥300 带分样本训 RM；≥1000 偏好对上 DPO。**不达标停在前一阶段** |

每阶段独立可验收、可单独放弃（只做 ①②④ 也有完整收益）；
每阶段完成同步写 dev-log。

## 8. 风险与护栏

| 风险 | 应对 |
|---|---|
| 提案放开后审议变啰嗦 | 上限 4 + 低成本方案必在；提案只是文本，成本不变 |
| 置信度自报不准 | 缺省高置信（兼容）；反问非禁止执行，误伤代价低 |
| 推翻检测误报污染负样本 | 规则宁缺毋滥；`rawText` 留存，人工复核后才可进训练集 |
| 数据量不足 | 阶段 ④ 收益不依赖数据量；门槛严格执行，绝不跳步 |
| 分布漂移 | `schemaVersion`/`modelVersion` 第一天就带，训练按版本过滤 |
| 隐私/密钥 | 导出管线内置脱敏；导出物不进代码仓库（项目有密钥入 git 前车之鉴） |
| 过度工程 | 做到 ④ 已回本；⑤ 是期权不是承诺 |

## 9. 与项目约束的关系（合规核对）

- **JSON 契约零修改**：RunRecord/RunView/TeamEvent 只加不改；新文件、新字段、新路由全部加法。
- **"不做"清单**：不引入多 agent、不自动派发、directorChat 保持 1-shot、不读视频模型——本设计均不触碰。
- **降级优于阻断**：埋点静默失败，沿用 `appendSpan` 模式。
- **测试约定**：`npx tsc --noEmit` + tsx --test，新代码配变异验证。
- **pipeline 拆分**：新函数并置 `appendSpan` 旁，随未来 `trace.ts` 迁移。

## 10. 场景与影响摘要

**场景**：翻车排查（SH03 三次重做越做越差 → 时间线定位误判环节）；
误判止损（反问替代白烧视频生成）；题库体检（推翻率报表，当周见效）；
交付可解释性（给客户看"这版是怎么来的"）；调度策略验证（多 key 刚上线，
`pickPool` 实际数据验证线性叠加）；成本治理（episode 级浪费统计）。

**影响**：短期零风险基建（run 升级为可审计数据公民）；中期报表驱动的免费优化
（一次过片率提升 = 免费期 RPM 窗口不被浪费，收益立即可感）；长期数据资产
（RM/DPO 唯一可行供给路径）+ 可解释轨迹作为产品信任资产。
