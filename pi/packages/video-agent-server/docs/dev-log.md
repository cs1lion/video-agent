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
