# video-agent（piagent-glm）项目长期笔记

## 0. 项目构成（整理后，2026-08-31）

- **真正的项目**：`pi/packages/video-agent-server`（API）+ `video-agent-ui`（前端）+
  `video-agent`（共享包）。`pi/` 其余（ai/agent/tui/…）是 vendored 上游，不动。
- **文档**：全部收敛到 `doc/`（`reports/` 报告、`decisions/` 决策、`demo/` 演示动线、
  `methodology/` 方法论、`deployment/` 施工报告）+ 根 `HANDOFF`→`doc/HANDOFF-*.md`。
- **部署**：`pi/Dockerfile` + `pi/.dockerignore` + `pi/deploy/README.md`（Runbook）。
  单容器同源：Express 同时服务 `/api/*` 与 UI 静态（SPA 回退）。
- **不入版本库**（已 gitignore 或在整理中）：`e2e/`(1.4G 实验产物)、`tools/`(413M，含
  `ffmpeg-9.0.1-essentials_build/bin/{ffmpeg,ffprobe,ffplay}.exe`，
  **路径不是 `tools/ffmpeg/ffmpeg.exe`** —— 2026-09-01 踩过这个坑)、`_tts_test/`、`_pi-studio/`、根 `*.html` 报告、`pi/deploy/models.json`(含 key)。

## 1. 验证方式（必读，别踩坑）

- **三个包三套测试**：
  - `video-agent-server`：**node:test**（`npm test`）。2026-08-29 实测 229/229 / 52 suite / ~115s。
    挂死老根因：after 钩子裸 `fs.rm` 无 catch（Windows EBUSY）→ 已加 `.catch` + `--test-concurrency=1`。
  - `packages/video-agent`：**vitest**（非 node:test）。实测 39/39 / ~1s。
  - `video-agent-ui`：无测试，只跑 `npx tsc --noEmit -p tsconfig.json`。
- `tsc --noEmit` 要用**包自身 tsconfig**，根 tsconfig 会混入上游包既有报错。
- **绝不采信文档里的"验证通过"（含本文档与 dev-log）**。已多次发现声称与实际不符。
  **规矩：写进文档的数字必须有自己刚跑出的输出为依据。**

## 2. 业务事实（2026-08-29 郭煜确认，改写过设计前提）

- **视频模型限时免费**：每日时长配额（500s/天）已解除，但 **RPM 提交速率限制仍在**
  （Free 1 / Enterprise 2 / TokenPlan 5）。两者正交。
  `VIDEO_AGENT_QUOTA_DAILY_SEC=0` 即关闭配额（限时免费是临时状态，**绝不删配额代码**）。
- **每个 key 的限流各自独立**（实测推翻官方 FAQ 的"按 key 类型共享"）：N key → N 池 →
  总 RPM = 各池之和。**一个池 = 一个 key 的额度视图**。配置 `VIDEO_AGENT_QUOTA_POOLS`；
  选池 `QuotaLedger.pickPool()`；**唯一决策点 `stages/clips.ts` 的 `reserveShotQuota`**
  （clips/reshot/retts 三路径共用）。
- **坑**：`config.ts` 曾把"有无时长配额"与"Key 层级"混为一谈（设 `=0` 会把企业版 RPM 2
  误标 free 的 1，让 ReAct 代理低估能力）。已修：新增 `VIDEO_AGENT_QUOTA_KEY_TYPE` 显式覆盖，
  推断默认 `enterprise`，配 5 条语义测试 + 变异验证。

## 3. 台词链路方法论（2026-08-30 血泪六条，改台词/音频/导出前必读）

1. **agnes reference 跟读在内容层不可信**：包络相关 0.78-0.91 但 ASR 字面重合仅
   0.07-0.14——模型在**模仿节奏说乱语**。防线 = 双关卡（包络 ≥0.7 + ASR 重合 ≥0.5，
   `qa/audio-follow.ts` + `qa/asr-check.ts`），未过 → **dubOver**（保留口型画面、音轨换 TTS 原声）。
   **声音正确性 > 口型同步**，是定案不是遗留权衡。
2. **reference 提交音频必须是原始 24kHz TTS**：重编码 44.1k mp3 会让供应商读参考音频失败
   （对照 0.568 vs 0.072）。处理版只落盘不提交。
3. **双网关**：key1/2 → `apihub.agnes-ai.com`，key3/4 → `api.agnes-ai.cn`（含 poll statusUrl）。
   A 网关 401 ≠ 失效，先试另一网关；持续 401 → `quota.quarantineAdapter` 隔离 30 分钟。
