# video-agent

> 台词驱动的 AI 短片生成管线：从一句 brief 自动产出带配音选角、口型对齐、字幕烧录与质检的影视短片。

## 核心架构 (Architecture & Pipeline)

### 7-Stage Director Agent Pipeline

```
[剧本编写] -> [美术设计] -> [分镜规划] -> [关键帧生成] -> [音频合成] -> [视频剪辑] -> [成片导出]
```

单一 Director Agent 编排 7 阶段流式生成管线，精细控制从文字 Prompt 到最终视频渲染全链路。

### 核心特性

- **4 道确认闸门 (Human-in-the-loop)**：在剧本、分镜、关键帧、音频高算力消耗环节插入确认闸门，实时控制 GPU/API 算力成本。
- **音画质检-自动修复闭环 (QA & Auto-Repair Loop)**：多维度音画质量检测（黑屏、口型不对齐、音频撕裂等），自动触发针对性修复尝试并闭环归档。

## 模块划分 (Directory Structure)

- `pi/packages/video-agent`: 核心生成逻辑与 Director Agent 管线引擎
- `pi/packages/video-agent-server`: 服务端 API 与 Director 管线 Server
- `pi/packages/video-agent-ui`: 前端 Visual Studio 交互工作台
- `e2e/`: 端到端自检与 QA 测试套件 (`e2e/selfcheck.mjs`)

## 快速开始 (Quick Start)

### 1. 快速一键演示

```cmd
启动演示.cmd
```

### 2. 命令行与开发模式

```bash
# 启动服务端 (API: 8790)
cd pi/packages/video-agent-server
PORT=8790 npx tsx src/server.ts

# 启动前端 UI (UI: 5200)
cd pi/packages/video-agent-ui
npm run dev

# 运行端到端测试与 QA 自检
npm test
node e2e/selfcheck.mjs
```

### 环境要求
Node 22+, ffmpeg/ffprobe 在 PATH, `.pi-studio/models.json` (模型与 key), `.env.cloudbase` (TCB 凭据)。
