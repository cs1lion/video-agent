# video-agent 项目长期笔记

## 验证方式（必读，别踩坑）

- **`npm test` 已修复（2026-08-28）**：挂死根因是 pricing.test.ts 六个 after 的裸 `fs.rm`
  无 catch（Windows EBUSY → after 抛错拖死进程），已加 `.catch` + `--test-concurrency=1`。
  三轮 50/50 稳定（约 15s）。若未来再挂死，优先排查各 test 文件 after 钩子的清理代码。
  行为测试两个：`asset-version.test.ts`（重做抽象三条不变量，6 用例）+
  `event-ndjson.test.ts`（事件落盘 append-only / 半行容错 / 迁移回落，5 用例）。当前 **55/55**。

- **`npx tsc --noEmit` 要用包自身的 tsconfig**（`packages/video-agent-server/tsconfig.json`，
  `include: ["src"]`），根目录 tsconfig 会混入 pi 上游包（ai/tui）的既有报错，噪声大。

- **不要采信 `docs/dev-log.md` 的"验证"章节**。实测已两次发现与声称不符
  （2026-08-28：声称 "tsc clean / 44/44 pass"，实际 typecheck 红 1 处、npm test 挂死、
  reshot 主干功能自 commit `c26bb0e` 起就没跑通过）。

## ⚠️ 安全：凭据泄漏（2026-08-28 发现，未完全闭环）

- 仓库根目录 **`工具模型.txt` 存有 StepFun / Agnes 的明文 API key**，且自基线提交
  `232dcce` 起就被 git 跟踪 → **旧密钥已在提交历史中**。
- 已做：加入 `.gitignore` + `git rm --cached`（磁盘文件保留，未丢失）。
- **未做（需人工）**：① 去平台**轮换那批密钥**（历史里的应视为已泄露）；
  ② 若要从历史中彻底清除，需 `git filter-repo` / BFG 重写历史 —— **破坏性操作，
  涉及 force push，未经郭煜明确确认不要执行**。
- 教训：任何"随手记录的 key 文本"都别放仓库里；`git add -A` 前先看 `git status`。
  本项目 `.gitignore` 已覆盖 `*.key` / `.env*` / 音视频产物。
- **本文件及所有记忆文件严禁写入密钥原文。**

## 结构性认知

- 真正的项目是 `pi/packages/video-agent-server` + `video-agent-ui`；`pi/` 其余是 vendored 上游。
- `pipeline.ts` 仍是巨型文件（2234 行），横切 helper（pushEvent/appendSpan/setStage/optionsOf/
  readArtifact/ensureKeyframe/throwIfAborted）全靠 ESM 函数提升与 `stages/*` 循环依赖共存——
  安全前提是"stage 只在运行时函数体内访问它们"，改动时注意别在模块顶层求值阶段引用。
- `withVersionedAsset`（`asset-version.ts`）是所有重做路径的公共抽象，三条不变量：
  ① 必须先备份再生成；② 失败只 pop 自己刚 push 的那一项（并发安全）；
  ③ generate 返回 null **或抛异常**都要回滚（2026-08-28 修复，try/catch 兜底）。
- **SSE 双通道（改动前必读）**：状态级 `event: run` 由 `persistRun`→`emitRunUpdate` 触发（阶段变更等）；
  事件级 `event: ev` 由 `pushEvent`→`emitEventAppend` 触发。
  **关键坑**：`pushEvent` 已不再调 `persistRun`，所以团队消息**只走 `ev`**——
  前端（`client.ts` 的 `streamRun` + `store.ts` 的 `bind.onEvent`）若不接这条通道，
  消息会完全不显示（只在下一次阶段快照里才补上）。改任一端都要同步另一端。
- **zustand v5**：`useStore(selector, equalityFn)` 第二参数已移除，`useShallow` 必须
  从 `zustand/react/shallow` 导入（主包 `zustand` 不再导出）。