4. **一镜一主语音互斥**：`normalizeScript` 对 dialogue 镜清空 narrationZh/En。
5. **字幕与人声时长锚定**：台词字幕 ≤ 人声时长 +0.8s（不是镜长）；节奏用 `rawDurationSec`
   （垫尾静音不进镜长）——否则后半段死寂。
6. **step-3.7-flash 可整片直审**：`video_url` 支持 base64 MP4（<128MB），带【设计预期 JSON +
   七项审阅要求】出精确到秒的问题清单（`e2e/deep-review.mjs`）。推理模型，max_tokens 给足；
   content 空时去 reasoning 尾部捞 JSON。

## 4. 结构性认知（改动前必读）

- `pipeline.ts` 巨型文件（2234 行），横切 helper 靠 ESM 函数提升与 `stages/*` 循环依赖共存；
  安全前提 = "stage 只在运行时函数体内访问它们"，别在模块顶层求值阶段引用。
- `withVersionedAsset`（`asset-version.ts`）是所有重做路径的公共抽象：①先备份再生成；
  ②失败只 pop 自己刚 push 的那项（并发安全）；③generate 返回 null **或抛异常**都要回滚。
- **SSE 双通道**：状态级 `event: run`（`persistRun`→`emitRunUpdate`）；事件级 `event: ev`
  （`pushEvent`→`emitEventAppend`）。**`pushEvent` 已不调 `persistRun`，团队消息只走 `ev`**——
  前端（`client.ts` `streamRun` + `store.ts` `bind.onEvent`）不接就完全不显示。改一端须同步另一端。
- **zustand v5**：`useShallow` 必须从 `zustand/react/shallow` 导入（主包不再导出）。
  **它拦不住引用变化**：字段若是对象（`run`），每次 `set({run:{...}})` 都换引用 → 全量重渲染。
  高频流（团队事件）必须**存成独立字段**，`onEvent` 只更新该字段、绝不重建父对象。
- **闭包型 TDZ：TS 和 Biome 都拦不住（已实测）**。TS2448 对闭包内引用不生效；Biome 开
  `correctness/noInvalidUseBeforeDeclaration: error` 仍零告警。⇒ **只有运行时行为测试能发现**。
  此类重构必配行为测试，并做**变异验证**（人为塞回 bug 确认测试变红），否则可能是空测试。

## 5. ⚠️ 安全：凭据泄漏（2026-08-28 发现，未完全闭环）

- 根 **`工具模型.txt` 存 StepFun / Agnes 明文 key**，自基线提交 `232dcce` 起被 git 跟踪
  → **旧密钥已在提交历史中**。
- 已做：加入 `.gitignore` + `git rm --cached`（磁盘文件保留）。
- **未做（需人工）**：① 去平台**轮换那批密钥**（历史里的应视为已泄露）；② 彻底清除需
  `git filter-repo` / BFG 重写历史 —— **破坏性、需 force push，未经郭煜明确确认不执行**。
- **本文件及所有记忆文件严禁写入密钥原文。**

## 6. 分批进度摘要（详见 doc/reports/）

- A2–A7（台词链 + 前端）：全通。`prepareDialogueAudio`→COS 托管→2.5-flash reference→三级降级
  (reference→i2v→t2v)；`ClipDurationSec` 白名单放开为 3–12 整数；音色绑定
  CoCharacter.voiceId → `bindCharacterVoices` → script.json → TTS。
- B2（只读制片主任）→ B3（L2 守卫 + 自动执行）→ B4（导演契约双向）→ B5（A/B 度量）：全通，
  套件 229/229。
- **reference prompt 定案**：「严格按 `<Audio 1>` 的内容与节奏说话…」**必须放 prompt 第一句**
  （`withReferenceAudioInstruction`，redo-adapters.ts）。指令前置 +0.990 vs 后置 0.295。
- **托管定案**：公开 URL 走 **COS 直连域** `{bucket}.cos.{region}.myqcloud.com`，**不走
  tcb.qcloud.la**（前置层 418）。`@cloudbase/manager-node` 在 tsx 下 import 即炸，用
  `@cloudbase/node-sdk`（`uploadFile({cloudPath, fileContent: Buffer})`，是 fileContent 不是 localPath）。
- **仍未闭环**：reshot 成功路径端到端测试（需 ffmpeg + 真实 export）；`pricing.test.ts`
  单独 43s 待排查。
- **测试基建坑**：①FakeQueue 必须**同步写**产物（异步写在微任务竞态下让下游 mock
  copyFile ENOENT 走错分支）；②给被 mock 模块（ffmpeg/queue/llm）新增静态导入消费者，
  会让旧测试 `mock.module` 的 namedExports **链接断裂** —— 加导入前先
  `grep -l "ffmpeg.ts" test/` 补齐所有 mock；③`queue.onJobUpdate?.()` 必须可选调用
  （测试桩接口面不齐，曾致 5 文件 18 用例红）。

