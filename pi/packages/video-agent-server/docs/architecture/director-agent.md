# Director Agent 架构文档

> **一句话总结**：视频广告管线里**只有一个真 Agent**（导演），它有两种运行模式（1-shot 对话 / ReAct 审议）。其它角色（编剧、美术指导、审片员等）都是**单次 LLM 调用 + 角色 prompt**，不是真 Agent。

## 1. 为何不是多 Agent

视频广告短片（5-30 秒）生产是**机械流水线 + 决策辅助**，不是**多方对抗 / 协作谈判**。

| 真实多 Agent 场景 | 是否存在 | 证据 |
|------------------|----------|------|
| 多方对抗 / 辩论 | ❌ 不存在 | 30 秒广告没有"美术 vs 节奏"之类的真实分歧，用户说了算 |
| 角色间协商 / 妥协 | ❌ 不存在 | 阶段之间只传递产物 JSON（`script.json` / `visual-bible.json` / `keyframes.json`），LLM 不通信 |
| 专业分工 + 接力 | ⚠️ 表面像 | 但实际是**确定性 DAG**，不需 agent 自主调度 |
| 信息收集 + 决策（agent 内） | ✅ 存在 | 审议环节确实需要 |

结论：**审议 ReAct 循环是真 Agent，但不需要第二个、第三个**。

## 2. 现状三个"决策面"

| 名字 | 入口（UI） | 实现位置 | 角色 | 触发 | Agent? |
|------|----------|---------|------|------|--------|
| **审议** (`runDeliberation`) | StudioPage `DirectorChat` 的"团队频道"标签 + DeliberationPanel | `deliberation.ts` | **导演** | A/B 对比 + tags + note | ✅ ReAct 循环 |
| **对话** (`directorChat`) | StudioPage `DirectorChat` 的"导演对话"标签 | `pipeline.ts` | **导演** | 自由文本 | ❌ 1-shot LLM |
| **审片** (`runQa`) | export 阶段自动 | `pipeline.ts` | **审片员** | export 收尾 | ❌ 1-shot LLM |

**导演 agent** 用 2 个入口（审议/对话）；**审片员** 1 个入口（自动跑）。

## 3. DirectorAgent 统一抽象

两个入口共享同一组只读工具 + 同一份"运行事实"上下文，仅运行模式不同：

```
 ┌─────────────────────────────────────────────┐
           DirectorAgent
 ├── tools (只读，可共用)
 │    ├── get_run_state        (阶段进度 / 闸门)
 │    ├── get_qa_scores        (5 轴 + 逐镜裁决)
 │    ├── get_consistency      (跨镜一致性报告)
 │    ├── get_candidates       (CutVariant 清单：主片 + compose 产物)
 │    ├── get_preferences      (历史审议采纳记录 + preferences.jsonl)
 │    ├── view_shot_frames     (镜头关键帧 + QA 抽检帧；每轮预算 4 次)
 │    ├── get_cut_comparison   (A/B 差异：时长 / 速度 / 素材)
 │    └── propose              (终结工具：rootCause + findings + proposals)
 └── action dispatch
      ├── reshotRun(shotId, instruction)
      ├── rettsRun(shotId, instruction, voice?)
      └── reexportRun(aspectRatio?)
```

**模式 1：对话（1-shot）**
- system prompt: 简短导演回复风格
- maxTurns = 1
- 用途：用户快速指令 "重拍 SH03"，不需深度调研
- 分类命中后**直接派发** `reshotRun / rettsRun / reexportRun`

**模式 2：审议（ReAct 循环）**
- system prompt: 详细归因协议（引用证据、归因层优先级、成本诚实）
- maxTurns = 12，看帧预算 = 4 帧/轮
- 用途：用户做 A/B 对比后，agent 收集证据 + 提结构化提案
- 当前**不直接派发**，需用户手动"采纳"

## 4. 协调缺口（要收紧）

### 4.1 重复执行风险

```
用户路径 A（对话）：打字"重拍 SH03"→ 1-shot → reshotRun()
用户路径 B（审议）：A/B 后 agent propose "reshot SH03" → 用户采纳 → reshotRun()

两条路动作相同，run.metrics.shotAttempts[shotId] 会累加两次。
审议不知道对话已执行过什么；对话也不知道审议最近提了什么。
```

### 4.2 提议未自动派发

审议的 `propose` 工具只产出 `DeliberationProposal[]`，**不派发执行**。用户必须手动点"采纳"。意味着：
- 1-3 分钟的 ReAct 循环 + 30 秒人工采纳 + 几分钟 reshot 执行
- 期间用户离开就漏了
- 工具调用 +人工采纳 =两次确认，体验冗余

### 4.3 对话没引用审议结论

对话 1-shot 不知道刚才审议提了什么。用户问 "那个提议怎么样了" 完全答不上。