- **`useShallow` 拦不住引用变化（高频流必须拆独立字段）**：`useShallow` 浅比较的是
  selector 返回对象各字段的**值**；若字段本身是对象（`run`），任何一次
  `set({run: {...cur, x}})` 都会换引用 → 订阅它的组件全量重渲染。
  所以高频变化的流（团队事件）要**独立于父对象存成单独字段**，
  `onEvent` 只更新该字段、绝不重建父对象——这才是 selector 化真正生效的前提。
- **闭包型 TDZ：TypeScript 和 Biome 都拦不住（已实测）**。2026-08-28 那个 P0
  （闭包引用了后面才声明的 const）之所以能活三个提交，根因在此：
  - TS 的 TS2448 对"闭包内引用"不生效——无法判断闭包何时被调用，只能放行；
  - Biome 显式开启 `correctness/noInvalidUseBeforeDeclaration: "error"` 后，
    用该模式探针验证**仍然零告警**（同样对闭包保守放行）。
  ⇒ **只有真正执行这段代码的运行时行为测试能发现**。此类重构务必配行为测试；
  写了回归测试后建议做**变异验证**（人为塞回 bug 确认测试真的变红），
  否则可能是"过了但抓不住回归"的空测试。

## 已知未闭环项（2026-08-28 评审，两轮修复后更新）

- ~~`RunView` interface 缺 `gate` 字段~~（已补声明）
- ~~`npm test` 挂死~~（根因：after 裸 rm 无 catch；已修）
- ~~reshot/retts/reexport 无行为测试~~（公共抽象层已补 asset-version.test.ts；端到端集成测试优先级降一档）
- ~~`lastActions` 前端零消费~~（指挥台加第三个标签「最近动作」，§10.4 验收项达成）
- ~~UI 无 selector/useShallow~~（4 处整页订阅已改 selector + useShallow）
- ~~`pushEvent` 每次全量 persistRun~~（已 ndjson 化，见下「SSE 双通道」）
- ~~一致性预检每次 export 强制重算~~（已加关键帧指纹缓存，命中连 640px 压缩都跳过）

- ~~StudioPage 整页重渲染~~（events 拆为独立 store 字段 + DirectorChat 自订阅，已解耦）
- ~~一致性预检缓存无失效测试~~（consistency-cache.test.ts，6 用例）
- ~~reshot 端到端测试~~（reshot-redo.test.ts，3 用例，已做变异验证）

**仍未闭环**：
- reshot **成功路径**端到端测试仍缺（需 ffmpeg + 真实 export，mock 面大）。
- `pricing.test.ts` 单独耗时 43s（套件 ~60s 的绝对大头），与近期改动无关，待单独排查。

## 8-27 规划设计会话要点（来自 pi-session-2026-08-27T*.html 导出）

该导出是 **No-tools 模式**的架构讲解+规划会话（3452 条消息，base64 编码，需解码才可读），
非代码改动会话。里面 0 个 Write/Edit 动作；用户贴入的 git diff 来自别的会话。核心决策：

- **多 agent 架构决策（郭煜拍板）**："多 agent 这块是否有必要，不要为了做而做" →
  扩展单 agent 已足够，确认协调后沉淀现有能力，不要为架构而架构。
- **审校/QA 设计**：用视觉模型（step-3.7-flash）检查成片（发色不一致等一致性问题），
  应**先于用户**发现；关键帧单帧审核复用 design-review 模式（帧 vs 设计卡比对，fail 自动重绘）
  使审核矩阵闭环。
- **TTS 用途历史**：当时 TTS 只用于生成**旁白（narrator）**，非角色台词。
  （注：2026-08-28 验证发现 2.5-flash `audios` 可驱动角色对口型 → "角色台词版本"是新方向，见验证报告）
- **关键 bug 线索**：`createHash` 未导入 → `promptSigOf` 运行时必炸 →
  "上游 refine 后关键帧标 stale"的过期级联**从未真正生效过（半个功能）**；
  tsc 增量缓存掩盖了报错。建议 CI 用 `tsc -b --force` 或定期删 `.tsbuildinfo`。