## 7. RLHF 资产（2026-08-29 盘点）

- **已有**：15 维 `IntentKey`、`DirectorIntent`、`interviewLog`、执行轨迹 `TraceSpan`→traces.ndjson、
  审议 `proposals[]` + 采纳回写、 `QaVerdict` 多轴分。
- **核心诊断：有执行轨迹、无决策轨迹**。要做偏好学习必须补 L2 `DecisionSpan`
  （**candidates[] 不能省**）+ L3 `PreferenceEvent`，episodeId 串联。
- 最强信号：澄清答案被后续导演指令**推翻** = 精准负样本。
- 冷启动不跳步：采集 → 补候选集 → 只读回放 → **离线分析报表（不训练就有收益）** → 训练。
  门槛：报表 ≥50 episode、RM ≥300 样本、DPO ≥1000 偏好对。

## 8. CloudBase 部署事实（2026-08-31，已上线验证）

- **环境** `myagent-d0glujkt6c30cbe8a`（ap-shanghai，体验版）；**服务** `video-agent`，域名
  `https://video-agent-303977-11-1253451683.sh.run.tcloudbase.com`；单容器同源（API+UI 静态，8080）。
- **两个必踩根因（已修，写入 `pi/Dockerfile` + `pi/.dockerignore`，详见
  `doc/deployment/施工报告-部署-cloudbase-2026-08-31.md`）**：
  1. **缺 5 个 workspace dist**：`config.ts` 直接 import studio adapter 源码，解析到
     `agent/ai/coding-agent/tui` + 传递依赖 `telemetry` 共 5 个 dist，少一个即
     `ERR_MODULE_NOT_FOUND` → 容器起不来 → 探针 8080 connection refused → `deploy_failed`。
  2. **云托管不注入 PORT**：`config.ts` 读 `process.env.PORT ?? 8787`，容器实测监听 8787、
     探针打 8080 → 失败。**必须 `ENV PORT=8080`**。
- **CLI 两个坑**：① `--force` **不跳过**"是否灰度部署"交互项，需 `printf '\n' | tcb cloudrun
  deploy ...`（喂换行选默认 No）；② `--wait` + 管道 stdin 不可靠，改用提交后轮询
  `tcb cloudrun detail`（`OnlineVersionInfos` 从 `[]` 变有条目=成功）+ `tcb cloudrun logs
  process --run-id <id>`（看启动日志/探针失败原因）。
- **构建上下文**：robocopy `pi/` 排除 node_modules/dist(五包例外)/build/.git/test 等 →
  补 5 个 dist + `deploy/models.json`，约 32M；本机 Docker 未启动，全程**云端构建**（~4.5 分钟）。
- **已知限制（复述）**：① `MinNum` 现状 = **0**（2026-09-01 曾改 1 根治冷启动，
  **2026-09-02 因体验版额度见底改回 0**，演示时再临时改 1）；② run 产物容器盘易失；
  ③ models.json key 在镜像内（私有）；④ 体验版月额度 3000 点、**不允许超支**（见下方计费条目）。
- **线上验证口径**：`/api/health` → `{"ok":true,...}`；`/` → SPA（008 起标题 `Video Agent — 视频广告工作台`，
  007 时为 `AD://FORGE`）；`GET /api/` → 404（API 拦截正确）。常驻后实测 0.15–0.19s 稳定 200。
- **✅ 改服务配置不用去控制台（2026-09-01 验证）**：CLI 3.8.1 **没有** `update` 子命令，
  但 CloudBase 连接器可以：`manageCloudRun(action="updateConfig", serverName, serverConfig={MinNum:1,...})`
  → ~30s 生效，用 `queryCloudRun(action="detail")` 复核。
  坑：`Cpu/Mem/Port` 属 `likelyRedeployFields`——**只要传了就触发重新部署，哪怕值与现配置完全相同**
  （2026-09-01 实测产生 009 记录）。区别只是 `BuildId=0`、复用线上镜像、**不重新构建**（~30s vs
  4.5min），服务不中断。**最干净做法：`serverConfig` 只传 `{MinNum: n}`，其余字段一个都别带。**
- **预热协议（郭煜 2026-09-01 定，已写入 `pi/deploy/README.md`）**：⚠️ **2026-09-02 改回
  MinNum=0，此协议重新生效**，每次发链接前必须照做——① 发消息前几分钟自己先访问一次预热；
  ② 消息里**必须写明**「首次打开需等 10 秒左右」；③ 发完 10 分钟内再点一次保温。
