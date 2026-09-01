# CloudBase 云托管部署 Runbook（video-agent 单容器）

> 首次尝试：2026-08-31，记录见 `doc/deployment/施工报告-部署-cloudbase-2026-08-31.md`。
> 形态：**单容器同源**——Express 同时服务 API（/api/*）与 UI 静态构建（SPA 回退），
> 无 CORS、无跨域配置。镜像基于 node:22-bookworm-slim + ffmpeg。

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
2. **run 中途被回收**：生成任务约 10 分钟，实例若被回收则 run 中断。
   2026-09-01 已把 `MinNum` 设为 1（常驻），此项风险已解除。
3. **models.json 在镜像内**：provider key 打进了私有镜像（CloudBase 镜像仓库不公开）。
4. **常驻实例计费**：`MinNum=1` 后即使无请求也常驻 1 个实例（1C2G），按运行时长计费。
   长期不演示时改回 0 即可（见下方命令）。

## ✅ 常驻实例配置（MinNum=1，2026-09-01 已生效）

**可直接用 CloudBase 连接器改，不用去控制台**（CLI 3.8.1 无 update 子命令）：

```
manageCloudRun(action="updateConfig", serverName="video-agent",
               serverConfig={MinNum:1, MaxNum:5, Cpu:1, Mem:2, Port:8080,
                             OpenAccessTypes:["OA","PUBLIC","MINIAPP"]}, force=true)
queryCloudRun(action="detail", detailServerName="video-agent")   # 复核 MinNum
```

- 提交后 `status: configUpdating`，约 30s 生效；`detail` 里 `MinNum` 变 1 即成功。
- ⚠️ `Cpu/Mem/Port` 属于 `likelyRedeployFields`：**只要传了这几个字段就会触发一次重新部署**，
  哪怕传的值与现配置完全相同。2026-09-01 实测：传了 `{MinNum:1,Cpu:1,Mem:2,Port:8080}`
  后产生了 009 部署记录。
  - 好消息：`BuildId=0`（直接复用 008 镜像，**不重新构建**，约 30s 而非 4.5 分钟），
    状态 `normal`、流量 100%，服务**未中断**（health 200 / 0.2s）。
  - **最干净的做法：`serverConfig` 里只传 `{MinNum: n}`，其余字段一个都别带。**
- 生效后实测：连续 4 次请求全部 HTTP 200、耗时 0.15–0.19s，**无冷启动**。

## 冷启动预热协议（历史，MinNum=1 后已不需要；作兜底保留）

`MinNum=0` 时缩零后**首请求返回 503，约 10–20s 后才 200**。若因成本改回 0，对外发链接前
按此流程走：

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
