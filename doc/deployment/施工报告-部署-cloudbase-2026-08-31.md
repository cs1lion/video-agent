# 施工报告 · CloudBase 云托管部署（video-agent 单容器同源）

**日期**：2026-08-31
**环境**：`myagent-d0glujkt6c30cbe8a`（ap-shanghai，体验版）
**服务**：`video-agent`，对外域名 `https://video-agent-303977-11-1253451683.sh.run.tcloudbase.com`
**形态**：单容器同源（Express 同时服务 `/api/*` 与 `video-agent-ui/dist` 静态 + SPA 回退），容器端口 8080。

## 结论

✅ **部署成功，线上已验证可用**：
- `/api/health` → `{"ok":true,"features":["kitchen","kitchen-snapshot","priority","budget-alerts","metrics"]}`
- `/` → 返回 SPA `AD://FORGE — 视频广告工作台`，JS/CSS 同源加载
- 前后端无 CORS、无跨域，单端口闭环

⚠️ **遗留 1 项需人工（控制台）**：`MinNum=0`，实例会缩零，首请求冷启动返回 503（约 10–20s 后变 200），且生成任务进行中若被回收会中断。演示期建议把**最小实例数设为 1（常驻）**（云托管控制台 → 服务设置 → 实例数下限；CLI 3.8.1 无 update 命令，只能控制台改）。

## 部署时间线（7 次提交，前 6 次全失败）

| # | 时间 | 状态 | 根因 |
|---|---|---|---|
| 001 | 12:47 | build_failed | 早期镜像构建失败（上下文/依赖问题） |
| 002 | 12:54 | deploy_failed | 容器启动失败 |
| 003 | 13:07 | build_failed | 构建失败 |
| 004 | 13:12 | deploy_failed | 容器启动失败 |
| 005 | 13:32 | deploy_failed | **缺 `coding-agent/dist`** → `ERR_MODULE_NOT_FOUND`，探针连不上 8080 |
| 006 | 13:45 | deploy_failed | **缺 `tui/dist`**（同因）+ **PORT 未注入**（监听 8787，探针打 8080） |
| **007** | **13:57** | **normal ✅（流量 100%）** | 补齐 5 个 dist + `ENV PORT=8080` 后成功 |

## 两个根因（已修复，写入 Dockerfile / .dockerignore）

### 根因 A：workspace 依赖的 dist 缺失（`.dockerignore` 排除过狠）

`config.ts` 直接 `import` studio adapter 源码
（`coding-agent/examples/extensions/studio/media/adapter.ts`），该目录解析到 4 个 workspace 包：
`@earendil-works/pi-agent-core`(agent) / `pi-ai` / `pi-coding-agent` / `pi-tui`，
再加传递依赖 `telemetry` —— **共 5 个 dist 缺一不可**。

旧的 `.dockerignore` 只放行 `telemetry/ai/agent` 三个，且 Dockerfile 只 COPY 这三者。
容器起来后 `ERR_MODULE_NOT_FOUND: .../coding-agent/dist/index.js`，server 未监听 → 探针 `connection refused` → deploy_failed。

**修复**：`.dockerignore` 与 Dockerfile 各放行并 COPY 全部 5 个 dist。
（本地 dist 为上游 vendored 源码已验证的历史产物；上游有既有类型错，镜像不重建它们。）

### 根因 B：云托管不注入 PORT，server 回退 8787

`config.ts`：`port: Number(process.env.PORT ?? 8787)`。实测云托管**不会向容器注入 PORT**，
所以即使 `tcb cloudrun deploy --port 8080`，容器内仍监听 8787，平台探针按 8080 探 → `connection refused`。

**修复**：Dockerfile 显式 `ENV PORT=8080`（默认值；控制台配置同名变量可覆盖）。
同时把运行期默认值 ENV 进去：`VIDEO_AGENT_QUOTA_DAILY_SEC=0`（限时免费期不限每日秒数）、
`VIDEO_AGENT_AUTO_REPAIR=1`（质检-修复自动闭环）。

## 部署命令的两个坑（已写入 deploy/README.md）

1. **`--force` 不跳过"是否灰度部署"交互项**：不带 stdin 时卡在该 prompt，17s 后 EOF 失败、
   提交未发生。解法：`printf '\n' | tcb cloudrun deploy ... --force`（喂换行选中默认 No=非灰度自动切流）。
2. **`--wait` 与管道 stdin 组合不可靠**：改用提交后轮询
   `tcb cloudrun detail`（`OnlineVersionInfos` 从 `[]` 变有条目即成功）+
   `tcb cloudrun logs process --run-id <id>`（看启动日志/探针失败原因）。

## 构建上下文准备

```powershell
$stage = "$env:TEMP\va-deploy-stage"
# 排除 node_modules/dist(除五包例外)/build/.git/test/docs/运行数据/.workbuddy 后 robocopy pi/ 根
# 单独补 packages/{telemetry,ai,agent,coding-agent,tui}/dist
# deploy/models.json（provider key，镜像私有，不入 git）
# 19M → 补 dist 后 32M
```

本机 Docker daemon 未启动，全程**云端构建**（每次 ~4.5 分钟：`npm ci` 全 monorepo + vite build UI）。

## 已知限制（复述，详见 deploy/README.md §已知限制）

1. 实例缩零（MinNum=0）：已确认，待控制台改 1。
2. run 产物易失：容器盘 `/app/pi/.pi-studio/video-agent-runs`，重建即失（演示可接受）。
3. models.json 在镜像内：provider key 打进私有镜像；生产级改 CFS 挂载/密钥管理拉取。
4. 体验版套餐配额受限（CPU/内存/并发）。

## 验证口径（线上实测，非文档声称）

- API：`curl -m 30 https://video-agent-303977-11-1253451683.sh.run.tcloudbase.com/api/health`
  → `{"ok":true,"features":["kitchen",...]}`
- UI：`curl https://.../ ` → `<title>AD://FORGE — 视频广告工作台</title>` +
  `<script src="/assets/index-DQU9fZgg.js">`（同源 SPA 托管生效）
- 同源：GET `/api/` 返回 404（API 路由正确拦截，未吞掉静态回退）
