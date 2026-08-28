# AGENTS.md — video-agent 项目 agent 协作约定

> **所有 AI agent（Claude Code、Cursor、Aider、Cline、workbuddy 自己的会话等）接手本项目前必读。**
>
> 优先级：本文档 > `packages/video-agent-server/docs/dev-log.md` > 架构文档 > 注释 > commit message。

## 必读

1. **`packages/video-agent-server/docs/dev-log.md`** —— 修改设计日志
   - 为什么这么做（vs commit message 的"做了什么"）
   - 当前的"不做"清单
   - 进行中的拆分 / 收尾路线
   - 跨 session 续写：上次的妥协、未做的工作、下次要做的

2. **`packages/video-agent-server/docs/architecture/director-agent.md`** —— Director agent 架构文档
   - 单 agent 论证
   - 工具清单 + 边界
   - "不做的事"列表（多 agent、auto-dispatch 等都已决定不做）

## 工作约定

- **类型不要改**：RunRecord / RunView / TeamEvent / EventLink / RoleId / StageId / ActionId 等是前端硬契约
- **闸门优先于派发**：派发前 4 道闸门（质量底线 / 置信度 / lastActions 去重 / 派发后回灌）已就位
- **测试要稳**：跑测试前用 `npx tsc --noEmit`（不走 incremental），避免增量缓存漏报
- **降级优于阻断**：每个高成本路径都有便宜的备胎

## 工具 / 服务

- **API 服务**：`packages/video-agent-server`，启动 `PORT=8790 npx tsx src/server.ts`
- **前端**：`packages/video-agent-ui`，Vite + React 19 + Tailwind v4
- **Skill 描述**：`packages/video-agent-server/SKILL.md`（已有的 skill 元数据）

## 接续工作时

1. 读 `packages/video-agent-server/docs/dev-log.md` 最后一节
2. 跑 `git log --oneline -20` 看最近 commit
3. 检查 `git status` 看是否有未提交 WIP
4. 决定动作（接着做 vs 收尾 vs 评审）

不要直接动代码——先理解当前方向再下手。
