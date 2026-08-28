# video-agent 第二轮评审报告

> 评审范围：2026-08-27 评审之后的改动（Task 3 抽取战役 `stages/`/`redo/`/`qa/` + 未提交 WIP 19 改 8 新增）。
> 评审方法：实测优先——`npm run typecheck`、`npm test`、最小复现脚本交叉验证，不采信 dev-log 中的"已验证"声明。
> 立场：有品位、懂技术的工程师。先说结论，再给证据和修法。

---

## 一、总评（与 08-27 对比）

**一句话：这一轮把代码结构往前推了一大步，但验证体系没跟上——结构债换成了正确性债。**

| 维度 | 08-27 | 08-28 | 变化 | 依据 |
|------|-------|-------|------|------|
| 架构决策 | 8.5 | 8.5 | → | 单 Agent 判断未动摇，无新增抽象负债 |
| 流程/功能设计 | 8.0 | **8.5** | ↑ | 闸门 2 置信度、CommandPalette、TimelineBar、部分确认闭环 |
| 代码结构 | 6.0 | **7.0** | ↑ | pipeline.ts 4066 → 2234 行；`stages/`7 个 + `redo/`5 个 + `qa/` 落地 |
| 正确性 | 6.5 | **5.0** | ↓↓ | reshot 路径 100% 崩溃且丢文件；typecheck 红；B4 修复开新口子 |
| 工程规范 | 6.5 | **5.0** | ↓ | `npm run typecheck` 报错；`npm test` 挂死 17min+ |
| 文档诚实度 | 9.0 | **7.0** | ↓ | 架构文档仍 9.0；但 dev-log「验证」章节与实测不符 |

**最刺眼的一处对比**：dev-log 写「`npx tsc --noEmit` clean；44/44 pass」，实测是 **typecheck 红 1 处、`npm test` 挂死、且 reshot 主干功能在 commit `c26bb0e` 之后就没能跑通过一次**。

这不是能力问题，是**重构方法问题**：抽取重构没有行为测试护航，"44/44"覆盖的是闸门状态机与计费，**恰好绕开了所有被搬动过的代码路径**。

---

## 二、P0：必须立即修

### P0-1　`redo/reshot.ts` TDZ —— 补拍功能 100% 崩溃，且丢失用户旧片段

**这是本次评审最重要的发现。**

`redo/reshot.ts` 里，`withVersionedAsset` 的 `generate` 闭包使用了词法上更晚声明的 `const`：

```
137:  const { file: okRel } = await withVersionedAsset({
142:      generate: async () => {
148:          params: videoSubmitParams(sc.ctx, opts, width, height, kfDataUrl),   ← 使用
164:          params: videoSubmitParams(sc.ctx, opts, width, height, null),       ← 使用
...
183:  const { width, height } = pixelDimensions(opts.resolution, opts.aspectRatio);   ← 声明
231:  const kfDataUrl = kf?.status === "done" && kf.file ? ... : null;               ← 声明
```

`generate()` 在 `withVersionedAsset` 内部被**同步调用**（`asset-version.ts:97` 的 `const file = await generate()`），此时 183/231 行尚未执行 → TDZ → **`ReferenceError: Cannot access 'width' before initialization`**。

最小复现（已实测）：
```js
async function withVersionedAsset(generate) { const file = await generate(); return { file }; }
async function main() {
  const { file } = await withVersionedAsset(async () => {
    try { return `params=${width},${height}`; }          // reshot.ts:148
    catch (e) { return `THROW: ${e.constructor.name}: ${e.message}`; }
  });
  console.log("result:", file);
  const { width, height } = { width: 1920, height: 1080 };  // reshot.ts:183
}
// 输出：result: THROW: ReferenceError: Cannot access 'width' before initialization
```

**为什么 TypeScript 没拦住**：TS 的 TS2448（used before declaration）只在**可静态确定的直接引用**上生效；闭包内的引用 TS 假定"可能稍后才调用"，**不报错**。这是 TS 的已知盲区，也是"tsc clean ≠ 能跑"的典型样本。

**连锁后果（比崩溃本身更严重）**：

1. `withVersionedAsset` 已经把主文件 `rename` 到备份路径并 `versions.push(...)`；
2. `generate()` **抛异常**（不是返回 null），而回滚逻辑只在 `if (!file)` 分支里 → **不回滚**；
3. 结果：`assets/clip-SHxx.mp4` 消失（变成 `clip-SHxx_v1.mp4`），新片段没生成 → **用户旧素材丢失**；
4. `run.shotAttempts[shotId]` 已在 88 行自增 → **白扣一次重做配额**；
5. 最终 `run.status = "failed"`，`run.error` 是一句用户完全看不懂的英文 `Cannot access 'width' before initialization`。