- **坑位集中索引**：`doc/known-issues/坑位速查-面试版.md`（A 部署 / B 台词链路 / C 架构状态 /
  D 测试基建 / E 安全遗留 / F LLM-as-judge，每条带面试一句话 + 严重度）。改完坑记得同步过去。
- **💰 云托管计费（2026-09-02 实测账单验证，务必记住）**：
  - 单价：CPU **55 点/(核×小时)**、内存 **32 点/(GiB×小时)**（=0.055/0.032 元），1000 点≈¥1。
    ⇒ **1C2G 常驻 = 119 点/小时 = 2856 点/天 ≈ ¥2.86/天、¥85.7/月**。
  - 查账：`envQuery(action="usage", envId, type=["EKS"])`；查额度套餐：`envQuery(action="info", envId)`
    看 `BillingInfo`（**`EnableOverrun:false` = 不允许超支，额度耗尽即停服**）。
  - 本环境 `myagent-d0glujkt6c30cbe8a` = **体验版 baas_trial，月额度 3000 点**。
    2026-09-02 09:25 实测本周期（08-27 起）已耗 **2532.6 点**，云托管占 99.6%
    ⇒ **常驻只能再撑约 4 小时**。演示期外必须 `MinNum=0`。
  - **MinNum=0 缩零规则（官方）**：**连续半小时无"通过域名访问"才缩到 0**，缩零期不计费，
    冷启动约 30s。**⇒ 6–10 分钟的生成任务中途被缩零的风险很低**（远小于 30min 窗口）。
    ⚠️ 修正：此前记录的"生成中途会被回收中断"属**夸大**，已更正。
    注意：内网 IP 调用 / 纯定时任务**不算流量**，会被判无流量而缩零。
  - 省钱优先级：**`MinNum=0` > 降配**（0.5C1G=59.5 点/小时，半价，但属 likelyRedeployFields
    会触发重部署，且 1G 内存有 OOM 风险）。

## 9. ESM / runner 跨 session 经验（2026-09-01 补）

- **ESM `*.mjs` 顶层调 `main()` 会被 import 触发**——`run-scripts-v2.mjs` import 之后
  main 也跑了，导致 `run-single.mjs` 一启动就触发全量跑批。**所有顶层调 `main()` 的
  `.mjs` 都要加 ESM main guard**：
  ```js
  import { pathToFileURL } from "node:url";
  const isMainModule = process.argv[1] !== undefined && 
      import.meta.url === pathToFileURL(process.argv[1]).href;
  if (isMainModule) main().catch(...);
  ```
  Windows 上手拼 `file://${process.argv[1]}` 会因反斜杠 + 中文路径 URL 编码不匹配，**必须用 pathToFileURL**。
  当前 `e2e/run-e2e.mjs` / `e2e/deep-review.mjs` 也都没 main guard——现在没人 import 它们，
  没事；但加 lint 脚本一次性跑多个 e2e 工具时会重蹈。**进入 §1 验证方式必读列表**。

- **runner 解析脚本时如果有 "X 岁" 信号但 description 把它剥掉**，下游
  voicePoolForDescription 纯函数就拿不到 ageNum → 不走 young 分支 → 22 岁女儿被派
  femaleAdult 池。**任何 LLM-as-classifier 的输入端信号都要保留到下游入口**。

- **`coSpace.ideas: string[]` 是 user 向 LLM 注入软约束的唯一通道**——prompt 里被标
  "创意情节 / 卖点节拍（**优先采纳**）"。user 脚本 .md 的逐镜台词走这条路能让 director
  看到 user 意图。**硬约束（user audioMode 不被重写）需要升格为 schema 字段**，
  当前为软约束。详见 `doc/reports/历史踩坑补遗-第二轮-2026-09-01.md` §4/§9。

## 10. LLM-as-judge 的假阳性（2026-09-01 发现）

- **deep-review.mjs 的"设计预期"不是 user 脚本原文**——输入是 server 加工后的
  `script.json`（可能被 LLM director 重写过），step-3.7-flash 在 `script.json` 信息
  残缺时会**自己脑补"用户大概想要这种设计"**来对比，自然就报"设计预期 vs 成片不符"
  假阳性。实证：B剧 SH06 "智能审讯系统平板画面"是 deep-review 编的——user 脚本里只有
  "陈默低头阴影"。
- **任何 deep-review 报的"整镜丢失""关键元素消失"都必须先 ffprobe 视频 + 看 user 脚本原文**，
  确认不是模型幻觉。
- **加固方向**：让 deep-review 拿 user 脚本 .md 原文（而非 server 加工后产物）做 ground truth。

