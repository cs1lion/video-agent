# video-agent 单容器部署镜像（API + UI 静态同源）
#
# 构建上下文 = pi/ 仓库根（config.ts 依赖 packages/coding-agent/examples/... 的 studio adapter）：
#   docker build -t video-agent:latest .      （本目录根，配合 pi/.dockerignore）
#
# 云托管（CloudBase Run）容器需监听注入的 PORT 环境变量（config.ts 已读 process.env.PORT）。
# 运行时环境变量（云托管控制台或 docker run -e 注入，严禁打进镜像）：
#   VIDEO_AGENT_QUOTA_DAILY_SEC / VIDEO_AGENT_AUTO_REPAIR / TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
# LLM/媒体 provider key：.pi-studio/models.json（构建机本地注入，镜像私有；生产建议改挂载/密钥管理）

FROM node:22-bookworm-slim

# ffmpeg/ffprobe：合成层 execFile 直接走 PATH（bookworm 自带 ffmpeg 5.x，覆盖管线所用滤镜）
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app/pi

# 依赖清单先拷（层缓存：源码变更不重装依赖）
# tsconfig.base.json 必须进镜像：UI tsconfig extends 它，vite/rolldown 构建期解析（云端首败根因）
COPY package.json package-lock.json .npmrc tsconfig.json tsconfig.base.json ./
COPY packages ./packages

# npm workspaces 全量安装（含 dev：tsx 运行时 + vite 构建 UI）
RUN npm ci --no-audit --no-fund

# UI 静态构建 → video-agent-ui/dist（server 同源托管）
RUN npm run build --workspace=@earendil-works/pi-video-agent-ui

# workspace 依赖运行时解析 dist（node_modules symlink → packages/*/dist）。
# 上游 vendored 源码存在既有类型错（pi-ai/cloudflare-ai-gateway.ts TS2353，本地复现同错），
# 本地 dist 为可用历史产物——与本地运行形态一致，直接随上下文进镜像（.dockerignore 放行五包）。
# 注意：改 telemetry/ai/agent/coding-agent/tui 源码后，需本地重建 dist 再部署。
#
# ⚠️ 五包缺一不可（2026-08-31 deploy_failed 根因）：config.ts 直接 import studio adapter 源码
#    （coding-agent/examples/extensions/studio/media/adapter.ts），该目录解析到 4 个 workspace 包
#    ——pi-agent-core(agent) / pi-ai(ai) / pi-coding-agent / pi-tui——再加 telemetry 共 5 个。
#    只带 3 个时容器启动即 ERR_MODULE_NOT_FOUND，探针连不上 8080 → deploy_failed。
COPY packages/telemetry/dist packages/telemetry/dist/
COPY packages/ai/dist packages/ai/dist/
COPY packages/agent/dist packages/agent/dist/
COPY packages/coding-agent/dist packages/coding-agent/dist/
COPY packages/tui/dist packages/tui/dist/

# run 存储目录（findStudioRoot 向上探测含 .pi-studio 的祖先目录 → /app/pi）
RUN mkdir -p /app/pi/.pi-studio/video-agent-runs

# 模型与 provider key：构建前从仓库根拷贝（见 deploy/README.md 步骤 2）；
# deploy/models.json 已被 .gitignore 排除，镜像私有勿推公共仓库
COPY deploy/models.json /app/pi/.pi-studio/models.json

WORKDIR /app/pi/packages/video-agent-server

# ⚠️ PORT 必须显式设（2026-08-31 第 6 次 deploy_failed 根因）：
#    config.ts 读 `process.env.PORT ?? 8787`，而云托管**不会自动注入 PORT**——
#    实测容器起来后监听 8787，平台探针打 --port 指定的 8080 → connection refused。
#    Dockerfile 的 ENV 是默认值，控制台若显式配置同名变量则以其为准（docker -e 覆盖 ENV）。
ENV PORT=8080
# 运行期默认值（控制台「环境变量」可覆盖，改这里需重新构建镜像）：
#   VIDEO_AGENT_QUOTA_DAILY_SEC=0 —— 视频模型限时免费期：不限每日秒数，只受 RPM 约束；
#                                    不设则按保守 500s/天记账，会误报配额不足。
#   VIDEO_AGENT_AUTO_REPAIR=1 —— 质检-修复自动闭环。
ENV VIDEO_AGENT_QUOTA_DAILY_SEC=0
ENV VIDEO_AGENT_AUTO_REPAIR=1

EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