- **关键帧系统进度**：P0（关键帧多实体引用+依赖推导）已提交 `622e9a2`；
  P1 把关键帧从 STAGE 03.5 升级为真正的独立后端阶段（keyframes StageId，7 阶段状态机）。
- **orchestrator**：两步/三步协调角色；导演审议 = 懒人一键的质量兜底，需保证质量下限。
- **共创实验室开放分镜数上限**：P2 之前做，支持转场更多的长片。
- **跨 agent 可见性**：郭煜要求"把修改思路记在项目 md 文档，让不同 agent 都能主动看到" →
  即本 `.workbuddy/memory/` 机制的出发点。

## Agnes 限流事实（2026-08-28 查证官方 Token Plan FAQ，纠正旧报告）

- **多 key 不叠加**：限流池按 **key type（访问类型）** 共享，**同类型多个 key 不增加 RPM 也不增加配额**
  （官方原文："Creating multiple keys of the same type does not increase total RPM or quota"）。
  旧验证报告里"多 key 分片线性扩容"对 Agnes **不成立**，已纠正。
- **视频模型实际 RPM**：Free/默认 = 1、Enterprise = 2、Token Plan = 5。
  实测 2 req/min → 当前 key 是 **Enterprise** 层级（非免费、非 Token Plan）。
- **视频每日时长配额（硬约束）**：Token Plan = **500 秒/天**（所有套餐 Starter/Plus/Pro 同值），
  ≈ 100 个 5s 片段/天。免费层只有公平使用配额（无明确时长配额）。
- **同账号多类型 key 是官方支持的合法叠加**（原文："A user may hold multiple access types at
  the same time... Each key type uses its own limit pool"）：一个账号同时持 free+enterprise+
  TokenPlan 三类 key，三池独立，可部分叠加（例如 enterprise 2 + free 1 + TokenPlan 5 ≈ 8 RPM，
  且仅 TokenPlan 池带 500 秒/天配额）。这是无需多账号就能小幅提吞吐的正路。
- **多账号（跨账号）逻辑上可线性叠加**：限流绑在"账号的访问类型"上，不同账号=不同池，
  N 个 TokenPlan 账号≈N×5 RPM + N×500 秒/天。但属滥用防御条款范围（官方："may adjust ...
  based on ... abuse prevention"），且平台对免费层有"单 IP 默认 5 并发线程、大规模商用需单独
  签约付费套餐"的隐式管控——批量注册多账号有 ToS/关联识别风险，是下策。
- **最稳的大规模路径**：直接联系 Agnes 商务谈"单独签约付费套餐"（官方明确留此口子）。
- **视频异步生成**：RPM 只卡"提交频率"，已提交任务在后台队列并行出片；长片生产必须靠异步
  队列平滑提交 + 接受每日时长上限（500 秒/账号/天）。
- **生产影响**：当前 2 RPM + 无明确时长配额（Enterprise 层），长片生产必须升 TokenPlan +
  异步队列 + 接受每日时长天花板。

## A2 全链打通（2026-08-29，CAM 密钥到位）+ A5/A4b/A6 完成现状

- **A2 真镜 E2E ✅**：`scripts/e2e-dialogue-a2.ts`——COS 托管 → 2.5-flash
  reference（`task_uxNq0tV6xA2uTD4lOrMFsDdrSm59EKEk`）→ ~100s completed →
  `_tts_test/e2e-a2-SH01.mp4`（407 KB）。**待用户人眼确认口型**。
- **托管定案**：公开 URL = **COS 直连域**（`{bucket}.cos.{region}.myqcloud.com`），
  **不走 tcb.qcloud.la**（前置层 418）；桶 `6d79-myagent-d0glujkt6c30cbe8a-1253451683`
  （ap-shanghai）ACL 已 public-read（CAM putBucketAcl，一次性脚本
  `scripts/discover-and-open-bucket.ts`，cos-nodejs-sdk-v5 仅此脚本用 --no-save）。
  `tcb.ts`：getUploadMetadata → PUT 直传 → 元数据 URL 解析桶/区域缓存。
