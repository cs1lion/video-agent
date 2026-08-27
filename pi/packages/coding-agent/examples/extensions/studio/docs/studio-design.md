# pi-studio 设计文档

## 1. 系统架构

```
用户（视频小白，一句话需求 + 创意基调）
  ⇅
总控 Studio Lead（主 Agent，交互式 pi 会话）
  规划统筹 │ 进度跟踪 │ 质量门控 │ 与用户对话
  │
  ├─ 制作计划（任务 DAG）→ 分波次调度子 Agent（并发上限）
  ├─ 消息总线（网型协作：子 Agent 间可直接收发消息）
  ├─ 黑板（项目共享事实：风格 / 角色设定 / 约束）
  ├─ 产物登记表（每阶段产物 + 质量状态 + 审校意见）
  │
  └─ 子 Agent ×10（进程内 createAgentSession 会话，角色 Markdown 定义）
       各自携带：角色工具白名单 + 共享协作工具 + 媒体生成工具（经队列）
```

**关键决策：**

| 决策 | 选择 | 理由 |
|---|---|---|
| 子 Agent 形态 | 进程内 SDK 会话（`createAgentSession`），非子进程 | 共享同一 `StudioContext` 内存态与生成队列；事件流可直接进 TUI；无 IPC 开销 |
| 协作拓扑 | 网型（消息总线 + 黑板） | 编剧可直接问艺术总监风格问题，不必经总控中转；总控仍保留全量消息可见性 |
| 状态持久化 | `.pi-studio/<projectId>/` 原子文件镜像（tmp+rename） | 断点续作（`studio_resume`）；人可直接查看产物；media-queue.json 支持生成任务续跑 |
| 主 Agent 角色 | 总控协议经 `before_agent_start` 注入系统提示 | 主 Agent 保持通用编码能力，仅在有 studio 工具被启用时注入制片协议 |

## 2. 模块结构

```
studio/
├── index.ts               # 扩展入口：运行时装配、工具注册、/studio 命令、总控协议注入
├── roles.ts               # 角色发现：解析 roles/*.md（frontmatter + 系统提示正文）
├── core/
│   ├── types.ts           # Project/Task/Artifact/Message/Role/事件与用量类型
│   ├── studio-context.ts  # 项目上下文：任务 DAG / 产物登记 / 消息总线 / 黑板 + 文件镜像
│   └── session-runner.ts  # 子 Agent 会话工厂 + 运行器（事件流 / abort / 用量统计）
├── media/
│   ├── adapter.ts         # 适配器接口 + models.json 加载/校验
│   ├── openai-compatible.ts  # OpenAI 兼容请求（含异步任务轮询 poll 配置）
│   ├── custom-http.ts     # 自定义 HTTP 模板适配器（请求/响应 JSON 模板）
│   ├── vision.ts          # 审校用多模态描述客户端（图片→base64 / 视频·音频→URL）
│   └── queue.ts           # 生成队列：每适配器并发上限 / 优先级 / 重试 / 断点续作
├── tools/
│   ├── control-tools.ts   # 总控：plan / dispatch / review / progress / resume / messages
│   └── role-shared-tools.ts # 子 Agent：任务更新 / 收发消息 / 黑板 / 产物 / 媒体生成
├── ui/studio-board.ts     # /studio 任务板：管线进度 / 产物墙（质量状态）/ 消息流
├── roles/                 # 10 个角色定义 Markdown
├── prompts/studio.md      # /studio <需求> 一键开机制片模板
└── smoke.ts               # 媒体层真实调用冒烟测试
```

## 3. 制作管线与质量门

任务 DAG 按 9 个阶段推进（`core/types.ts` `PipelineStage`）：

```
brief ─→ script ─→ visual ─→ direction ─→ storyboard ─→ shots ─→ audio ─→ edit ─→ delivery
创意简报   剧本     美术设计    镜头阐述      分镜表       镜头视频   配音配乐  剪辑    交付
```

**调度模型**（`studio_dispatch`）：
- `single` / `parallel`（并发上限内同批执行）/ `chain`（顺序执行，任务说明中 `{previous}` 占位符注入上一步汇报，用于流水线交接）
- 分派前置校验：任务状态 ∈ {pending, reopened, failed} 且依赖已 completed
- 子 Agent 结束时若任务仍为 running（角色未自行更新），运行器按会话成败落终态

**质量闭环**（`studio_review`）：

```
任务定义验收标准 → 角色提交产物(submitted) → 总控派 reviewer 会话审校
  ├─ 文本产物：reviewer 用 read 工具直读文件
  ├─ 媒体产物：先经视觉模型(如 step-3.7-flash)生成「实地查看描述」注入审校提示
  ├─ 审校输出 JSON verdicts（approved / rejected + 具体意见）
  ├─ approved → 产物过审，下游任务解锁
  └─ rejected → 产物标记驳回 + 产出任务自动重开(reopened)，重派时反馈附在任务上
```

关键质量门：剧本、美术设计、分镜表、每批镜头视频、成片。

