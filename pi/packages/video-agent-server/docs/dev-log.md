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

### 2026-08-28 Task 3 提取战役（stages/redo/qa 抽取完成）

**主线 commit**（按时间倒序，Task 3 拆分）：
- `586f232` chore(pipeline): export ensureKeyframe + reposition ensureVoiceDirections
- `77fb6cf` refactor: extract stageAudio → stages/audio.ts
- `bbc7349` refactor: extract stageKeyframes → stages/keyframes.ts
- `73ecab7` refactor: extract stageVisual+visual-derive → stages/
- `66b854c` refactor: extract stageScript → stages/script.ts
- `ae22e27` refactor: extract stagePrompts → stages/prompts.ts
- `09c66a9` refactor: extract composeCut → redo/reexport→compose
- `c3a6f4a` refactor: extract reexportRun → redo/reexport.ts
- `3540bbf` refactor: extract rettsRun → redo/retts.ts
- `28e88af` chore: use .ts extension
- `c26bb0e` refactor: extract reshotRun → redo/reshot.ts
- `ece322d` refactor: extract redo-adapters + fileDataUrl → asset-version
- `bf48d47` refactor: extract withVersionedAsset → asset-version.ts

**本会话新增**（未提交 WIP，待与 UI 那批分开提交）：
- `stages/clips.ts` 抽出 stageClips —— 解决了此前卡住的「mock 模块解析」回退。
- `qa/review.ts` 抽出 runQa（5 轴 + 逐镜裁决 + audioSync 确定性）。
- `redo/entity.ts` 抽出 redesignEntityInner（单卡重绘；导出 propagateEntityUpdate 供其调用）。
- `redo/keyframe.ts` 抽出 redesignKeyframeInner（单镜重绘；导出 buildReferenceSheet/promptSigOf 供其调用）。
- `stages/export.ts` 抽出 stageExport（合成 + EDL 转场 + 一致性预检 + QA + 旁白回灌）—— 最复杂的一个。
公共包装 redesignEntity/redrawKeyframe/redesignKeyframe/autoReviewKeyframes/executeStages 仍在 pipeline.ts，靠 ESM 提升调用导入的 inner。

