# video-agent

台词驱动的 AI 短片生成管线：从一句 brief 自动产出带配音选角、口型对齐、字幕烧录与质检的影视短片。单一 Director agent 编排 7 阶段管线（剧本→美术→分镜→关键帧→音频→剪辑→导出），4 道确认闸门控成本，质检-修复自动闭环。

**状态**：服务端 285/285 测试通过 · G 批次十套风格差异化 10/10 PASS（82-88 分）。

## 快速开始

```bash
# 一键演示（API 8790 + UI 5200）
启动演示.cmd

# 开发
cd pi/packages/video-agent-server
PORT=8790 npx tsx src/server.ts
cd pi/packages/video-agent-ui && npm run dev   # http://localhost:5200

# 测试
npm test
node e2e/selfcheck.mjs
```

环境要求：Node 22+、ffmpeg/ffprobe 在 PATH、`.pi-studio/models.json`（模型与 key，不入库）、`.env.cloudbase`（TCB 凭据，不入库）。

## 结构

| 目录 | 说明 |
|---|---|
| `pi/packages/video-agent-server` | 服务端：Director 管线与 API |
| `pi/packages/video-agent-ui` | 前端工作台 |
| `pi/packages/video-agent` | 核心生成逻辑 |
| `e2e/` | 端到端测试、质检与修复闭环 |
| `doc/` | 设计、部署与测试报告 |

## 文档

- `doc/ROADMAP.md` — 规划与验收
- `doc/deployment/` — CloudBase 部署记录
- `doc/reports/` — 批次施工与测试报告