**LLM 审校媒体产物的实现**：审校会话本身是文本角色，不具备看图能力。`control-tools.ts` 在派审前用 `media/vision.ts` 把每个媒体产物（图片 base64 / 视频音频走 sourceUrl）交给多模态模型，产出「视觉审校描述」（画面是否命中创意、镜头要素是否齐全），作为 reviewer 的主要判断依据注入提示词。视觉模型未配置时降级为仅文本摘要审校。

## 4. 角色与协作协议

角色 = `roles/*.md`（frontmatter：`name`/`label`/`description`/`tools` 白名单/`model` 绑定；正文为角色系统提示）。删除/新增文件即调整阵容。

每个子 Agent 会话的系统提示 = 角色正文 + 通用协作协议（`session-runner.ts`）：

1. 开工先收信（`studio_messages` read）+ 读黑板（`studio_blackboard` list）+ 读任务引用的上游产物文件
2. `studio_task_update` 维护任务状态（running → completed/failed/blocked + 一句话结论）
3. 成果必须 `studio_artifacts`（submit）登记，未登记不进审校与交付
4. 跨角色问题直接 `studio_messages`（post）点对点沟通；重要结论写黑板
5. 媒体生成只能走 `studio_media`（generate）——制片队列统一限流，产物自动登记
6. 收尾输出给总控的简要汇报

## 5. 媒体模型接入

`.pi-studio/models.json`（工作目录级）：

- `media[]`：每个适配器声明 `kind`（image/tts/video/music）、`type`（openai-compatible / custom-http）、端点、密钥（`apiKey` 或 `apiKeyEnv`）、`concurrency`、`defaultParams`、`timeoutMs`
- 异步任务型 API 用 `poll` 块描述：`taskIdPath`（创建响应取任务 id）→ 轮询 `statusUrl`（`{{taskId}}` 模板替换）→ `statusPath` 判态 → `resultPath` 取结果 URL 下载
- `vision`：审校用多模态模型（OpenAI chat/completions 兼容）
- `bindings`：角色 ↔ 媒体适配器绑定（缺省按 kind 匹配第一个可用适配器）

**生成队列**（`media/queue.ts`）：按适配器并发上限（如 Agnes=2）调度；优先级排序（制片角色可设）；失败按 `maxAttempts` 重试；队列状态镜像 `media-queue.json` 支持续作。子 Agent 的 `studio_media` 调用阻塞等待结果，产物连同 `sourceUrl` 自动登记（供视觉审校取源）。

### 5.1 限流与重试策略（模型限制 / 系统繁忙）

适配器与队列联合实现「可重试错误退避重试 + 429 自适应降并发 + 全程跟踪」：

- **错误分类**（`adapter.ts` 的 `MediaHttpError` / `isRetryableError`）：HTTP 408/429/5xx 与网络瞬断（超时/ECONNRESET/fetch failed 等）归为可重试；参数错误（4xx）、鉴权失败、响应形状异常立即失败，不浪费重试次数。用户中止（AbortError）永不重试。
- **退避重试**：可重试错误按指数退避（3s 起步、60s 封顶）加随机抖动重试至 `defaults.maxAttempts`（默认 4）；响应携带 `Retry-After` 头时优先采用服务端建议的等待时间。
- **429 自适应降并发（熔断）**：某适配器触发 429 时，队列立即把该适配器的有效并发降到当前在飞数以下（最低 0），冷却 60s 后恢复配置值；冷却期内再次 429 则冷却时间翻倍（上限 5 分钟），成功一次即重置冷却。冷却到期自动唤醒队列，无需人工干预。
- **全局并发上限**：`defaults.globalConcurrency`（默认 8）限制所有适配器合计在飞请求数，避免多适配器同时打满出口。
- **轮询容错**：视频等异步任务的轮询端点遇瞬态 429/5xx 时先就地重试（连续 5 次才放弃），避免整个几分钟的生成任务因单次轮询抖动作废。
- **全程跟踪**：每个任务记录 `attemptLog`（每次尝试的起止时间、错误、可重试分类、退避时长）与排队等待时长；队列级 `stats()` 汇总每适配器的成功/失败/重试/429 次数、平均生成耗时与当前并发状态。角色经 `studio_media(status)` 可随时查看，失败汇报自动附尝试历史。



**一致性策略**：概念设计师为每镜产出首帧参考图（生图便宜），分镜表引用首帧；镜头视频生成提示词携带美术设计的锚定描述，减少跨镜头漂移。

## 6. 进度呈现

- 子会话事件流（工具调用/输出/用量）→ dispatch 工具 `onUpdate` → TUI 实时渲染各角色动态
- `state.activities` 保存每角色最新活动 → `/studio` 任务板（管线各阶段任务状态、产物墙含质量徽章、消息流、角色实时活动）
- 非 TUI 模式（print/json）：`studio_progress` 工具返回纯文本总览

## 7. 已知限制

- 音频（配音/混音）目前经适配器生成，混音合成依赖剪辑师的 ffmpeg 工具链；ffmpeg 缺失时剪辑任务会失败并汇报
- 子 Agent 会话为内存态（一次性）；项目状态靠文件镜像跨会话恢复，会话内对话历史不持久
- 视频生成为外部异步任务，单镜头最长约 18s（模型 441 帧上限）；超时长广告需多镜头拼接