**引入点**：commit `c26bb0e`（extract reshotRun → redo/reshot.ts）。抽取时把"先重绘关键帧、再生成视频"的顺序搬反了——证据是 175-178 行残留的**半成品注释**：

```ts
176:  // withVersionedAsset 返回 { file: string | null }；reshotRun 需要的是
177:  // 相对路径 (null 时 string 为 null) 以及 final filePath 绝对值。
178:  // 由于 generate 返了相对路径（会写入主名），需要根据主名反算绝对路径：
        ← 注释到此中断，紧接着就是"步骤 2 重绘关键帧"
```

**正确顺序应该是**：备份 → 重绘关键帧（180-230 行）→ 取 `kfDataUrl` → 再 `withVersionedAsset` 生成视频。

**修法**（两步，缺一不可）：

```ts
// A. 把 180-230 行的「关键帧重绘」整块上移到 137 行的 withVersionedAsset 之前
// B. 给 withVersionedAsset 加异常兜底，让"抛错"和"返回 null"一样能回滚：
//    asset-version.ts
let file: string | null;
try {
  file = await generate();
} catch (error) {
  if (backedUp && versions.at(-1) === backupRelPath) {
    await fs.promises.rename(backupAbs, mainAbs).catch(() => {});
    versions.pop();
  }
  throw error;   // 回滚后照常上抛，交给调用方记录
}
```

> **B 是独立于 A 的加固**。即使 A 修好了，只要 `generate` 抛错（网络、队列、磁盘满），当前实现依旧会丢主文件。抽象的不变量应该是「要么新文件就位，要么旧文件原样」，而不只是「generate 返回 null 时回滚」。

---

### P0-2　`src/consistency.ts:108` 类型错误 —— `npm run typecheck` 是红的

```
src/consistency.ts(108,20): error TS2345:
  Argument of type '{ llm: LlmConfig; priceCatalog: PriceCatalog; }'
  is not assignable to parameter of type 'ServerContext'.
  Missing: studioRoot, mediaConfig, port
```

这轮 WIP 把一致性预检接进了成本追踪（方向完全正确，正是上次评审 B3 的同族问题），但 `checkConsistency` 的形参是窄化的 `{ llm, priceCatalog }`，传给 `trackLlmCost` 就类型不符。

**dev-log 声称「`npx tsc --noEmit` clean」与实测不符**——在 `packages/video-agent-server` 下用包自身的 tsconfig（`include: ["src"]`）跑，稳定复现这一条。

**修法**：给 `trackLlmCost` 的 ctx 参数做最小依赖收窄，而不是把 `checkConsistency` 的签名放宽成 `ServerContext`（那会逼所有调用方造完整 ctx）：

```ts
// pricing.ts
type CostCtx = Pick<ServerContext, "llm" | "priceCatalog">;
export function trackLlmCost(run: RunRecord, ctx: CostCtx, ...): void
```

顺带解决 `trackMediaCost` 的同类问题，并让 `asset-version.ts` 那种"最小形状接口"的做法（它已经用 `RunDir` 避免循环依赖）成为全项目统一惯例。

---

## 三、P1：功能正确性与契约

### P1-1　B4 的修复本身开了新口子：重做失败也会被标记「已采纳」

上次评审 B4 要求"执行成功即置位 adopted"，修复是对的，但只处理了 `markAdopted` 失败，**没处理主动作失败**：

```ts
// store.ts:67-87  runAction 失败时「不抛错」，只 return false
catch (error) { set({ error: messageOf(error) }); return false; }

// DeliberationPanel.tsx:212-223
} else if (proposal.action === "reshot" && proposal.shotId) {
    await reshot(proposal.shotId, proposal.reason.slice(0, 400));   // 失败 → false，不 throw
}
setAdopted(key);        // ← 无条件执行：失败也标记"已采纳"
```

**后果**：补拍失败（配额用尽、管线忙、网络错误）→ 提案卡片显示"已采纳"并永久置灰 → 用户以为做过了，实际什么都没发生，且无法再次点击重试。这比原来的重复烧钱更隐蔽。

**顺带的不一致**：`reedit` 分支走 `await api.createPaceVariant(...)`（直调，失败会 throw → 正确报错），`reshot`/`retts` 走 store action（失败返回 false → 静默）。同一段代码里两条错误语义。

**修法**：

```ts
if (proposal.action === "reshot" && proposal.shotId) {
  const ok = await reshot(proposal.shotId, proposal.reason.slice(0, 400));
  if (!ok) { setAdoptError("补拍未成功，请查看顶部提示后重试"); return; }   // 关键：不置位
}
```

更彻底的做法是让 `runAction` 把失败原因**返回**而不是只写进全局 error：`return { ok: false, error }`，让调用方能就地展示。目前 `error` 只有一个全局槽（上次评审 4.4 提过），这里是它第二次咬人。

