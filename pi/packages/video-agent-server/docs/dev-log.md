# video-agent-server 修改设计日志

> **面向 agent 与人类共同阅读的"修改思路日志"**。和 commit message 不同：commit 记"做了什么"，这里记"**为什么这么做 / 当时考虑了哪些替代方案 / 哪些是临时妥协**"。
>
> 跨 session 续写：任何 agent 接续本项目时，先读本文档 → 理解当前方向 → 再决定新动作。

## 最近会话

### 2026-08-27 收尾轮

**主线 commit**（按时间倒序）：
- `356b54e` refactor(pipeline): extract withVersionedAsset (4 copies → 1 helper)
- `daca622` fix(keyframes): auto-redraw cap + apiKey env hint + opts bug
- `34a5ec2` feat(keyframes): design review matrix + keyframe self-audit + reference-board redraw

**已就位的"P0/P1/P2 闸门 + 自动回灌"体系**（不动）：
- 闸门 1 质量底线：QA ok 镜头禁止 reshot/retts
- 闸门 2 置信度门槛：low 提案需要二次确认
- 闸门 3 lastActions 去重：3 分钟内同类刚做禁止重复
- 闸门 4 派发后回灌：只在退步或裁决变化时推（防报警疲劳）
- 跨镜一致性自动预检（出片时）
- 关键帧/设计稿出图自审（autoReviewKeyframes/autoReviewDesign）

**架构判断**（写进 director-agent.md 的共识）：
- **不是多 agent**：单一 Director agent + 5 个只读工具。Team Channel 是 UI 叙事。
- **自动派发暂缓**：`propose.autoDispatch` 加了字段但未启用。当前 4 道闸门都做"派发前防护"，未做"派发后回灌"以外的自动化执行。
- **UI 暴露节制**：上次"撤 pill + 降级回灌"是踩了"报警疲劳"的反思。

**显式的"不做"清单**（更新中）：
- 多 agent 协作 / 辩论 — 没真实分歧，不做
- 自动派发采纳的提案 — 风险收益不对等
- directorChat 升级为 ReAct — HTTP 延迟模型变重，回报小
- 读视频模型（video_url）— vendor 兼容性未验证

## 进行中

### pipeline.ts 拆分（Task 3 续）

**现状**（拆分前）：
- `pipeline.ts` ~4400 行，单文件含：types / RunStore / events / trace / stages(7) / redo(4-5) / QA / helpers
- 文件过大导致：跨 session 接手慢、git diff 噪声大、单元测试难以隔离

**目标结构**（review §4.1 + 我们增量）：
```
src/
  pipeline.ts        仅保留：types / RunStore / persistRun / runView / executeStages
                     + pushEvent / appendSpan / snapshotShotVerdict / computeQaDeltas 等横切 helper
                     目标：<500 行
  pricing.ts         ✅ 已独立（trackLlmCost/trackMediaCost）
  consistency.ts     跨镜一致性预检（已独立）
  design-review.ts   ✅ 已独立（reviewKeyframes/reviewDesignBible）
  llm.ts             ✅ 文本 LLM 客户端（已独立）
  ffmpeg.ts          ✅ 视频/音频处理（已独立）
  prompts.ts         ✅ 提示词模板（已独立）
  stages/
    script.ts        stageScript: 剧本生成 + 重试镜头数校验
    visual.ts        stageVisual: 美术设计 + 实体推导 + 出图 + 自审
    prompts.ts (stages/)  stagePrompts: 分镜提示词生成
                          注意：不要和 src/prompts.ts（提示词模板）混淆
    keyframes.ts     stageKeyframes: 出图 + 重绘 + 出图自审
    clips.ts         stageClips: 图生视频（含 i2v→t2v 退降）
    audio.ts         stageAudio: 旁白合成
    export.ts        stageExport: 视频合成 + 一致性预检 + QA + 旁白回灌
  redo/
    job.ts           RedoJob 高阶类：state machine（init→backup→generate→commit/rollback）
                     替代表中散落的 let backedUp / versions / 手动 rename
    entity.ts        redesignEntityInner（单卡重绘）
    keyframe.ts      redesignKeyframeInner（关键帧重绘）
    reshot.ts        reshotRun（视频重做 + 关键帧级联重绘）
    retts.ts         rettsRun（旁白重录）
    reexport.ts      reexportRun（重新合成 + 多画幅）
    compose.ts       composeCut（组合出片）
  qa/
    review.ts        runQa（5 轴 + 逐镜裁决 + audioSync 确定性）
  events.ts         TeamEvent 类型 + pushEvent 横切
  trace.ts          appendSpan + OTLP 桩
  utils/
    version-asset.ts  ✅ withVersionedAsset 已抽（不要挪走，外部 import 友好）
```