**stageClips mock 解析根因（已解）**：原怀疑 node:test 的 mock.module 对 stages/ 子目录路径解析有问题。实际根因不是 mock URL——llm/ffmpeg/queue/asset-version/pricing 无论从 pipeline.ts 还是 stages/clips.ts import，都解析到同一个 src/*.ts 绝对 URL，mock 拦截照常生效。真正要管的是循环依赖 pipeline↔stages/clips：被 import 的横切 helper（pushEvent/appendSpan/setStage/optionsOf/readArtifact/readKeyframes/ensureKeyframe/throwIfAborted）全是 `export function`（ESM 实例化阶段即提升绑定），且 stageClips 只在运行时函数体内访问它们（模块求值早已完成），故循环安全。.ts 扩展沿用 audio.ts 模板。结论：照搬已落地 stage 的 import 风格即可，无特例。

**RedoJob 订正**：dev-log 原把 RedoJob 状态机列为「关键统一抽象」，实际未建。redo 公共层以更轻的 `withVersionedAsset` helper（asset-version.ts，90 行）落地——4 处 backup→generate→rollback 去重在函数级已达成。显式状态机（idle→backed-up→generating→committed→rolled-back）的记账未做，暂无需求；文档与代码偏差已对齐，下方目标结构里 `redo/job.ts` 标注为「已用 withVersionedAsset 替代，暂不建状态机」。

**Task 3 命名收尾：全部完成** ✅（stages/clips + qa/review + redo/entity + redo/keyframe + stages/export 全部抽出）。

**验证**：`npx tsc --noEmit` clean；`tsx --test --experimental-test-module-mocks test/*.test.ts` → **44/44 pass**（gate 状态机 7/7，含走 stageClips 的 P3、走 redesignEntity/redrawKeyframe 的「设计图重绘级联」用例；stageExport 无行为测试——gate 预标 export done 跳过——但 typecheck + pipeline 正确加载该 import 已确认）。注：pricing.test.ts 两个 describe 的 after-hook 偶现 `ENOTEMPTY/EBUSY rmdir` 清理竞态（子测试本身全过、`# fail 0`），属既有 flaky，与本次拆分无关，未动。

**未达成的 <500 目标（不在本次范围）**：pipeline.ts 现 2084 行，离 <500 仍远。剩余大块：stageVisual（仍内联于 899，与「已迁」commit 状态不符，待查）、ensureKeyframe、generateImage、generateDoc、director chat/refine/resume 编排、normalize* helpers、gate 函数。这些属 dev-log §4.1 的 run-store.ts/events.ts/trace.ts/cost.ts/director/ 拆分，是独立后续工作。

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

- `pipeline.ts` 2084 行（Task 3 stages/redo/qa 全抽出后；离 <500 仍差 ~4×。剩余 stageVisual/ensureKeyframe/generateImage/director 编排等属独立后续工作，见上）
- `redo/entity.ts` redesignEntityInner 仍吃手动配额（auto path 待加 autoAttempts）

## 2026-08-28 评审修复轮（P0/P1 全清，44/44 pass + tsc clean）

依据 `.workbuddy/review-video-agent-2026-08-28.md`（第二轮评审），全部实测验证后修复：

1. **P0 reshot TDZ（`redo/reshot.ts`）**：withVersionedAsset 的 generate 闭包用了词法上更晚声明的
   `width/height/kfDataUrl`（TS2448 对闭包内引用不报错，运行时 ReferenceError）——补拍功能自
   commit `c26bb0e` 起百分百崩溃。修法：关键帧重绘块整体上移到视频生成的 withVersionedAsset 之前，
   顺带删除 175-178 行的半成品注释。
2. **P0 withVersionedAsset 异常不回滚（`asset-version.ts`）**：此前只在 generate 返回 null 时回滚，
   抛异常时主文件已 rename 进版本库无人还原（主名悬空 = 丢用户素材）。修法：rollback 提取，
   try/catch 覆盖异常路径后重新上抛。这是独立于 1 的加固——generate 网络失败/队列异常同样受益。
3. **P0 计费 ctx 类型（`pricing.ts` + `design-review.ts`）**：trackLlmCost/trackMediaCost 收窄为
   `CostContext = { llm, priceCatalog }`（此前要完整 ServerContext，consistency.ts 传窄化对象编译报错）；
   reviewDesignBible/reviewKeyframes 签名同步放宽为 CostContext（调用方全传 ServerContext，结构兼容零改动）。
4. **P1 审议采纳误置位（`DeliberationPanel.tsx`）**：store 的 runAction 失败返回 false 不 throw，
   旧代码 `await reshot()` 后无条件 setAdopted → 失败也标记"已采纳"永久置灰。修法：检查返回值，
   失败就地 setAdoptError 且不置位。
5. **P1 闸门 1 fail-open（`deliberation.ts` propose）**：`verdict.shots?.find()` 找不到就放行——
   QA 降级（无 shots）和 LLM 幻觉 shotId 两种情况护栏静默失效，与"闸门优先于派发"原则冲突。
   修法：读 script.json 建合法镜头集合，未知 shotId / 缺 shotId 一律拒绝（未知即拒绝而非放行）。
6. **P1 降级抽帧偏移（`stages/export.ts`）**：xfade 降级 concat 后时间轴 = ΣshotDur（无重叠），
   旧 shotStart 按重叠递减累计 → QA 抽帧系统性偏早、可能抽到前一镜。修法：degraded 时按无重叠重算。
7. **P2 顺手项**：RunView 补声明 `gate` 字段（运行时一直返回、interface 漏声明，测试与前端类型绕行）；
   审议 system prompt 的"最近动作"注入按 LAST_ACTION_DEDUP_MS 过滤（此前文案说 3 分钟、实际取最近 8 条不过滤时间）。

**教训（对应 Task 3 抽取战役）**：P0-1 能活三个提交，是因为抽取重构无行为测试护航——
"44/44 pass"覆盖的是闸门状态机与计费，恰好绕开所有被搬动的代码路径。
**后续必做**：给 reshot/retts/reexport 补行为测试（至少覆盖"generate 抛异常后主文件还原"与
"顺序：重绘关键帧 → 取 kfDataUrl → 生成视频"）。另：`npm test` 多文件并发仍会挂死（mock 冲突），
分文件跑全部通过（3+7+34）；CI/本地一律分文件或 `--test-concurrency=1`。

## 2026-08-28 续：npm test 挂死根因修复 + 重做抽象行为测试

**`npm test` 挂死根因（已修，三轮 50/50 稳定复现）**：不是模块 mock 并发冲突，而是
pricing.test.ts 六个 describe 的 `after` 裸 `fs.rm(root, {recursive, force})` 无 catch——
Windows 上子测试句柄未立即释放时 rm 抛 EBUSY/ENOTEMPTY，after 钩子抛错拖住整个测试进程。
此前"分文件跑就正常"的假象来自执行顺序：显式列表 pricing 在最后（竞态无受害者），
glob 字母序 pricing 在 gate 前（gate 被拖下水，表现为"多文件挂死"）。
修法：6 处 after 统一 `.catch(() => {})`（gate 原有 maxRetries 版保留，run-store 同步补齐）；
test 脚本加 `--test-concurrency=1`。残留临时目录交给 OS temp 清理，稳定性优先。

**新增 `test/asset-version.test.ts`（6 用例）**：锁死 withVersionedAsset 三条不变量——
成功入版本库 / 返回 null 回滚 / **抛异常回滚后重新上抛**（本轮 P0 加固的回归锁）/ 首生成不备份 /
并发时只 pop 自己的项 / 备份被并发方顶出末尾时保守不动。注意：用例必须各自独立临时目录，
共享主文件会让回滚断言互相污染（首轮 3 失败的教训）。

**遗留收敛**：重做路径行为测试已完成公共抽象层；reshot/retts 端到端集成测试（mock 队列）
仍值得做但优先级降一档。一致性预检缓存指纹未做。

## 2026-08-28 续：四项优化落地（一致性指纹缓存 / 事件流 ndjson / 最近动作面板 / UI selector 化）

评审遗留的四项优化全部落地。共同根因是同一个架构惯性：**run 状态至今是「一个会整体重写的大 JSON」，
而没走 trace 已经在用的「追加式 ndjson + 增量推送」路径**。

### ④ 一致性预检指纹缓存（`consistency.ts`）

`checkConsistency` 是 15-40s 的多模态 LLM 调用，此前 `export.ts:343` **每次 export 无条件重跑**——
基础成片 + 两次补拍重导 = 跑 3 次、近 2 分钟、3 倍 token，而关键帧没变时结果本该一样。

- `ConsistencyDoc` 增 `fingerprint?: string`；`framesFingerprint()` 在 ffmpeg 压缩**之前**算
  （命中连 640px JPEG 压缩的开销都省掉），指纹 = 关键帧路径 + size + mtime 的 hash。
- 命中直接返回缓存的 `consistency.json`；旧文件无 `fingerprint` 字段 → 自然判不命中 → 重跑一次后开始生效
  （**无需迁移脚本**）。

### ③ 事件流 ndjson 化 + SSE 增量推送

- **写**：`pushEvent` 不再触发 `persistRun`（不再为每条聊天消息重新序列化整个 RunView），
  改为 `appendEventLine` 追加 `events.ndjson` 一行（O(1)，不碰旧数据）；
  单文件 > 512KB 时压实为最近 EVENT_CAP 条，防长期追加无限增长。
- **读/迁移**：`readEventsNdjson` 只读最近 400 条，**单行损坏只丢那一行**（append 中途崩溃不拖垮恢复）；
  文件缺失返回 null → 回落到旧 `run-state.json` 的 `events` 字段，历史 run 自动迁移、无需手动脚本。
- **推**：SSE 增 `event: ev` 通道（`subscribeRunEvents`），与状态级 `event: run` 并存。

> ⚠️ **易踩的坑**：`pushEvent` 改走 `ev` 通道后**不再触发 `event: run`**。前端若不接 `ev`，
> 团队消息将完全不显示（只在下一次阶段变更的快照里才补上）。这是正确性必需，不是可选优化。
> 前端接线：`client.ts` 的 `streamRun` 增 `ev` 监听；`store.ts` 的 `bind` 增 `onEvent`，
> 按 id 去重后单条并入 `run.events`（快照迟早会带同一条，去重避免重复渲染）。

新增 `test/event-ndjson.test.ts`（5 用例）锁死：append-only N 行有序 / 往返一致（id 可对上，
前端去重依赖）/ 半行损坏+缺字段只丢那一行 / 文件缺失返回 null / 超 400 保留最近 400。

### ① 最近动作面板（架构文档 §10.4 验收项）

`run.lastActions` 后端一直在写（`pushLastAction`，unshift 最新在前、上限 20）、也落了盘，
但前端**只在 `api/client.ts` 声明了类型、从未渲染**——用户完全看不到「系统最近替我做了什么」。

在指挥台（`DirectorChat`）加第三个标签「最近动作」：四类动作（补拍 / 重录旁白 / 重新导出 / 混剪合成）
配独立图标与配色，每行显示镜头号 + 做了什么 + 时间；空态有引导文案；动作是只读账本，
该标签下隐藏输入框、滚动停在顶部（最新在前）。

### ② UI selector 化

此前全包 `useShallow` / selector **一个都没有**，4 处 `useStudio()` 整页订阅 —— SSE 每次推快照都整页重渲染。

- 稳定动作函数（compose / reshot / retts）→ 直接 `useStudio((s) => s.x)`；
- 多字段（DeliberationPanel 的审议三字段、StudioPage 的 19 个字段）→ `useShallow` 浅比较，
  StudioPage 明确**不订阅** `deliberating`/`lastDeliberation`，审议子状态变化不再带整页重渲染。
- zustand v5 已移除 `useStore(selector, equalityFn)` 第二参数，`useShallow` 必须从 `zustand/react/shallow` 导入。

**遗留**：StudioPage 仍需 `run.events`（要传给指挥台），故每条团队事件仍会触发整页重渲染。
彻底解耦需要让 `DirectorChat` 自行订阅 store 而非接 props，属后续重构项。

### 验证

| 项 | 结果 |
|---|---|
| server `tsc --noEmit` | clean |
| UI `tsc --noEmit` | clean |
| `npm test` | **55/55**（原 50 + event-ndjson 5） |

## 2026-08-28 收尾：事件流彻底解耦 + 三块回归测试补齐

### 修正：② 的 useShallow 其实没真正解决整页重渲染

上一轮给 StudioPage 加了 `useShallow`，但**问题没解决**：`onEvent` 里写的是
`set({ run: {...cur, events: [...]} })`——**每次事件都换掉 `run` 的对象引用**，
于是任何订阅 `s.run` 的组件（含整页）照样重渲染，useShallow 拦不住（它浅比较的是
返回对象的字段值，`run` 是引用，值一变就重渲染）。

**正解**：把 events 从 `run` 里**拆成独立的 store 字段**，跟后端 ndjson 同构——
事件是独立的追加流，不是状态快照的一部分。
- `StudioState` 增 `events: TeamEvent[]`；`onEvent` **只更新 events、绝不重建 run 对象**；
- 快照通道（onRun / refresh）用 `mergeEvents(snapshot, local)` 校正：快照定顺序，
  本地多出来的（增量已到、这份快照还没带上的）补末尾，按 id 去重；
- `DirectorChat` 改为**自行订阅 store**（events / run.lastActions / chatBusy / sendChat），
  StudioPage 不再透传 `run.events`（全项目仅此一处消费）。

净效果：新团队事件只重渲染指挥台，StudioPage 的 `run` 引用不动、整页不参与。

### 三块回归测试补齐（55 → 64 用例）

1. **`test/consistency-cache.test.ts`（6 用例）** —— 锁死指纹缓存的两类静默故障：
   永不失效（看过期结论）/ 永不命中（优化白做）。覆盖：帧未动指纹稳定、
   内容变化失效、**仅 mtime 变化也要失效**（重绘同尺寸图不能吃旧缓存）、新增帧失效、
   getConsistency 往返与容错。
   不端到端测 checkConsistency：它内部要调 ffmpeg 压 640px JPEG，依赖真实二进制；
   而缓存命中/失效**只由指纹决定**，测指纹即覆盖同样风险面。

2. **`test/reshot-redo.test.ts`（3 用例）** —— 2026-08-28 那个 P0 的**唯一可靠护栏**。

### 关键发现：闭包型 TDZ，TS 和 Biome 都拦不住（已实测）

- **TypeScript**：TS2448 对"闭包内引用"不生效——TS 无法判断闭包何时被调用，只能放行；
- **Biome**：显式开启 `correctness/noInvalidUseBeforeDeclaration: "error"` 后用该模式
  探针验证，**同样零告警**（原因相同，对闭包保守放行）。

⇒ 这类 bug **只有真正执行这段代码才能发现**，运行时行为测试是唯一护栏。

测试策略（刻意走**失败路径**以最小化 mock 面）：`mock.module` 替换 GenerationQueue
返回 error → generate 闭包**照常执行**（TDZ 就发生在闭包里，能被测到），但不走到需要
ffmpeg 的 stageExport。观测契约：成功/失败两边都会把 `run.redoActive` 清成 null，
轮询它即可判断 fire-and-forget 的异步 IIFE 何时结束。
注意：必须用**动态 `await import()`**（静态 import 会被提升到 mock.module 之前）。

**已做变异验证**：人为把 `width/height` 声明移回 `withVersionedAsset` 之后，测试确实变红
（`疑似 TDZ 回归：Cannot access 'width' before initialization`），恢复后回到 3/3 ——
确认这不是"过了但抓不住回归"的空测试。

### 遗留（与本次改动无关，单独跟踪）

- **`pricing.test.ts` 单独耗时 43s**，是套件（~60s）的绝对大头，与本次改动无关；
  值得单独排查（是否有真实等待/重试），但不阻塞。
- reshot 的**成功路径**端到端测试仍缺（需要 ffmpeg + 真实 export，mock 面大）。

## 2026-08-28 续：Phase 0 —— 混音链回归测试（音频驱动改造的安全垫）

对应《音频驱动与并发调度-总文档.md》（设计+计划+handoff 单文档版，已并入旧实施计划并更新 Phase 0 为已完成）的 Phase 0。计划文档已先核实过：报告「额外发现②」
（export 丢弃视频源音轨）在当前代码**依然成立**（`ffmpeg.ts:492` 只取 `[i:v]`），
而这条链此前**零测试** —— A3 要动它，等于闭眼改。

**新增 `test/ffmpeg-mix.test.ts`（10 用例，64 → 74）**，分两层：

- **A. `buildDmeFilters` 纯函数（6 用例）**：三层全空 → anullsrc 静音兜底、
  旁白 adelay 秒→毫秒换算（J-cut 定位）、BGM 按 totalSec 裁齐 + 淡入淡出、
  BGM+旁白 → sidechaincompress 闪避、无旁白不挂 sidechain、多 SFX 先混成 sfxmix。
  为此把 `buildDmeFilters` 与 `DmeInput` 导出（纯函数，无 I/O，可精确断言）。
- **B. `assembleTimeline` 集成（4 用例）**：真跑 ffmpeg 验证产物。
  ffmpeg 在本机可用（chocolatey），故集成用例默认执行；环境缺失时自动 skip，不阻塞 CI。

**核心用例「镜头自带响亮音轨，但成片静音」—— 冲突②的回归锁**：
给镜头塞一条很响的 440Hz 音轨，却不给旁白 / BGM / SFX；若源音轨被丢弃，成片必然静音。
该用例带**前置自检**（先断言素材本身 `mean > -30dB`），否则"输出静音"会退化成假通过。

**已做变异验证**：把 `narrations` 的过滤改成"无旁白时拿自身视频当音源"（模拟 A3 打开
keepSourceAudio），该用例立刻变红 —— `成片应静音，实测 mean=-14.3dB`（可闻），
提示信息里写明了"它变红正是设计意图，请同步更新本用例"。恢复后回到 10/10。

**顺带核实并用到的环境事实**：`ffmpeg` / `ffprobe` 均在 PATH（chocolatey），
`runFfmpeg` 直接 `execFile("ffmpeg", ...)` 依赖 PATH 解析。
素材生成用 lavfi（testsrc + sine）免外部素材，codec 用 libx264 + aac。

验证：server tsc clean，`npm test` **74/74**（约 70s）。

## 2026-08-28 续：A1 —— 数据模型 + 闸门（音频驱动台词模式的跑道）

对应总文档 §4.2.1。A1 是纯兼容层：**只铺数据模型与闸门，不接任何生成功能**，
所以验收标准是"既有行为零变化 + 契约测试锁住新规则"，而不是跑通链路。

**产出**（跨两包六文件 + 两测试文件）：

- `prompts.ts`：`AudioMode` 三态（narration/dialogue/silent）+ `ShotDialogue` 子结构
  （`characterId`/`voiceId`/双语台词/`pausesSec`/仅 https 的 `audioUrl`）；
  `sanitizeDialogue`（宽容清洗）与 `dialogueFor`（按语言取台词）。
  `scriptMessages` 新增台词分支（规则 6-8 + 台词镜 JSON 示例），
  **仅当 `audioDrive === "dialogue"` 启用**——其余路径提示词一字不变。
- `video-agent` 包：`GenerationOptions.audioDrive`（`off|dialogue`，白名单，缺省 `off`）；
  `CoCharacter.voiceId`（角色音色绑定，跨镜头稳定的载体）。
- 新文件 `src/audio-mode.ts`：`shouldGateAudioDrive` / `detectSpeakers` /
  `hasMultipleSpeakers` / `enforceSingleSpeaker` 四个纯函数。
- `pipeline.ts`：`startRun` 三行闸门接线（判定→强制回落→审计事件）；
  `normalizeScript` 增加 audioMode 白名单与 dialogue 清洗。
- `stages/script.ts`：剧本落盘前调 `enforceSingleSpeaker`（D1）。

**关键决策与替代方案**：

1. **闸门判定抽成纯函数、独立成文件**。替代方案是直接写在 `startRun` 里——
   但那样契约测试必须起整条管线才能锁"非共创来源被强制回落"这条验收。
   抽出来后决策本身可直接测，`startRun` 只留三行接线；独立文件还避免了
   测试引 `pipeline.ts` 时的循环依赖顾虑（只依赖 prompts 的类型）。
2. **回落必须可审计**：强制回落发生在 `persistRun` 之后、同步推 `pushEvent`，
   用户在指挥台能看到"为什么我的台词模式没了"。闸门的沉默执行比放行更危险。
3. **D1 落剧本阶段、降级而非阻断**。多说话人是 2.5-flash 的运行时约束
   （每镜一条主语音），到片段阶段才发现就得整段返工且已烧配额；
   但剧本阶段同样已烧配额，所以违规镜**降级为旁白形态**（台词并进旁白字段，
   TTS 照常可念）+ 警告事件，而不是让 run 失败。用户可在剧本页拆镜后重跑。
4. **`normalizeScript` 的悬空状态不变量**：声明了 dialogue 但清洗失败
   （缺 characterId / 台词全空）→ 整镜回落 narration。"台词态却无台词"
   会让下游每个消费点都得防御，不如在入口一次掐死。
5. **接线测试复用闸门状态机的全桩脚手架**（`test/audio-gate.test.ts`）：
   `startRun` 会异步点火 `beginRun`，裸跑会打网络，必须全桩；两条用例
   断言同步状态（选项已回落 + 审计事件已入列）后，等 run 稳到
   `gate=design` 再收尾，避免测试结束时后台管线还在飞。

**测试**：`test/audio-mode.test.ts`（21 条：闸门判定四分支 / 清洗必要性与逐项过滤 /
白名单与悬空兜底 / 说话人识别中英冒号 / 降级行为）+ `test/audio-gate.test.ts`
（2 条 startRun 接线）+ `video-agent` 选项层 `audioDrive` 用例（含新增白名单专项）。

验证：server tsc clean，`npm test` **97/97**（74 → 97，约 65s）；
`video-agent` vitest 12/12。注：全仓 `tsc --noEmit`（根 tsconfig）本就有
ai/tui/pricing 测试的历史错误噪声，与本次改动无关（已过滤确认本次文件零错误）。

## 2026-08-29 续：A3 —— export 混音链改造（台词源音轨进成片）

对应总文档 §4.2.2，修冲突②：`assembleTimeline` 视频链只取 `[i:v]`，
台词模式的对白（就在生成视频音轨里）会被静默丢弃。Phase 0 的回归锁
正是为这次改动准备的——本轮按它的预告"变红即设计意图"完成拆分与翻转。

**改动落点**：

- `ffmpeg.ts`：
  - `TimelineShot.keepSourceAudio`（台词镜开关，缺省维持旧行为）；
  - `assembleTimeline` 先算视频链拿到各镜时间轴起点（转场重叠折算后），
    再按 镜头视频 → 旁白 → **台词源音轨** → BGM 挂输入；源音轨就是
    归一化镜头文件再挂一次输入单取 `[i:a]`；
  - `buildDmeFilters` 引入**对白总线**：旁白 `[narr]` 与源音轨 `[srcN]`
    合并为 `[voice]`（单路时直接复用标签），BGM 闪避与总混只认总线；
  - `measureLoudness` 同步：测量遍输入序 旁白 → 源音轨 → BGM，索引换算
    `narrations.length + j`——漏了这步，响度补偿会按错误读数算；
  - `normalizeShot` 增加保源音轨分支（无 audioPath 时 `[0:a]aresample,apad`）。
- `stages/export.ts`：台词镜 `keepSourceAudio: true` + `narrationPath: null`
  （再挂旁白会叠两次声）；节奏锚点在无 TTS 文件时改用 `dialogue.audioDurationSec`。
  `redo/compose.ts` 未动——合成剪辑暂不涉台词镜，缺省行为零变化。

**关键决策**：

1. **对白不做 J-cut**。旁白提前 0.35s 入是听感优化；对白是口型驱动源，
   提前/延后都是穿帮，`adelay` 严格按镜头起点（先 `atrim` 裁齐镜长防越界）。
2. **默认仍丢弃源音轨**。2.5-flash 的普通镜头也带原生音轨（音画同生），
   无差别接入会让既有成片的旁白底下混入不可控噪声。所以只认
   `keepSourceAudio` 显式开关，且用"兼容不变量"测试锁死默认静音行为。
3. **降级路径也要有声音**：xfade 失败降级 concat 硬拼时不走 DME 链，
   靠 `normalizeShot` 保源音轨让各镜自带对白——与旁白镜"归一化时嵌入
   TTS 供降级路径"的既有设计同构（export.ts 注释有载）。
4. **源音轨缺失 = 响亮失败**。`[0:a]`/`[i:a]` 遇无音轨文件会让 ffmpeg 报错，
   没做静默兜底：台词镜必出自音频驱动生成，走到这里还没音轨说明管线有 bug，
   炸出来比吞掉安全（符合"空状态必须有产物，但错误必须可见"）。

**测试**（10 → 16，套件 97 → 103）：

- 纯函数 +3：源音轨 `adelay`/`atrim` 构造、`[narr][src0]amix→[voice]` 总线、
  仅台词也让 BGM 挂 sidechain；
- 集成 +4：兼容不变量（默认仍静音）、keepSourceAudio 可闻、
  分段定位（前 1.5s 静音 / 2.3s 后可闻，`loudness` 加 `-ss/-t` 段探测）、
  归一化保源音轨；
- **变异验证**：把源音轨过滤改成恒假（断接线），恰好"可闻"与"定位"两条变红，
  兼容不变量保持绿——三把锁各司其职，已还原。

遗留（记入 A7/后续）：台词镜字幕目前仍取旁白字段（台词镜旁白为空 → 无字幕），
对白上字幕需要新的时间轴来源（`pausesSec`/台词分段），留给 UI 全量阶段。

验证：server tsc clean，`npm test` **103/103**（约 75s）。

## 2026-08-29 续：B1 起步 —— 配额账本 + 多池令牌桶（确定性底座·账本层）

B1 五项（多池令牌桶 + 事件驱动队列 + 幂等键 + 结果回收 + 配额账本）中先落
**账本层**——它是其余四项的正确性前提（D5：异步生成 40–90s 才出片，只在提交时
扣配额必被并发冲垮）。产出 `src/quota.ts`（新，纯内存 / 无 I/O / 无定时器）
+ `test/quota.test.ts`（21 例，注入时钟全确定性）。

**产出**：

- `TokenBucket`：容量封顶、按分钟速率惰性补充（访问时按传入 `now` 补发），
  `tryTake` / `available` / `msUntil` —— RPM 闸门（Free 1 / Ent 2 / TP 5 RPM）。
- `QuotaLedger`：多池账本，每池两道独立闸门（RPM 令牌桶 + 每日时长配额；
  `dailyQuotaSec: null` = 无明确配额，只受 RPM 约束）。四个操作：
  - `reserve(poolId, estimatedSec, {idempotencyKey, now})` —— 校验后扣减，
    同步完成"提交前先预留"；
  - `settle(id, actualSec)` —— 出片结算：多退差额、少补超支（扣到 0 为止，
    缺口记 `overrunSec` 供预算告警）；
  - `release(id)` —— 取消/作废全额退还（供应商已消耗时应走 settle 而非 release）；
  - `snapshot(now)` —— 全池观察快照（B2 observe_kitchen 的原料）。

**关键决策**：

1. **时钟注入、无定时器**：所有时间相关方法接受 `now`。账本是异步模型的
   正确性部件，测试必须不靠 fake timer 就能精确断言。
2. **校验顺序：配额先于 RPM**。配额不足的拒绝不吃 RPM 令牌（供应商没收到请求）；
   顺序反了会在配额耗尽时白白烧光令牌，恢复后一次都提交不了。
3. **幂等键只保护在途预留**：在途同键 → 返回原预留不重复扣减（挡并发重复提交）；
   终态后键即释放，允许 retts 重做复用键名。防的是"在途重复"，不是"历史重放"。
4. **终态重入 no-op**：结果回收可能双份送达（轮询 + 未来 webhook），对已终态
   预留再 settle/release 返回 `already_finalized`、无副作用——不许重复退钱。
5. **跨日语义**：换日重置每池剩余；在途预留存活、其结算计入新的一天；
   退还受日上限封顶（跨日释放不得把新的一天充爆）。
6. **非法实际时长（探测失败 → NaN）按预留全额消耗保守结算**——宁可少退不可多退。

**测试**（21 例，套件 103 → 124，纯单元、亚秒跑完）：令牌桶 3；预留与闸门 7
（含 **D5 竞态回归锁**：两个并发预留不许都"看到"配额充足；RPM 闸门与恢复；
拒绝不吃令牌；幂等键 ×2）；结算与释放 9（含双份结果回收、超支封顶、
守恒不变量"终态后剩余 = 日配额 − 实际消耗"）；跨日 2。
**变异验证 ×2**：① 删掉 reserve 的扣减行 → 10 例变红；② 反转 settle 终态守卫
→ 8 例变红；均已还原、复跑全绿——锁真的在咬。

**接线方案（B1 下一步，本次未动管线）**：

- 池配置：服务启动时从密钥层级建 `PoolSpec[]`（tokenplan → 500s/天 + 5 RPM；
  其余档 → `dailyQuotaSec: null` + 各自 RPM），注入 `StageCtx`；
- `stages/clips.ts` 提交循环改"先预留后提交"：`insufficient_quota` →
  阶段级预算告警事件（D5/B4 耦合点）而不是硬塞队列撞 429；
  `rpm_exhausted` → 按 `rpmWaitMs` 等待；
- 幂等键 = `${runId}:${shotId}:${attempt}`：i2v→t2v 降级重试是**新** attempt
  （新键、新 RPM 令牌），同一 attempt 的重复提交被去重；
- 结算时机 = `awaitJob` 返回后：done → `settle(id, probeDuration 实测)`
  （复用现有 P2 时长探测）；失败/中止 → `release`；
- 事件驱动队列与结果回收 webhook 仍待建：vendored `GenerationQueue` 现有的是
  "并发槽位 + 429 节流"，没有配额语义——账本是它们的前置，不是替代。

验证：tsc clean，`npm test` **124/124**（约 61s）。

## 2026-08-29 续：B1 接线 —— 配额账本接入 clips 提交循环

上一节的账本（`src/quota.ts`）接进了主生成链：`stages/clips.ts` 现在是
「预检 → 关键帧 → 预留 → 提交 → 结算/退还」的闭环（套件 124 → 130）。

**改动落点**：

- `config.ts`：`VIDEO_QUOTA_POOL`（"video"，单视频适配器 = 单池）+
  `loadQuotaLedger()`（缺省按 TokenPlan 实测：500s/天、2 RPM；
  `VIDEO_AGENT_QUOTA_DAILY_SEC` / `_RPM` 覆盖，"0" = 无时长配额只受 RPM）。
  `ServerContext.quota` 设为**可选字段**：`loadServerContext` 恒提供；
  手搓 ctx 的测试桩省略 = 不设闸门（旧行为）——降级优于阻断。
- `redo-adapters.ts`：`estimateClipSeconds` —— 预留量纲必须与
  `videoSubmitParams` 实际请求秒数一致（2.5 系列 [4,12] 钳制）。
- `stages/clips.ts`：
  - **预检**（关键帧前）：剩余配额明确不足 → 预算告警 + 剩余镜头记空位 +
    `break`，连关键帧成本都不烧（escalate 而非硬撞）；
  - **预留**：`reserveShotQuota`（导出，供行为测试）——时长不足返回 null；
    RPM 暂缺按 `snapshot().rpmWaitMs` 可中止等待后重试；
    幂等键 `${runId}:${shotId}:a${attempt}`；
  - **i2v→t2v 降级**：旧预留先退还，重试是**新 attempt**（新键、新令牌）；
  - **结算**：出片后 `probeDuration` 实测结算（探测失败按预估兜底，宁可少退不可漏结）；
  - **退还**：生成失败 / 中止异常 → 全额退还（未出片不消耗时长配额；
    RPM 令牌已在预留时消耗，如实反映提交行为）；
  - 零派发时抛配额专属错误（与"全部生成失败"区分，前端可读）。

**关键决策**：

1. **账本是进程级共享**（挂 `ServerContext`，不是 per-run）——每日配额是
   跨 run 的全局资源，per-run 账本会让并发 run 重新陷入 D5 竞态。
2. **预算告警走既有 `kind:"status"` 通道**：`TeamEvent.kind` 是前端硬契约
   （AGENTS.md：类型不要改），不新增类型；文案含剩余量 / 单镜预估 / 裁剪建议，
   B4 的结构化 `budget_alert` 契约等 UI 配合时再上。
3. **一份预留对应一次提交尝试**（而非一个镜头）：降级重试、失败重发各自
   独立预留/退还，账本才能如实反映"向供应商发了几次请求"。
4. **预检 + 实闸两层**：预检只读不扣（省成本），实闸（reserve）才是权威扣减；
   两者不一致时（并发 run 抢走配额）预算告警兜底，行为仍正确。

**测试**（新增 `test/quota-wiring.test.ts` 6 例，全桩环境、脚手架与
audio-gate 同构）：

- 足额链路：两镜实测 3.6s 结算 → 剩余 492.8、inFlight 0、恰好 2 次提交；
- 探测失败 → 按预估兜底结算（剩余 490）；
- **零违规锁**：配额 2s < 单镜 5s → `submitCalls === 0`（一个请求都不进队列）
  + 预算告警事件 + 配额分毫不动；
- **失败退还**：i2v + t2v 全失败 → 4 次提交、剩余精确回到 500（无幻影消耗）；
- RPM 等待回路：1200-RPM 快池抽干后 ~150ms 内等到令牌（锁等待而非整分钟阻塞）；
- `estimateClipSeconds`：2.5 钳 4 / 2.0 透传。

**变异验证 ×3**：① 删结算行 → 足额链路变红；② 删失败退还 → 失败退还用例变红；
③ 废掉预留闸门（恒返回占位预留）→ 零违规锁 + 足额链路 2 条变红。均已还原、
复跑 6/6。

### 2026-08-29 B1 redo 路径接账本（reshotRun 层）

**主线 commit**：
- `ce60a15` feat(video-agent-server): B1 redo 路径接账本（reshotRun 配额预留/结算/退还）

**改动要点**：
- `src/redo/reshot.ts` 新增本地配额接线（避免与 `stages/clips.ts` 循环依赖）：
  1. 提交前先 `reserveShotQuota`（RPM 暂缺可等，配额不足直接 bail）；
  2. `i2v→t2v` 降级路径退还旧预留、新 attempt 新幂等键重新预留；
  3. 出片后按 `probeDuration` 实测时长 `settleReservation`，探测失败按预估兜底；
  4. 失败/取消/回滚统一走 `releaseReservation` 全额退还；
  5. 配额不足事件直接进 `run.events`，用户可见。
- 新增 `test/reshot-quota-wiring.test.ts` 5 用例：
  - 足额链路：i2v 一次成功，实测 3.6s 结算 → 剩余 496.4、inFlight 0；
  - 探测失败：按预估 5s 兜底结算 → 剩余 495；
  - 零违规锁：配额 2s < 预估 5s → `mediaCalls === 0` + 预算告警事件；
  - 全失败退还：i2v + t2v 全失败 → `mediaCalls === 2`、剩余精确回到 500；
  - i2v 失败 → t2v 成功：旧预留退还、新预留结算 3.6s → 剩余 496.4。

**遗留（B1 剩余）**：
- ~~redo 路径未接账本~~ ✅ 已完成；
- 事件驱动队列 + 结果回收 webhook 待建。

验证：tsc clean，`npm test` **135/135**（约 41s）。

### 2026-08-29 A2 单镜台词链路 · 服务端核心（TTS→停顿→托管→reference 生成）

**主线 commit**：
- `f1c6eea` feat(video-agent-server): A2 台词链路服务端核心

**先记一个被实测推翻又还原的结论（两轮折腾的教训）**：2.5-flash 轮询端点
**双端点均可用但响应形状不同**（用 08-28 已完成任务 `task_wIbp…` 零成本双探测）：
`GET /agnesapi?video_id=<video_id>&model_name=agnes-video-2.5-flash` → 200，
**扁平响应、顶层 `url`**；`GET /v1/videos/{task_id}` → 200，**嵌套 `metadata.url`**。
原 models.json 的 agnesapi 配置（`taskIdPath:"video_id"` + `resultPath:"url"`）
**本来就自洽正确**；总文档 2.1「2.5 走 agnesapi 会 404」的旧说法是错的
（08-28 当晚大概率是用错 id 或漏了 `model_name` 参数）。我一度依据该说法把
statusUrl 改成 `/v1/videos/{id}` 而保留 `resultPath:"url"`——形状错配会取到
undefined。最终配置**还原 agnesapi 端点**（官方文档也是这个推荐：keyframe/
reference 模式必须带 `model_name`）。另确认：2.5 创建响应里 `id`=`task_id`=
`video_id` 三字段同值（`task_` 前缀，与 v2.0 的 `video_` 前缀不同）；
vendored `pollUntilDone` 轮询请求带 `authHeaders`（adapter.ts:491），鉴权无虞。
**教训入 1.5 坑 6 的又一实例：连"文档里的修正"也要实测，形状配对
（statusUrl 端点 ↔ resultPath 路径）必须一起动。**

**新模块**：

1. `src/hosting/tcb.ts`（CloudBase 托管，A2 六步链的第 3 步）：
   - 选型：`@cloudbase/node-sdk`（`app.uploadFile` 云存储 → 公开下载域
     `https://{envId}.tcb.qcloud.la/{path}`，匿名可读 + Range + 长期有效）。
     **`@cloudbase/manager-node` 在 tsx 下 import 即炸**（其依赖 `del` 的 CJS
     互操作问题，`promisify` 收到对象），已弃用卸载。
   - 凭据三路：env `TCB_*` → `<studioRoot>/.pi-studio/.env.cloudbase` →
     `<包根>/.env.cloudbase`（`.gitignore` 的 `.env*` 已覆盖，防 1.7 重演）。
   - 未配置 → `loadHostingConfig` 返回 null，台词镜降旁白（降级优于阻断）。
   - **前置条件（人工）**：CloudBase 控制台把环境存储权限设为「所有用户可读」；
     首测 403 则切静态网站托管（模块边界不变只换实现）。
2. `src/stages/dialogue-audio.ts`（`prepareDialogueAudio`，六步链的 1–3 步）：
   - TTS 按 `dialogue.voiceId`（params.voice 透传，适配器 buildBody 已支持）；
   - ffprobe 实测 → `pausesSec` 插停顿 → 托管；`audioUrl` 存活（HEAD 200/206）
     即复用免重传——重做路径的核心省钱点；
   - 回写 `dialogue.audioDurationSec/audioUrl`，但**脚本状态归调用方所有**
     （单一写者）：降级只返回意向（silent/narration），audioMode 与旁白回填
     由 stageClips 统一改写落盘。
3. `src/ffmpeg.ts`：`buildPauseFilters` 纯函数 + `insertPauses`。**pausesSec
   的 v1 语义**：把 [0, 实测时长] 均分为 n+1 段语音、段间依次插入各停顿——
   "均匀朗读"近似；升级路径（TTS 时间戳精确落点）等真实听感反馈再定。
   aformat 统一 44100/mono，规避 concat 规格不一致的响亮失败。

**stageClips 台词分支**：`audioDrive === "dialogue"` 且镜为 dialogue →
提交前备好公开音频 → `videoSubmitParamsForDialogue`（2.5：`mode:"reference"`
+ `audios:[url]`，prompt 追加 `<Audio 1>` 占位符；2.0：audios 被静默忽略——
返回 null 降旁白，不赌 400）→ **三级降级链 reference→i2v→t2v**，每级
新 attempt 新预留、失败全额退还（B1 语义直接复用）；回写后 `writeJson`
script.json（audio/export/retts/重启恢复读同一份）。防御分支：`audioDrive`
未开但镜声明 dialogue（旧 run 恢复/手改脚本）→ 主动降旁白留痕，不留给
export 的"源音轨缺失响亮失败"。

**测试**（套件 135 → 152，3 次变异验证：删 `<Audio 1>` 占位符 / 删 URL
复用 / 删 reference 失败退还，各自精确变红后还原）：
- `test/dialogue-audio-units.test.ts` 10 例：buildPauseFilters 切点/concat 数、
  托管 URL/落点/env 解析、reference 参数分支（2.5 reference / 4s 钳位 / 2.0 null）；
- `test/dialogue-clips.test.ts` 7 例：全链就绪（提交参数逐字段断言 + 回写落盘）、
  TTS 失败降 silent、托管失败降 narration、reference 失败降级（配额账实相符
  495.8）、URL 复用零重传、audioDrive 未开防御降级、全失败退还（三级链 + 
  stageClips 契约性抛错）。

**新坑（1.5 补充）**：给被多处 mock 的模块（`ffmpeg.ts`）新增**静态导出的
消费者**（dialogue-audio 导入 insertPauses），会让所有旧 mock 的
`namedExports` 链接断裂——mock.module 缺导出不是 undefined 而是整文件挂。
已同步补齐 4 个测试文件（audio-gate / gate-state-machine / quota-wiring /
reshot-quota-wiring）。**以后给 ffmpeg/queue/llm 加导入，先 grep test/ 的
mock.module。**

**A4a 台词镜时长对齐（08-29 晚，`e2a5f81`）**：设计 3.3 的可独立开工部分落地
（"以音频反推镜长"仍与 A6 同批）。`prepareDialogueAudio` 重构成
`synthesizeToPaced` 助手（TTS→实测→插停顿）后追加两步：
- **超长**（> 镜长+0.2s 容差）：LLM 精简（`dialogueCondenseMessages`，
  floor(镜长×4字/秒)、保持口吻）→ 同音色重录一次（配额计 2 次 TTS）；
  失败/仍超长 → 接受留痕。**不硬裁**——切在词中间比尾段轻微越界更伤。
- **过短**（< 镜长-0.05s）：`padTailToSec`（apad）补到镜长，口型结尾自然闭合。
- `audioDurationSec` 回写最终值（export 锚点 + 配额结算依据）。
- 容差 0.2s 的取舍：LLM 重录成本 > 0.2s 尾段越界的观感损失。
测试 152 → 158；2 次变异验证（砍精简 → ⑧⑪ 红、砍补静音 → ⑨ 红，精确命中）。
配套：`loadQuotaLedger` 无 `VIDEO_AGENT_QUOTA_DAILY_SEC` 时一次性运营提示。
**坑（测试基建）**：FakeQueue 原异步写产物文件，mock insertPauses 的 copyFile
偶发 ENOENT 走"停顿插入失败"分支——改同步写后消失。生产无此问题。

**A4b 以音频反推镜长 + A6 白名单放开（08-29 深夜，同批落地）**：设计 4.7 明确
两者必须同批——白名单不放开，反推动态值会被静默钳回。
- **A6（兄弟包 `video-agent`）**：`ClipDurationSec` 从 `[3,5,8,10]` 白名单放开为
  **3–12 整数区间**（上界对齐 2.5-flash seconds 上限）；UI 快捷档不变。既有测试
  "7 回退默认"改为"7 合法、13/2/7.5 回退"。
- **A4b（服务端）**：台词 ready 后 `dialogueDerivedSec(ceil(audioDur) 钳 4–12)`
  回写 `shot.durationSec`（reference 提交在音频之后，改镜长**零重生成成本**）；
  `estimateClipSeconds/videoSubmitParams` 加可选 `durationSecOverride`——预留量纲
  与提交 seconds 一致（账实相符不变量扩展到动态镜长）；台词镜的预留/降级重预留/
  提交全部读反推后的镜长。
- 测试 158 → **160**（+ dialogueDerivedSec 契约 1、A4b 行为 1：6.8s → 镜长 7 →
  seconds "7" → 配额 7 预留/实测 6.8 结算 = 493.2）；变异验证：禁用反推 → 2 红
  （⑩⑪）精确命中。
- 设计取舍：`ceil` 而非 round（镜长宁长勿短，音频尾部不截）；只对 reference
  成功的台词镜反推，降级旁白镜不改（J-cut 自动对齐）。

**CloudBase 网关探测结论（08-29 深夜，探到根因边缘）**：真实 EnvId
（`myagent-d0glujkt6c30cbe8a`，与 JWT aud 差一位字符！）已从用户提供的信息确认；
OpenAPI 规格在 `.cloudbase-mcp/openapi/storage.openapi.yaml`（本机另一 agent 的
MCP 数据目录）——**路由 `/v1/storages/get-objects-upload-info`（复数 storages）+
两步上传（拿签名 → PUT 直传 COS）**，请求体是数组、条目需 `signedHeader.content-length`。
实测：JWT 鉴权**通过**、路由**可达**，但报 `STORAGE_BUCKET_NOT_FOUND`；
同时 `tcb.qcloud.la` 匿名访问返回 **418**（桶存在、默认私有读）。
两个现象合起来的判断：**API Key 的项目绑定（aud `…330cbe8a`）与真实环境
（`…30cbe8a`）在存储桶解析上对不上**，或该环境存储为 PG 模式（传统 API 不适用，
规格第 9 行明说此接口只适用传统模式）。**下一步（二选一）**：① 用户在控制台
确认存储桶形态/在环境设置里创建 API Key（而非 AI+ 项目页）；② 直接给 CAM
SecretId/SecretKey（子账号可自助创建），node-sdk 路径已就绪。

**CloudBase 凭据新情报（用户提供的 `cloudbase_tts_upload_report.md`）**：
另一 agent 的 MCP 方案证实三件事：① API Key 登录 = `apiKey` + `apiKeyEnvId`
**两个字段**——JWT 的 aud（`myagent-d0glujkt6c330cbe8a`）疑似项目 ID/别名而
非规范 EnvId（与我们实测的 INVALID_ENV 吻合），真实 EnvId 在控制台 tcb 首页；
② 默认私有桶 publicUrl 403，**桶 ACL 须设 READONLY**（等价我们的
"所有用户可读"前置）；③ `temporaryUrl` 是 1h 签名链接，**不能**当持久
audioUrl 复用（重做路径会失效）——公开 URL 仍是唯一正解。

**待办（A2 收尾，等外部输入）**：
- CloudBase 存储桶形态确认（控制台）或 CAM 密钥 + 桶 ACL 公有读就绪后：真镜
  端到端（验收 = 人眼确认口型）；托管 URL 匿名 Range 206；2 RPM 节奏下逐镜验证
  （`resultPath` 形状已实测钉死，见上）。
- 台词镜的 i2v 锚定缺位（reference 不传 first_frame）是否影响一致性，留
  真实出片后评估。

**CloudBase 凭据波折（08-29 下午，记录实况）**：
- 用户先给了 **API Key JWT**（aud=`myagent-d0glujkt6c330cbe8a`，role=service_role，
  AI+ 平台颁发）。实测：node-sdk `init({apiKey})` 构造不报错，但 `uploadFile`
  运行时报 `missing secretId or secretKey`——**node-sdk 的存储上传不支持 API Key**；
  OpenAPI 网关 `{aud}.api.tcloudbasegateway.com/v1/storage/buckets` 返回
  `INVALID_ENV`（aud 疑似 AI+ project id 而非 CloudBase envId）。
- `tcb.ts` 相应改造：`HostingConfig` 支持 `apiKey` 与 `secretId/secretKey` 双模式
  （env 与 .env.cloudbase 均认 `TCB_API_KEY`），uploadFile 签名修正为
  `{cloudPath, fileContent: Buffer}`（node-sdk 无 localPath 参数，那界 manager-node）。
- 探针脚本 `scripts/probe-tcb.ts`（上传 + 匿名 Range 206 验证），凭据就绪后即验。
- `.env.cloudbase` 已配 apiKey 模式；**待用户给 CAM SecretId/SecretKey 或控制台
  真实环境 ID**。08-28 总文档"上传 206"验证的凭据来源无记录，无法复用。
- 另：2.5-flash 轮询端点双探测（已完成任务 id 零成本）钉死"agnesapi（扁平顶层
  url）/v1/videos（嵌套 metadata.url）形状配对"真相，总文档 2.1 旧说法证伪，
  models.json 定稿 agnesapi 形态；用户决策**agnes 视频无特殊情况一律 2.5-flash**。

验证：tsc clean，`npm test` **152/152**（约 46s）。