---

### P1-2　闸门 1 fail-open：质检越失败，护栏越松

```ts
// deliberation.ts:628-634
if ((action === "reshot" || action === "retts") && p.shotId) {
  const target = run.verdict?.shots?.find((s) => s.id === p.shotId);
  if (target?.verdict === "ok") throw new Error("镜头质检 ok，无需重做…");
}
```

`find` 找不到就放行，而"找不到"恰恰是两种高频场景：

| 场景 | `verdict.shots` 状态 | 闸门 1 |
|------|---------------------|--------|
| QA 降级（qa/review.ts:127） | 返回 `{overall:"warn", score:0, axes:[]}`，**无 shots** | **完全失效** |
| LLM 幻觉出 `SH99` | 无此 id | **静默放行** |

**这正是闸门最该拦的两种情况**，与 `director-agent.md`「闸门优先于派发」的设计原则直接冲突。而且它在退化路径上失效——系统状态越差，保护越弱。

**修法**：未知即拒绝，而不是未知即放行。

```ts
if (action === "reshot" || action === "retts") {
  if (!p.shotId) throw new Error("reshot/retts 必须指定 shotId");
  if (!scriptShotIds.includes(p.shotId)) throw new Error(`镜头 ${p.shotId} 不存在`);
  const target = run.verdict?.shots?.find((s) => s.id === p.shotId);
  if (!target) {
    // QA 数据缺失时收紧而非放开：只允许一次，并要求用户确认
    throw new Error("当前缺少质检数据，无法判断该镜头是否需要重做，请先重跑质检");
  }
  if (target.verdict === "ok") throw new Error("镜头质检 ok，无需重做…");
}
```

---

### P1-3　xfade 降级后，QA 抽帧位置系统性偏移

`stages/export.ts` 的抽帧位置基于**逻辑时间轴**计算：

```ts
212-227:  cursor += shotDur[i]! - overlap;      // 逻辑时间轴（吃掉了转场重叠）
321:      const midpoints = keptShots.map((_, k) => shotStart[k]! + shotDur[k]! / 2);
```

但降级路径（288 行 `concatWithSubtitles`）是**无重叠硬拼**，实际时间轴 = `ΣshotDur`，比 `cursor` 长 `Σoverlap`（每处转场 0.3-0.8s）。

`degraded = true` 之后**没有重算 midpoints**，于是从第二个非 cut 转场起，抽帧位置逐渐偏早，累积几镜后（1.5-2s）会**抽到前一个镜头的画面**——而单镜时长常常只有 1.4-5s。

**后果**：QA 五轴分数与逐镜裁决建立在错误的帧上，`textQuality`/`briefFit` 全部失真，且降级路径**恰恰是最需要准确质检的时候**。

**修法**（推荐 A）：

```ts
// A. 降级后按无重叠重算
if (degraded) {
  let acc = 0;
  midpoints = keptShots.map((_, k) => { const m = acc + shotDur[k]! / 2; acc += shotDur[k]!; return m; });
}
// B. 更彻底：让 assembleTimeline 返回每镜实际起点 shotStarts[]，QA 一律以它为准
//    （同时消除"逻辑时间轴 ≠ ffmpeg 实际输出"的隐患——目前代码用 info.totalSec 覆盖了
//     totalSec，却没有用 info 校正 shotStart）
```

---

### P1-4　一致性检查每次出片强制重算，成本在重做链路上叠加

- 三条重做路径都重跑整个 export：`reshot.ts:278` / `retts.ts:212` / `reexport.ts:75`
- `stageExport` 内含：EDL LLM → 合成 → **QA 视觉多模态** → **checkConsistency 全帧多模态（15-40s）**
- `stageExport:329` 用的是 `checkConsistency`（**强制重算**），而 `deliberation.ts:471` 用的是 `getConsistency`（**读缓存**）——同一个数据两种取用策略

**净效果**：一次补拍 = 1 次视频生成 + 3 次 LLM 调用 + 15-40s 额外等待。跨镜一致性看的是**关键帧**，而补拍单镜通常不改其他镜头的关键帧——这笔钱和等待大部分是白花的。

**修法**：给一致性结果加内容指纹，指纹未变则复用缓存。

```ts
const sig = frames.map(f => `${f.shotId}:${f.file}:${f.attempts ?? 0}`).join("|");
const cached = await getConsistency(run);
if (cached && cached.signature === sig) return cached;   // 命中则跳过
```

---