## 5. 收紧方案（落地清单）

### 5.1 共享"最近动作"记忆

`RunRecord` 新增字段：

```ts
/** 导演 agent 最近派发的执行类动作（reshot/retts/reexport），按时间倒序 */
lastActions: Array<{
  kind: "reshot" | "retts" | "reexport" | "compose";
  shotId?: string;
  label: string;
  at: string;
}>;
```

- 写入：执行函数完成时 push（带 30 秒内去重）
- 读取：对话与审议的 system prompt 都注入"最近 5 条动作"
- 用途：审议发现 `lastActions[0].shotId === propose.target` 时不再提议；对话分类时直接确认已完成

### 5.2 审议自动派发（可选）

`propose` 工具新增可选参数 `autoDispatch: boolean`：
- 用户在 DeliberationPanel 勾选"自动执行采纳的提案"
- `propose` 返回后，director agent 主动调 `dispatch_action` 工具
- 默认 false，保持当前 UX（手动采纳）

### 5.3 对话复用审议工具

`directorChat` 从 1-shot 升级为**轻量 ReAct**（maxTurns = 3）：
- 复用 `get_recent_proposals`（审议最后未采纳的提案）
- 复用 `get_run_state`（当前阶段 / 闸门）
- 分类命中"已存在的未执行提案"时**直接派发**，不再读 LLM 重新分类

## 6. UI 叙事的诚实声明

**Team Channel 的角色名是叙事设计，不是技术声明。**

| UI 显示 | 实际后端 |
|---------|---------|
| "美术指导 → 技术导演：handoff" | `stagePrompts` 完成后 push `TeamEvent{from:"art", to:"tech", kind:"handoff"}` |
| "审片员：通过 ✅" | `runQa` 完成后 push `TeamEvent{from:"reviewer", kind:"qa"}` |
| "导演：补拍 SH03" | `directorChat` / `runDeliberation` 派发后 push `TeamEvent{from:"director"}` |

后端是**确定性流水线 + 1 个真 agent**，UI 把阶段包装成"团队"是为了让用户感觉"系统在做事"。这是设计选择，**不是多 Agent 协作**。

**对外文档 / 宣传材料不应使用"多 Agent"措辞**。

## 7. 不做的事

为防止范围爆炸，下面这些**不在本次沉淀范围**：

| 想法 | 为何不做 |
|------|---------|
| 加"美术指导 agent"参与审议 | 角色 agent 没有额外证据视角，token 浪费 |
| 加"剪辑师 agent"和"导演 agent"辩论 | 30 秒广告没有真实风格冲突 |
| 让多 agent 共享黑板（多视角备忘录） | 现有 JSON 产物 + 工具已经够 |
| 自动派发每次采纳 | 人工确认是 UX 现状，自动派发是可选 opt-in |
| 实时 Agent 思维可视化（Devin 式） | 视觉改进单，独立优化项 |

## 8. 文件地图

```
packages/video-agent-server/
├── src/
│   ├── pipeline.ts
│   │   ├── planDirectorReply()    ← 对话 1-shot 实现
│   │   ├── directorChat()         ← 对话 HTTP 包装
│   │   └── runQa()                ← 审片员 1-shot
│   ├── deliberation.ts
│   │   ├── runDeliberation()      ← 审议循环入口
│   │   └── buildTools()           ← 5 个只读工具 + propose
│   ├── pricing.ts                  ← 成本/P2
│   └── consistency.ts              ← 跨镜一致性 / 审校
└── docs/architecture/
    ├── director-agent.md           ← 本文件
    └── pipeline.md                 ← (规划中)
```

## 9. 迁移路径

```ts
// 当前：deliberation.ts 内部工具完全封装在 buildTools
// 目标：抽出到 shared-tools.ts，两个入口共用

// pipeline.ts / directorChat
- const text = await chat(ctx.llm, [...]);
+ const reply = await directorAgent.runOnce({ run, ctx, history, message: text });

// deliberation.ts / runDeliberation
- const { tools, getProposal } = buildTools(run, base, rival, ctx.priceCatalog);
+ const { tools, getProposal } = directorAgent.buildTools({ run, base, rival, ctx });
```

抽离后两个入口：
- 共享工具实现
- 共享 system prompt 注入
- 共享 lastActions 上下文
- 仅运行模式（maxTurns / 循环 vs 一次性）不同

---

## 10. 验收

沉淀完成时，应该能验证：

1. `pipeline.ts` 与 `deliberation.ts` 之间**没有重复的工具定义**
2. `RunRecord.lastActions` 在 reshot / retts / reeexport 后都有记录
3. 审议的 system prompt 包含"最近动作"，对话 1-shot 也包含
4. 测试覆盖：对话 + 审议两条路**不会重复执行**同一 reshot
5. 文档外部表述（README / 宣传）不再用"多 Agent"措辞