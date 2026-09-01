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
2. **实例缩零**：10 分钟生成途中若实例被回收，run 中断。演示期把实例数下限设 1（常驻）。

## ⚠️ 冷启动预热协议（把链接发给别人之前必做）

`MinNum=0` → 缩零后**首请求返回 503，约 10–20s 后才 200**。对外发链接前按此流程走：

1. **发消息前几分钟先自己访问一次**预热（`/api/health` 与首页各打一次，确认 200）。
2. 消息里**必须写明**「首次打开需等 10 秒左右」——别让人以为链接是坏的。
3. 更好：发完 **10 分钟内再点一次**保温（在缩零窗口内续命）。

**长期解法**：控制台 → 云托管 → 服务设置 → **实例数下限改为 1**（常驻）。
CLI 3.8.1 无 update 子命令，只能控制台改。

索引：`doc/known-issues/坑位速查-面试版.md` A5。
3. **models.json 在镜像内**：provider key 打进了私有镜像（CloudBase 镜像仓库不公开）。
   生产级做法：CFS 挂载或启动时从密钥管理拉取 + 环境变量覆盖（config.ts 已支持
   `VIDEO_AGENT_LLM_*` 覆盖 LLM 三项）。
4. **体验版套餐**：云托管可用但配额受限（CPU/内存/并发），生成长片前先确认套餐上限。
5. **ffmpeg**：镜像用 bookworm 源的 5.x，管线所用滤镜全覆盖；如遇滤镜缺失在 Dockerfile 追加。

## 本地 Docker 构建待办

本机 Docker Desktop 引擎未启动成功（CLI 28.1.1 在，daemon 未就绪），本地镜像验证暂缓；
云端构建即真实构建环境，本地构建非阻塞项。
