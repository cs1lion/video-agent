# CloudBase 云托管部署 Runbook（video-agent 单容器）

> 首次尝试：2026-08-31，记录见 `doc/deployment/施工报告-部署-cloudbase-2026-08-31.md`。
> 形态：**单容器同源**——Express 同时服务 API（/api/*）与 UI 静态构建（SPA 回退），
> 无 CORS、无跨域配置。镜像基于 node:22-bookworm-slim + ffmpeg。

> ## ⚠️ 部署目标怎么选（2026-09-04 更新）
>
> 现在有**两条并行**的部署路径：
>
> | | CloudBase 云托管（本文件） | 自建云服务器（**推荐**） |
> |---|---|---|
> | 入口 | `video-agent-303977-11-1253451683.sh.run.tcloudbase.com` | `http://49.233.207.18/`（Nginx 80 → 8080） |
> | 脚本 | `tcb cloudrun deploy` / CloudBase 连接器 | **`deploy-to-cvm.sh`** + `nginx-video-agent.conf` |
> | 瓶颈 | **体验版月额度 3000 点，`EnableOverrun=false`，耗尽即停服** | 无配额限制，按月付机器费 |
> | 冷启动 | MinNum=0 时约 30s，需预热协议 | 常驻，无冷启动 |
> | 报告 | `doc/deployment/施工报告-部署-cloudbase-2026-08-31.md` | **`doc/deployment/施工报告-部署-CVM-2026-09-04.md`** |
>
> **2026-09-04 实测：云托管本周期（08-27~09-27）已耗 2908.6 / 3000 点，仅剩 91.4 点。**
> 对外演示一律走自建 CVM。本文件保留作为云托管形态的运维参考。

## 架构

```
CloudBase 云托管（service: video-agent, port 8080）
  └─ 容器：npm ci(全 monorepo) → vite build UI → tsx src/server.ts
       ├─ /api/*        Express API（同现在的 8790）
       ├─ /*            video-agent-ui/dist 静态 + SPA 回退（server.ts 自动启用，dist 存在即生效）
       └─ /app/pi/.pi-studio/video-agent-runs/   run 产物（容器盘，⚠️ 重建即失）
```

本地同源验证（等价行为）：`npm run build -w @earendil-works/pi-video-agent-ui` 后启动 server，
浏览器 `http://localhost:8790/` 应出 UI、`/api/health` 应答 ok（2026-08-31 已验证）。

## 部署步骤

1. **准备 staging**（构建上下文必须干净，OneDrive 里的 node_modules/批次产物不能进包）：
   ```powershell
   $stage = "$env:TEMP\va-deploy-stage"
   robocopy <repo>\pi $stage /E /XD node_modules dist build .git test tests docs video-agent-runs video-agent-uploads .workbuddy /XF "*.test.ts" "*.log"
   Copy-Item <repo>\pi\Dockerfile $stage\            # Dockerfile 必须在上下文根
   Copy-Item <repo>\.pi-studio\models.json $stage\deploy\models.json   # provider key（不入库）
   ```
2. **登录**（非交互，凭据来自 `packages/video-agent-server/.env.cloudbase`，勿回显）：
   ```powershell
   tcb login --apiKeyId $TCB_SECRET_ID --apiKey $TCB_SECRET_KEY
   ```
3. **部署**：
   ```powershell
   # ⚠️ 坑（2026-08-31 实测）：`--force` 只跳过"确认覆盖"，**不跳过"是否灰度部署"交互项**。
   # 不带 stdin 时命令卡在该 prompt，17s 后 EOF 失败（表现为提交未发生、服务无版本）。
   # 解法：管道喂一个换行，选中默认项 No（非灰度，发布成功自动切流）。
   printf '\n' | tcb cloudrun deploy --service-name video-agent --port 8080 --source $stage --force
   ```
   提交后是**云端构建**（`npm ci` 全 monorepo + vite build UI，实测 ~10 分钟）。
   `--wait` 在当前 CLI（3.8.1）下与管道 stdin 组合不可靠，**改用轮询**：
   ```powershell
   tcb cloudrun detail --service-name video-agent | Select-String OnlineVersionInfos -Context 0,5
   ```
   `OnlineVersionInfos` 从 `[]` 变为有版本条目 = 构建成功；超时仍为空则去控制台看构建日志：
   `https://tcb.cloud.tencent.com/dev?envId=<envId>#/platform-run/service/detail?serverName=video-agent&tabId=deploy`
4. **运行时环境变量**（云托管控制台 → 服务设置，或部署后确认）：
   - `VIDEO_AGENT_AUTO_REPAIR=1`（自动质检-修复闭环）
   - `VIDEO_AGENT_QUOTA_DAILY_SEC=0`（免费期不限每日秒数，按 RPM 限流）
   - `TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY`（台词音频托管，同 .env.cloudbase）
   - LLM/媒体 provider key 由镜像内 `/app/pi/.pi-studio/models.json` 提供（见 §限制）

## 已知限制与风险（如实记录）

1. **run 产物易失**：容器盘不持久，实例重建/扩缩后历史 run 丢失。演示可接受；
   常态化需 COS 归档或挂载 CFS（ROADMAP M3）。
2. **~~run 中途被回收~~（2026-09-02 修正：此前说法夸大）**：缩零需**连续 30 分钟无
   「通过域名访问」**（官方规则），而生成任务只要 6–10 分钟，前端轮询/SSE 又都走域名，
   因此中途被缩零的风险很低。真正代价只有冷启动约 30 秒。
   ⚠️ 例外：内网 IP 调用、纯定时任务**不算流量**，会被判无流量而缩零。
3. **models.json 在镜像内**：provider key 打进了私有镜像（CloudBase 镜像仓库不公开）。
4. **⚠️ 额度约束（最需要盯的一项）**：本环境是**体验版，月额度 3000 资源点，
   且 `EnableOverrun=false`（不允许超支）**。1C2G 常驻 = 119 点/小时，
   **全月额度只够常驻约 25 小时**。详见下方 §成本与实例配置。

## 💰 成本与实例配置（MinNum 0 ↔ 1 切换）

### 计费单价（官方价，2026-09-02 用真实账单反推验证吻合）

| 计费项 | 资源点 | 人民币 |
|---|---|---|
| CPU | 55 点/(核×小时) | ¥0.055 |
| 内存 | 32 点/(GiB×小时) | ¥0.032 |
| 外网出流量 | 800 点/GB | ¥0.8 |

1000 点 ≈ ¥1。**1C2G 常驻 = 55 + 64 = 119 点/小时 = 2856 点/天 ≈ ¥2.86/天、¥85.7/月。**

- 查账：`envQuery(action="usage", envId, type=["EKS"])`（用量数据有约 2.5 小时延迟）
- 查额度：`envQuery(action="info", envId)` → `BillingInfo.EnableOverrun`
  （`false` = 不允许超支，额度耗尽即停服）

### 当前状态：MinNum = 0（2026-09-02 09:31 改回）

原因：体验版月额度 3000 点，2026-09-02 09:25 实测本周期已耗 **2532.6 点**
（云托管占 99.6%），常驻只能再撑 1.5–4 小时。**演示期外一律 `MinNum=0`。**

### 切换命令（只传 MinNum，不触发重部署）

**可直接用 CloudBase 连接器改，不用去控制台**（CLI 3.8.1 无 update 子命令）：

```
manageCloudRun(action="updateConfig", serverName="video-agent",
               serverConfig={MinNum: 0}, force=true)          # 0=省钱 / 1=常驻
queryCloudRun(action="detail", detailServerName="video-agent") # 复核 MinNum
```

- 提交后 `status: configUpdating`，约 30s 生效。
- ✅ 返回里 `likelyRedeployFields: []` 表示**不会触发重新部署**——2026-09-02 改 `MinNum=0`
  后在线版本仍是 009，无新部署记录。
- ⚠️ **只传 `{MinNum: n}`**。一旦带上 `Cpu/Mem/Port` 就会触发重新部署，
  哪怕值与现配置完全相同（2026-09-01 传了 `{MinNum:1,Cpu:1,Mem:2,Port:8080}` → 产生 009）。
  区别只是 `BuildId=0`、复用线上镜像、**不重新构建**（~30s vs 4.5min），服务不中断。

### 缩零规则（决定冷启动与费用）

- **连续 30 分钟无「通过域名访问」才缩容到 0**，缩零期间**不产生任何费用**。
- 冷启动：官方称约 30 秒；实测首请求可能 503，10–20s 后恢复 200。
- ⇒ 每次访问后至少再计费 30 分钟（缩零前的保持窗口）。
- ⇒ 6–10 分钟的生成任务**中途被缩零的风险很低**（远小于 30 分钟窗口）。

### 什么时候用哪个

| 场景 | 建议 |
|---|---|
| 平时 / 无人演示 | **`MinNum=0`**（闲置零费用） |
| 演示 / 面试当天 | 提前 30 秒改 **`MinNum=1`**，结束后改回 0 |
| 长期对外服务 | 升级套餐——体验版 3000 点不够常驻 |

## 冷启动预热协议（⚠️ 2026-09-02 起重新生效：已改回 MinNum=0）

`MinNum=0` 时缩零后**首请求返回 503，约 10–20s 后才 200**。**当前配置即 MinNum=0**，
对外发链接前必须按此流程走：

1. **发消息前几分钟先自己访问一次**预热（`/api/health` 与首页各打一次，确认 200）。
2. 消息里**必须写明**「首次打开需等 10 秒左右」——别让人以为链接是坏的。
3. 更好：发完 **10 分钟内再点一次**保温（在缩零窗口内续命）。

索引：`doc/known-issues/坑位速查-面试版.md` A5。
   生产级做法：CFS 挂载或启动时从密钥管理拉取 + 环境变量覆盖（config.ts 已支持
   `VIDEO_AGENT_LLM_*` 覆盖 LLM 三项）。
4. **体验版套餐**：云托管可用但配额受限（CPU/内存/并发），生成长片前先确认套餐上限。
5. **ffmpeg**：镜像用 bookworm 源的 5.x，管线所用滤镜全覆盖；如遇滤镜缺失在 Dockerfile 追加。

## 本地 Docker 构建待办

本机 Docker Desktop 引擎未启动成功（CLI 28.1.1 在，daemon 未就绪），本地镜像验证暂缓；
云端构建即真实构建环境，本地构建非阻塞项。

## CVM 中文字体（视频字幕烧录，必修）

导出把字幕烧进成片时，`ffmpeg.ts` 的 ASS `FontName` 硬编码为 `Microsoft YaHei`
（Windows 字体名）。Ubuntu 默认**没有任何中文字体** → ffmpeg 找不到字形 → 中文字幕烧成方块。
**每次重装/新建 CVM 都必须执行以下两步**，否则字幕复发：

```bash
sudo apt-get install -y fonts-noto-cjk
# fontconfig 别名：把代码里写死的 Microsoft YaHei 解析到已安装的 Noto
sudo tee /etc/fonts/conf.d/99-msyh-alias.conf >/dev/null <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <match target="pattern">
    <test name="family"><string>Microsoft YaHei</string></test>
    <edit name="family" mode="assign" binding="strong"><string>Noto Sans CJK SC</string></edit>
  </match>
</fontconfig>
EOF
sudo fc-cache -f
# 验证：fc-match 'Microsoft YaHei' 应返回 Noto Sans CJK SC
```

网页侧中文方块是另一处独立问题（UI 字体栈缺中文 fallback），修复在
`video-agent-ui/src/index.css` 的 `--font-sans/--font-mono/--font-display`，已随
09-04 提交上线，和服务器字体无关。