## 四、P2 与工程规范

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-1 | `pipeline.ts:257-290` | **`RunView` interface 缺 `gate` 字段**，但 `runView`(419) 与 `persistRun`(552) 运行时都返回了它。前端靠自己声明类型绕过，后端测试 `RunView.gate` 直接编译报错 | 给 `RunView` 补 `gate?: "design" \| "keyframes"` |
| P2-2 | 全前端 | **B7 未闭环**：`lastActions` 仍只有 `client.ts:150` 的类型声明，**零组件消费**。架构文档 §10 验收项「对话分类时直接确认已完成」未达成 | StudioPage 顶部 pill 已读 events，改为优先读 `lastActions` |
| P2-3 | `npm test` | **挂死 17 分钟无输出**；但分文件跑全过（run-store 3/3、pricing 34/34、gate 7/7，合计 44/44，约 50s）。怀疑 `--experimental-test-module-mocks` 多文件并发时模块 mock 互相污染 | 改 `--test-concurrency=1`；或拆成 `test:pricing` / `test:gate` 分别跑 |
| P2-4 | `deliberation.ts:753` | 注入 prompt 的文案是「**最近 3 分钟**已执行的动作」，实际 `slice(0, 8)` 取最近 8 条且**不做时间过滤**——对 LLM 说了谎，可能让它放弃一个早就过期的合理建议 | 按 `LAST_ACTION_DEDUP_MS` 过滤后再注入，或改文案为「最近 8 次动作」 |
| P2-5 | `asset-version.ts` | 见 P0-1 的 B 项：异常路径不回滚 | 用 try/catch 包 `generate()` |
| P2-6 | `stages/export.ts:175-178` | 抽取残留的半成品注释（写了问题没写结论） | 删除 |
| P2-7 | UI store | 仍无 selector/`useShallow`，4 处 `useStudio()` 全量订阅；SSE 高频推流触发 637 行 StudioPage 整页重渲染 | `useStudio(useShallow(s => ({...})))` 按字段订阅 |
| P2-8 | `pipeline.ts:675` | `pushLastAction` 每次都 `persistRun`（全量 state 重写，含 400 条事件）；`pushEvent` 同样 | 事件流独立成 `events.ndjson` append-only（traces 已是此模式） |

---

## 五、这轮做对的事（值得保留的设计）

评审不能只挑毛病，这几处是**判断力**的体现：

1. **`withVersionedAsset` 抽得对，且注释写清了不变量**（`asset-version.ts` 头 20 行）。「必须先备份再生成」「失败时只 pop 自己 push 的那一项（并发安全）」——这两条是踩过坑才写得出来的。4 处复制收敛成 1 个 helper 后，这类知识不再靠人肉传递。
2. **QA 用三态多数决而非 0-100 分数做 gate**（`qa/review.ts:94-98`）。注释写明「LLM 的 0-100 是伪精确，同帧复评浮动 ±10 常见」——**承认模型输出的精度上限，改用离散裁决驱动决策**，这是很成熟的建模判断。
3. **B3/B5/B9/B10/B11 都真修了**：视觉调用按真实 prompt 长度 + 帧数计费；闸门 3 的 `action.replace("retts","retts")` no-op 改成显式映射；`image/png` → `image/jpeg`；会话 Map 加了 TTL 驱逐；退避 sleep 带上了 signal。
4. **CommandPalette 的降级设计**（`CommandPalette.tsx:90-99`）：输入不匹配任何命令时兜底成「发送给导演」。符合项目一贯的「失败降级而不是阻断」。
5. **`keyframeSelectionKey` 签名驱动重建选择集**（`StudioPage.tsx:170-199`）：避免 SSE 高频刷新时用户勾选项被冲掉。虽然用了 `eslint-disable`，思路是对的。

---

## 六、修复优先级

| 优先级 | 事项 | 预估 |
|--------|------|------|
| **立即** | P0-1 reshot 顺序修正 + `withVersionedAsset` 异常回滚（15 行） | 30 分钟 |
| **立即** | P0-2 `trackLlmCost` ctx 收窄（3 行）+ 把 `npm run typecheck` 接进 pre-commit | 20 分钟 |
| 本周 | P1-1 采纳失败不置位、P1-2 闸门 fail-open、P1-3 降级重算 midpoints | 半天 |
| 本周 | **给 reshot/retts/reexport 补行为测试**（这是 P0-1 能活到今天的根因） | 1 天 |
| 下周 | P1-4 一致性缓存指纹、`npm test` 并发修复 | 半天 |
| 迭代内 | P2-1/2/7/8 契约与性能 | 1-2 天 |

---

## 七、给 Builder Program / 面试的一句话

> 这套系统最值钱的不是「8 阶段流水线」，是**它知道什么时候该拦住自己**——4 道闸门、每条昂贵路径都有备胎、成本先算后花、承认 LLM 打分是伪精确所以改用离散裁决。
> 而这一轮的教训同样值钱：**重构把 4066 行拆到 2234 行，却因为缺行为测试，让主干功能静默坏了三个提交**——结构债可以慢慢还，正确性债必须立刻还。
