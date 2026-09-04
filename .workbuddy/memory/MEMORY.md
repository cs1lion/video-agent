# video-agent（piagent-glm）项目长期笔记

## 0. 项目构成与验证方式

- **真项目**：`pi/packages/{video-agent-server, video-agent-ui, video-agent}`。
  `pi/` 其余（ai/agent/tui/…）是 vendored 上游，不动。文档收敛在 `doc/`。
- **不入版本库**：`e2e/`(1.4G)、`tools/`(413M，ffmpeg 路径是
  `tools/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe`，**不是** `tools/ffmpeg/ffmpeg.exe`)、
  `_tts_test/`、`pi/deploy/models.json`(含 key)、根 `*.html` 报告。
- **三套测试（数字必须自己刚跑出来，绝不采信文档旧值）**：
  | 包 | 命令 | 2026-09-04 实测 |
  |---|---|---|
  | video-agent-server | `npm test`（node:test） | **325/325**，74 suite，89s |
  | video-agent | `npx vitest run` | **39/39**，1.3s |
  | video-agent-ui | `npx tsc --noEmit -p tsconfig.json` | **0 error**（无测试） |
- `tsc` 必须用**包自身 tsconfig**（根 tsconfig 混入上游既有报错）。
- server 测试挂死老根因：after 钩子裸 `fs.rm` 无 catch（Windows EBUSY）→ 已加 `.catch` + `--test-concurrency=1`。

## 1. 业务事实

- **视频模型限时免费**：日时长配额已解除，但 **RPM 限制仍在**（Free 1 / Enterprise 2 / TokenPlan 5）。
  `VIDEO_AGENT_QUOTA_DAILY_SEC=0` 关配额（临时状态，**绝不删配额代码**）。
- **每个 key 限流独立**（实测推翻官方 FAQ）：N key → N 池 → 总 RPM = 各池之和。
  配置 `VIDEO_AGENT_QUOTA_POOLS`；选池 `QuotaLedger.pickPool()`；
  **唯一决策点 `stages/clips.ts` 的 `reserveShotQuota`**（clips/reshot/retts 共用）。
- 坑：`config.ts` 曾把"有无配额"与"Key 层级"混为一谈（设 `=0` 把企业版 RPM 2 误标 free 的 1）。
  已修：`VIDEO_AGENT_QUOTA_KEY_TYPE` 显式覆盖，默认推断 `enterprise`，配 5 条语义测试 + 变异验证。

## 2. 台词链路六条（改台词/音频/导出前必读）

1. **agnes reference 跟读内容层不可信**：包络 0.78-0.91 但 ASR 字面重合仅 0.07-0.14（模仿节奏说乱语）。
   双关卡：包络 ≥0.7 + ASR 重合 ≥0.5（`qa/audio-follow.ts` + `qa/asr-check.ts`），未过 → **dubOver**。
   **声音正确性 > 口型同步**（定案，非权衡）。
2. **reference 提交音频必须原始 24kHz TTS**：重编码 44.1k mp3 让供应商读参考失败（0.568 vs 0.072）。
3. **双网关**：key1/2 → `apihub.agnes-ai.com`，key3/4 → `api.agnes-ai.cn`。A 网关 401 ≠ 失效，
   先试另一网关；持续 401 → `quota.quarantineAdapter` 隔离 30min。
4. **一镜一主语音互斥**：`normalizeScript` 对 dialogue 镜清空 narrationZh/En。
5. **字幕锚定人声**：台词字幕 ≤ 人声时长 +0.8s（不是镜长）；节奏用 `rawDurationSec`（垫尾静音不进镜长）。
   旁白字幕也要夹在 `shotStart + shotDur` 边界内（2026-09-01 补遗 §7）。
6. **step-3.7-flash 可整片直审**：`video_url` 支持 base64 MP4（<128MB），出精确到秒的问题清单
   （`e2e/deep-review.mjs`）。推理模型，max_tokens 给足；content 空时去 reasoning 尾部捞 JSON。

## 3. 结构性认知（改动前必读）

- `pipeline.ts` 2234 行巨型文件，横切 helper 靠 ESM 函数提升与 `stages/*` 循环依赖共存；
  安全前提 = **stage 只在运行时函数体内访问它们**，别在模块顶层求值阶段引用。
- `withVersionedAsset`（`asset-version.ts`）是所有重做路径的公共抽象：①先备份再生成；
  ②失败只 pop 自己刚 push 的那项（并发安全）；③generate 返回 null **或抛异常**都要回滚。
- **SSE 双通道**：状态级 `event: run`（`persistRun`→`emitRunUpdate`）；事件级 `event: ev`
  （`pushEvent`→`emitEventAppend`）。**`pushEvent` 已不调 `persistRun`**——前端不接 `ev` 就完全不显示。