- **A5（服务端）**：`rettsRun` 台词镜级联——音频链复用 `prepareDialogueAudio`，
  clip 用 `withVersionedAsset` 版本化 + `reserveShotQuota`（幂等键
  `${shotId}-retts{n}:a{n}` 隔离）；reference 失败降旁白再 i2v/t2v（同 clips）；
  脚本两处写盘（音频链后 + 重生成后，变异 G 锁）。旁白路径抽出为
  `rettsNarration`（行为不变）+ 冒烟锁。
- **A4b**：台词 ready 后 `dialogueDerivedSec(ceil(audioDur) 钳 4–12)` 回写
  `shot.durationSec`；预留/提交/回写同一份。
- **A6**：`ClipDurationSec` 白名单 → **3–12 整数区间**；UI 快捷档不变。
- 套件 **168/168**。**余**：A2 人工验收② + A5 前端弹窗（归 A7）+ B1② + A7/B2 前端系。

## A4a 台词镜对齐现状（2026-08-29 晚，`e2a5f81`）

- **已完成**：超镜长 → LLM 精简重录一次（`dialogueCondenseMessages` + 同音色，
  容差 +0.2s，不硬裁）；短于镜长 → `padTailToSec`（apad）补到镜长；
  `audioDurationSec` 回写最终值。套件 158/158，2 次变异验证精确命中。
- **仍开放**：「以音频反推镜长 ceil(audioDur)」必须与 A6 白名单放开同批。
- **测试基建坑**：测试 FakeQueue 必须**同步写**产物文件——异步写在微任务竞态下
  会让下游 mock 的 copyFile ENOENT 走错分支（生产代码无此问题）。

## A2 台词链路现状（2026-08-29，接手必读）

- **服务端核心已完成**（commit `f1c6eea`，套件 152/152）：`src/hosting/tcb.ts`
  （CloudBase 云存储托管）+ `src/stages/dialogue-audio.ts`（TTS→实测→pausesSec
  插停顿→托管，URL 复用）+ stageClips 台词分支（reference 提交 + 三级降级
  reference→i2v→t2v）。真镜端到端验收**等 CloudBase 凭据**（`.env.cloudbase`：
  TCB_ENV_ID/SECRET_ID/SECRET_KEY + 控制台存储权限「所有用户可读」）。
- **2.5-flash 轮询端点纯配置即支持**（无需改 adapter 代码），但**双端点响应形状不同**：
  `agnesapi?video_id=&model_name=agnes-video-2.5-flash` → 扁平、顶层 `url`；
  `/v1/videos/{task_id}` → 嵌套 `metadata.url`。**statusUrl 与 resultPath 必须配对**。
  models.json 定稿：agnesapi + `taskIdPath:"video_id"` + `resultPath:"url"`（官方推荐，
  keyframe/reference 必须带 model_name；总文档 2.1 旧说法"agnesapi 会 404"已实测证伪；
  2.5 创建响应 id=task_id=video_id 同值，task_ 前缀）。
- **用户决策（08-29）**：agnes 视频**无特殊情况一律 2.5-flash**（v2.0 仅兜底）。
- **CloudBase 凭据现状（08-29，含用户报告情报）**：用户给的是 **API Key JWT**
  （aud=`myagent-d0glujkt6c330cbe8a`，service_role）。node-sdk 不认它；网关报
  INVALID_ENV。`cloudbase_tts_upload_report.md`（另一 agent 的 MCP 方案）证实：
  API Key 登录需 `apiKey` + **规范 EnvId** 两字段（aud 疑似项目 ID）；**桶 ACL
  须 READONLY** 否则 publicUrl 403；`temporaryUrl` 是 1h 签名链接**不能**当持久
  audioUrl。tcb.ts 已支持 apiKey/secret 双模式；`.env.cloudbase` 已配 apiKey 待解；
  探针脚本 `scripts/probe-tcb.ts`。**待用户**：控制台 tcb 首页的真实环境 ID
  → 先试 API Key + OpenAPI 网关，走不通再要 CAM SecretId/SecretKey。
