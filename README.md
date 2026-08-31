# video-agent · 台词驱动的 AI 短片生成管线

从一句 brief 出发，全自动产出带配音选角、口型对齐、字幕烧录与七轴质检的影视短片；
单一 Director agent 编排 7 阶段管线（剧本→美术→分镜→关键帧→音频→剪辑→导出），
4 道确认闸门控成本，质检-修复自动闭环提质量。

**当前基线**：服务端 285/285 测试 · G 批次十套风格差异化 10/10 PASS（82-88 分）·
台词链路 dubOver 双关卡 · 质检-修复自动闭环 · 双轮深审取交集 · CloudBase 音频托管。

## 快速开始

```bash
# 演示（面试/展示）：一键起 API 8790 + UI 5200，含端口预检
启动演示.cmd

# 开发
cd pi/packages/video-agent-server
PORT=8790 VIDEO_AGENT_QUOTA_DAILY_SEC=0 VIDEO_AGENT_AUTO_REPAIR=1 npx tsx src/server.ts
cd pi/packages/video-agent-ui && npm run dev     # http://localhost:5200

# 测试 / e2e
npm test                       # 285/285
node e2e/selfcheck.mjs         # 离线自检
node e2e/run-e2e.mjs --only=G1-comedy-designated-driver   # 单片端到端
node e2e/deep-review.mjs e2e/results/<批次目录>           # 整片双轮深审
```

环境要求：Node 22+、ffmpeg/ffprobe 在 PATH、`.pi-studio/models.json`（模型与 key，不入库）、
`.env.cloudbase`（TCB 凭据，音频托管，不入库）。

## 文档索引（doc/）

| 目录 | 内容 |
|---|---|
| `doc/ROADMAP.md` | 中长期目标立项（近期/中期/长期 + 验收标准 + 不做清单） |
| `doc/HANDOFF-2026-08-31.md` | 项目交接总览：已完成/进行中/待办三层 + 坑位提示 |
| `doc/reports/` | 批次施工与测试报告（台词链路修复 / 闭环收尾 / audioSync+category / 评审 / 前端） |
| `doc/decisions/` | 决策记录（四项提案核实等） |
| `doc/methodology/` | 方法论沉淀（LLM 审阅意见驱动优化六条收获与三级方向） |
| `doc/demo/` | 演示动线（面试官版：动线/弹药/兜底/话术） |
| `doc/deployment/` | 部署（CloudBase 云托管：方案/记录/限制） |
| `pi/packages/video-agent-server/docs/` | 服务端 dev-log（修改设计日志）+ architecture/（director-agent 等） |
| `e2e/迭代优化日志-多轮对话压力轮.md` | R1-R4 迭代循环日志 |

> 历史说明：2026-08-31 文档结构整理，根目录报告全部迁入 `doc/`（git mv 保历史）。

## 部署

单容器形态（API + UI 静态同源）：见 `doc/deployment/` 与 `deploy/`（Dockerfile / .dockerignore /
云托管配置）。CloudBase 凭据与模型 key 一律走环境变量/不入库文件，严禁提交。

**线上（2026-08-31 已验证）**：`https://video-agent-303977-11-1253451683.sh.run.tcloudbase.com`
`/api/health` → `{"ok":true}`、`/` → SPA `AD://FORGE`。
部署共 7 次提交、前 6 次失败的根因与修复见 `doc/deployment/施工报告-部署-cloudbase-2026-08-31.md`
（缺 5 个 workspace dist、云托管不注入 PORT）。
⚠️ 演示期请把云托管实例数下限设为 **1**（控制台），否则 MinNum=0 缩零：首请求冷启动 503 + 生成中途可能被回收中断。