- **zustand v5**：`useShallow` 从 `zustand/react/shallow` 导入。**拦不住引用变化**：字段是对象时
  每次 `set({run:{...}})` 换引用 → 全量重渲染。高频流必须**存成独立字段**，`onEvent` 只改该字段。
- **闭包型 TDZ：TS 和 Biome 都拦不住**（实测 TS2448 对闭包内引用不生效）。⇒ 只有运行时行为测试能发现，
  且必做**变异验证**（人为塞回 bug 确认测试变红），否则可能是空测试。

## 4. ⚠️ 安全：凭据泄漏（2026-08-28 发现，未闭环）

- 根 **`工具模型.txt` 存 StepFun / Agnes 明文 key + 云服务器密码**，自基线提交 `232dcce`
  起被 git 跟踪 → **旧密钥已在提交历史中**。
- 已做：加 `.gitignore` + `git rm --cached`（磁盘文件保留）。
- **未做（需人工）**：① 去平台**轮换密钥 + 改云服务器密码**；② 清历史需 `git filter-repo`/BFG
  —— **破坏性、需 force push，未经郭煜明确确认不执行**。
- **本文件及所有记忆文件严禁写入密钥原文。**

## 5. CloudBase 云托管（2026-08-31 上线，体验版额度已近耗尽）

- **环境** `myagent-d0glujkt6c30cbe8a`（ap-shanghai，体验版）；**服务** `video-agent`；
  域名 `https://video-agent-303977-11-1253451683.sh.run.tcloudbase.com`；单容器同源（API+UI，8080）。
- **两个必踩根因（已修，写入 `pi/Dockerfile`）**：
  1. **缺 5 个 workspace dist**（`telemetry/ai/agent/coding-agent/tui`）：`config.ts` 直接 import
     studio adapter 源码 → 少一个即 `ERR_MODULE_NOT_FOUND` → 探针 8080 refused → `deploy_failed`。
  2. **云托管不注入 PORT**：必须 `ENV PORT=8080`（否则监听 8787，探针打 8080）。
- **CLI 坑**：① `--force` 不跳过"是否灰度部署"交互项，需 `printf '\n' | tcb cloudrun deploy ...`；
  ② `--wait` + 管道 stdin 不可靠，改用轮询 `tcb cloudrun detail`（`OnlineVersionInfos` 从 `[]` 变有条目）。
- **改配置走 CloudBase 连接器**（CLI 3.8.1 无 update 子命令）：
  `manageCloudRun(action="updateConfig", serverConfig={MinNum:n})`。
  ⚠️ **只传 MinNum**：带 `Cpu/Mem/Port` 即使值相同也会触发重部署（`likelyRedeployFields`）。
- **💰 计费**：CPU 55 点/(核×小时)、内存 32 点/(GiB×小时)，1000 点≈¥1。
  **1C2G 常驻 = 119 点/小时 ≈ ¥85.7/月**。体验版月额度 3000 点且 `EnableOverrun=false`（**耗尽即停服**）。
  查账 `envQuery(action="usage", envId, type=["EKS"])`。
  **2026-09-04 11:20 实测：本周期（08-27~09-27）已耗 2908.6 点，仅剩 91.4 点** → 演示期外必须 `MinNum=0`。
- **缩零规则**：连续 30min 无「通过域名访问」才缩到 0，缩零期不计费，冷启动约 30s。
  ⇒ 6–10min 的生成任务中途被缩零风险很低（此前"会被中断"的说法属**夸大**，已更正）。
  内网 IP / 定时任务**不算流量**。
- **预热协议（MinNum=0 时必做）**：发链接前先自己访问一次；消息里写明「首次打开需等 10 秒」；
  发完 10min 内再点一次保温。
- 坑位索引：`doc/known-issues/坑位速查-面试版.md`（改完坑同步过去）。

## 6. 自建云服务器部署（2026-09-04）

- 主机信息在根 `工具模型.txt`（**含明文密码，读取会被敏感审批拦截，需用户批准**）。
- **生产入口：`http://49.233.207.18/`（Nginx 80→8080 反代，SSE 已实测公网实时）。**
  **云托管因额度停摆已非主部署**，演示/验收走 CVM。运维：`sudo systemctl restart video-agent`、
  `sudo journalctl -u video-agent -f`、nginx 配置 `pi/deploy/nginx-video-agent.conf`。
- **机型硬约束：2核 / 1.7Gi 内存（实测 MemTotal）/ 50G 盘 / Ubuntu 24.04 / 有 docker、git、curl，无 node、无 ffmpeg。**
  ⇒ **1.7Gi 内存跑不动 vite build 与全量 npm ci 峰值**（靠 2G swap 才撑过 npm ci）。