- **`@cloudbase/manager-node` 在 tsx 下 import 即炸**（依赖 `del` 的 CJS 互操作），
  勿用；用 `@cloudbase/node-sdk`（`default.init(...).uploadFile({cloudPath, fileContent:Buffer})`
  ——注意签名是 fileContent 不是 localPath）。
- **新坑**：给被 mock 的模块（ffmpeg/queue/llm）新增静态导入消费者，会让所有旧
  测试文件的 `mock.module` namedExports **链接断裂**（不是 undefined）——加导入前
  先 `grep -l "ffmpeg.ts" test/` 补齐所有 mock。
- **pausesSec v1 语义**：等分插入静音（近似均匀朗读）；升级路径（TTS 时间戳
  精确落点）等真实听感反馈再定。

## 音频链路代码事实（2026-08-28 源码实读，改造前必读）

> **验证状态：单镜验证已通过，郭煜亲耳确认声音 + 口型 OK，方向已锁定。**
> 后续会话直接进入工程化改造，不必再验证技术可行性（除非换模型或换音色）。

现状是**旁白（画外音）**方案，链路 `script→visual→prompts→clips→audio→export`（audio 在 clips **之后**）：

- 旁白文本 `narrationFor()` 取 `shot.narrationZh/En`（prompts.ts:190）；
  LLM 表演指导 `ensureVoiceDirections()`（pipeline.ts:2252）存 `shot.ttsDirection`。
  TTS 失败**不阻断**，该镜以无声画面进时间线（audio.ts:54）。
- **视频自带音轨被完全丢弃**：ffmpeg.ts:475 只 `-i s.path`，视频链只用 `[i:v]`（:492）；
  成片音轨 = DME 三层（旁白 amix + BGM sidechaincompress 闪避 + SFX，:342）；旁白 J-cut 提前入（export.ts:214）。
- **retts 重录只重排导出，不重做视频**（retts.ts:139）——因为旁白与画面无关。
- `clipDurationSec` 是白名单 `[3,5,8,10]`（options.ts:92），动态值会被 clamp 回默认。
- `CoCreatePage.tsx` = 共创工作室，已有 **characters / scenes 实体** + 成本预估。

**改「音频驱动视频」（先 TTS→托管 URL→2.5-flash 参考出片）必踩的三个冲突**：
1. **export 会丢台词**：视频源音轨根本没进混音链 → 角色张嘴无声。须给 TimelineShot 增
   `keepSourceAudio`，台词镜接 `[i:a]` 且 `narrationPath=null`。
2. **重做级联**：改台词 → 音频变 → 口型对不上 → **视频必须重生成**。一次「重录」成本
   从「1 次 TTS + 重混音」变成「TTS + 托管 + 一次视频生成（吃 RPM 与每日时长配额）」。
3. **时长耦合**：台词模式镜长须由音频时长反推，但白名单会 clamp 掉动态值。

**设计取向（与郭煜共识）**：旁白不删也不被取代——下沉为**每镜三态**
`audioMode: narration | dialogue | silent`（ScriptShot 属性，非全局开关，同片可混用）。
台词态「更严格」的实质：每角色绑定 voice、情绪/气口结构化、**静音段是表演的一部分**
（2.5-flash 严格按音频包络对口型，停顿=闭嘴）、每镜只一条主语音、时长须 ≤ 镜长。
台词模式放**共创工作室**限定开放的最强理由：那里已有 characters 实体 = 音色绑定载体；
且服务端要有兜底校验（不能只靠 UI 藏开关，符合「闸门优先于派发」）。