**阶段拆分的边界原则**：
1. **types 留在 pipeline.ts**（RunRecord / RunView / RunStage 等核心 schema 不动）
2. **stageXxx 函数签名稳定**：`async function stageXxx(sc, ...): Promise<T>` 模式保留，executeStages 调用点零改动
3. **stage 内部依赖**通过 `StageCtx` 参数注入（run / ctx / queue / signal），不引入新全局
4. **redo 文件夹的 RedoJob** 是关键统一抽象：当前 4 处 withVersionedAsset 调用 + 各自的 progress event / 状态写入 → 收敛到 RedoJob 类

**redo/RedoJob 状态机设计**（核心抽象）：
```ts
type RedoState = "idle" | "backed-up" | "generating" | "committed" | "rolled-back";

class RedoJob<TConfig> {
  private state: RedoState = "idle";
  private backupPath?: string;
  
  constructor(
    private ctx: { run: RunRecord; queue: GenerationQueue; signal: AbortSignal },
    private config: TConfig,
  ) {}
  
  /** 备份 → generate → commit 三步。如果 generate 失败，自动 rollback */
  async execute(opts: { 
    mainPath: string;
    backupPath: string; 
    versions: string[];  // mutable
    generate: () => Promise<string | null>;  // 写主路径 + 返主名
  }): Promise<{ file: string | null }> {
    // (withVersionedAsset 的逻辑升级)
    this.state = "backed-up";
    // ...
  }
}
```

**妥协 / 暂不做的**：
- **不拆 trace.ts / events.ts**：pushEvent/appendSpan 是横切，挪出来反而要给所有 stage 注入更多参数
- **不抽 BaseStage 超类**：各 stage 形态差异大（6 vs 7 阶段、6 阶段的 prompt 也不同），抽象收益低
- **不做测试文件搬迁**：test 目录平铺成本可控，留 `pipeline.test.ts` 主测，按需按文件加 `*.test.ts`

**迁移顺序**（控制 diff 体积）：
1. `pricing.ts` 已独立 ✅
2. `stages/` 拆分：先建空壳（重导出），把同名函数一个个迁过去
3. `redo/` 拆分：先抽 RedoJob 类（4 处 withVersionedAsset 全部走它），再拆文件
4. `qa/` 拆分
5. pipeline.ts 收尾到 <500 行

## 设计原则（写在这里而不是 commit message）

1. **闸门优先于派发** — 派发前 4 道闸门比"派发后回灌"重要 10 倍
2. **失败降级而不是阻断** — 每个高成本路径都有便宜的备胎（i2v→t2v、参考图→纯提示词、xfade→concat）
3. **JSON 契约零修改** — RunView / TeamEvent / EventLink 等是前端硬契约，重命名算 breaking change
4. **空状态必须有产物** — `null !== undefined`，不存在的资源用 `null` 表达
5. **agent 自己承担原子性** — director agent 在 propose 工具里 settle 收口，pipeline 不必等它"承诺"
6. **Cost 估算不阻塞** — fallback 默认价格永远可用，缺 catalog 不影响业务

## 当前瓶颈

- `pipeline.ts` 4400+ 行（待拆）
- `llm.ts` 缺视觉调用 token 折算（review B3，待修）
- `DeliberationPanel` 采纳非原子（review B4，待修）
- `redesignEntityInner` 也吃手动配额（auto path 待加 autoAttempts）
- 会话 Map 无清理（review B10，待修）