- **常驻限制（与云托管对比的关键差异）**：
  ① **实例持续计费**——不关机就一直烧钱，演示空窗期应在控制台关机（云托管是空闲缩容到 0、不跑不花钱）；
  ② **无默认 TLS**（仅 80 明文），放登录前需 certbot 加 HTTPS；
  ③ **单 2 核、无横向扩展、VM 级宕机=全断**（systemd 只防进程崩，无 HA）；
  ④ API 的 RPM 限速是 StepFun/Agnes 按 key 的限制，**与部署形态无关**；CVM 的收益是甩掉云托管 3000 点额度天花板。
- **中文字体已沉进 deploy-to-cvm.sh**：fonts-noto-cjk + fontconfig 别名 `Microsoft YaHei→Noto Sans CJK SC`
  自动装（幂等 + fc-match 验证）。不依赖人记 Runbook。**根因**：导出 ASS FontName 硬编码 Microsoft YaHei。
- **⚠️ SFTP 从 Windows 写 Linux 配置会带 CRLF 污染 XML**（实测 fontconfig XML 被 xmllint 拒绝 EXIT=1）：
  写 Linux 配置文件（fontconfig/nginx/systemd drop-in 等）一律用 paramiko exec 的 shell heredoc (`tee <<EOF`)，**不要用 sftp.open(path,"w")**。
- **定案部署形态（本地构建 + 服务器只装依赖）**：
  1. 本地 `npm run build -w @earendil-works/pi-video-agent-ui`（1.4s，13 个文件）；
  2. 打包 `pi/` 排除 node_modules/dist，再**单独补 5 个 workspace dist + UI dist**
     + `deploy/models.json` + `deploy/deploy-to-cvm.sh` → 6.6M tar.gz；
  3. 服务器：`deploy-to-cvm.sh`（`pi/deploy/`）自动 swap 2G → apt ffmpeg → NodeSource Node 22 →
     npm registry 切 npmmirror → `npm ci` → systemd 托管，端口 8080；
  4. `models.json` → `/opt/video-agent/.pi-studio/models.json`（权限 600）。
- **远程执行方式**：本机无 sshpass，用隔离 venv 装 paramiko（`C:\Users\18712\.workbuddy\binaries\python\envs\default`）。
  后台跑必须 `setsid ... </dev/null >log 2>&1 &`，否则 paramiko `stdout.read()` 等不到 EOF 而超时。
- 部署编排脚本：`pi/deploy/deploy-to-cvm.sh`（服务器侧）+ 临时 `va-deploy.py`（本机 upload/start/log/status）。

## 7. ESM / runner 跨 session 经验

- **ESM `*.mjs` 顶层调 `main()` 会被 import 触发** → 必须加 main guard：
  ```js
  import { pathToFileURL } from "node:url";
  const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  if (isMain) main().catch(...);
  ```
  Windows 中文路径必须 `pathToFileURL`（手拼 `file://` 会因反斜杠/编码不匹配）。
  当前 `e2e/run-e2e.mjs` / `e2e/deep-review.mjs` 都没 guard。
- **LLM-as-classifier 的输入端信号要保留到下游入口**：runner 剥掉 "X 岁" 后
  `voicePoolForDescription` 拿不到 ageNum → 22 岁女儿被派 femaleAdult 池。
- **`coSpace.ideas: string[]` 是 user 注入软约束的唯一通道**（prompt 里标"优先采纳"）。
  硬约束（user audioMode 不被重写）已升格为 `coSpace.scriptIntent` schema 字段（2026-09-01 补遗 §4）。

## 8. LLM-as-judge 的假阳性（2026-09-01）

- **deep-review.mjs 的"设计预期"不是 user 脚本原文**——输入是 server 加工后的 `script.json`，
  step-3.7-flash 在信息残缺时**自己脑补"用户大概想要什么"**再对比，自然报"设计预期 vs 成片不符"
  假阳性（实证：B剧 SH06 的"智能审讯系统平板画面"是模型编的，user 脚本只有"陈默低头阴影"）。
- **任何"整镜丢失""关键元素消失"都必须先 ffprobe 视频 + 核对 user 脚本原文**再下结论。
- 加固方向：让 deep-review 拿 user 脚本 .md 原文（而非 server 加工产物）做 ground truth。

## 9. RLHF 资产（2026-08-29 盘点）

- **已有**：15 维 `IntentKey`、`DirectorIntent`、`interviewLog`、执行轨迹 `TraceSpan`→traces.ndjson、
  审议 `proposals[]` + 采纳回写、`QaVerdict` 多轴分。
- **核心诊断：有执行轨迹、无决策轨迹**。偏好学习须补 L2 `DecisionSpan`（**candidates[] 不能省**）
  + L3 `PreferenceEvent`，episodeId 串联。最强信号：澄清答案被后续导演指令**推翻** = 精准负样本。
- 冷启动不跳步：采集 → 补候选集 → 只读回放 → **离线分析报表（不训练就有收益）** → 训练。
  门槛：报表 ≥50 episode、RM ≥300 样本、DPO ≥1000 偏好对。
