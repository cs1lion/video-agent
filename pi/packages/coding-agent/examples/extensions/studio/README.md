# pi-studio — 视频工作室多 Agent 系统

一句话需求 → 成片交付。主 Agent（工作室总控）统筹 10 个专业角色（进程内 pi 会话）沿制作管线协作，媒体模型（生图/TTS/视频/审校视觉）经统一队列限流接入，审校角色按创意简报把关每个质量门。

```
用户（一句话需求） ⇄ 总控 Studio Lead（主 Agent）
                       │ studio_plan / studio_dispatch / studio_review / studio_progress
                       ├─ 消息总线（角色间直接通信）
                       ├─ 黑板（风格·角色设定等共享事实）
                       └─ 产物登记表（各阶段产物 + 质量状态）
                              │
            艺术总监·编剧·概念设计师·导演·分镜设计师·制片·后期·音效师·审校·剪辑师
                              │ studio_media（经生成队列：并发上限/重试）
                       阶跃生图 · 阶跃 TTS · Agnes 视频 · Step 3.7 Flash 视觉审校
```

## 安装

```bash
# 1. 符号链接本扩展到 pi 扩展目录（Windows 用 mklink /D，管理员权限）
ln -s <repo>/packages/coding-agent/examples/extensions/studio ~/.pi/agent/extensions/studio

# 2. 剪辑师拼接成片需要 ffmpeg（可选，但强烈建议）
ffmpeg -version
```

无需构建：扩展以 TypeScript 源码运行（pi 直接加载 `index.ts`），已被仓库 `npm run check` 类型检查覆盖。

## 配置媒体模型

在工作目录（运行 pi 的目录）放置 `.pi-studio/models.json`：

```jsonc
{
  "media": [
    {
      "id": "step-image",              // 生图（概念图/首帧参考）
      "kind": "image",
      "type": "openai-compatible",
      "baseUrl": "https://api.stepfun.com",
      "path": "/v1/images/generations",
      "model": "step-image-edit-2",
      "apiKey": "<KEY>",               // 或 "apiKeyEnv": "STEP_API_KEY"
      "concurrency": 2,
      "defaultParams": { "response_format": "b64_json", "size": "768x1360" }
    },
    {
      "id": "step-tts",                // 配音
      "kind": "tts",
      "type": "openai-compatible",
      "baseUrl": "https://api.stepfun.com",
      "path": "/v1/audio/speech",
      "model": "stepaudio-2.5-tts",
      "voice": "cixingnansheng",
      "apiKey": "<KEY>"
    },
    {
      "id": "agnes-video",             // 镜头视频（异步任务+轮询）
      "kind": "video",
      "type": "openai-compatible",
      "baseUrl": "https://apihub.agnes-ai.com",
      "path": "/v1/videos",
      "model": "agnes-video-v2.0",
      "apiKey": "<KEY>",
      "concurrency": 2,                // Agnes 繁忙时限并发
      "defaultParams": { "width": 1280, "height": 720, "frame_rate": 24 },
      "poll": {
        "taskIdPath": "video_id",
        "statusUrl": "https://apihub.agnes-ai.com/agnesapi?video_id={{taskId}}",
        "statusPath": "status",
        "doneValues": ["completed"],
        "failedValues": ["failed", "error"],
        "resultPath": "url",
        "intervalMs": 10000,
        "maxPolls": 90
      }
    }
  ],
  "vision": {                          // 审校用的多模态描述模型（可选）
    "url": "https://api.stepfun.com/v1/chat/completions",
    "model": "step-3.7-flash",
    "apiKey": "<KEY>"
  },
  "defaults": { "concurrency": 2, "maxAttempts": 2, "priority": 5 }
}
```

- `type` 目前支持 `openai-compatible` 与 `custom-http`（自定义请求/响应模板，见 `media/custom-http.ts`）。
- 文本模型（总控与各角色）走 pi 原生 `~/.pi/agent/models.json`；角色可用角色 Markdown 的 frontmatter `model:` 绑定特定模型，未绑定时继承主会话模型。
- `poll` 块用于异步任务型 API：创建任务 → 轮询 `statusUrl` → 从 `resultPath` 取结果 URL 并下载。
- 未配置的媒体类型：对应 `studio_media` 调用会返回明确错误，文本类管线（剧本/美术设计/分镜）不受影响。

## 使用

```bash
cd <你的工作目录>   # .pi-studio/ 所在处
pi
```

| 操作 | 效果 |
|---|---|
| `/studio 一支8-10秒的冰红茶广告片` | 一键开机制片：总控解读需求→建计划→分波次调度→质量门→交付 |
| `/studio` | 打开任务板（管线进度 / 产物墙含质量状态 / 消息流 / 各角色实时活动） |
| 直接对话（如"帮我做个产品宣传片"） | 总控协议自动生效，同样进入制作流程 |

制作产物落盘 `.pi-studio/<projectId>/`：

```
.pi-studio/<projectId>/
├── project.json      # 项目元数据 + 任务 DAG
├── artifacts.json    # 产物登记表（状态: submitted/approved/rejected）
├── blackboard.json   # 共享事实（风格关键词、角色设定…）
├── messages.jsonl    # 消息总线（追加式）
├── media-queue.json  # 生成队列断点续作状态
└── assets/           # 剧本.md、visual-bible.md、分镜表、镜头mp4、配音mp3、成片
```

## 角色阵容

| 阶段 | 角色 | 产物 |
|---|---|---|
| 创意 | 艺术总监 | 创意简报（全流程基准） |
| | 编剧 | 剧本+台词 |
| 视觉 | 概念设计师 | 美术设计+各镜首帧参考图 |
| | 导演 | 镜头阐述 |
| | 分镜设计师 | 分镜表 |
| 生成 | 制片 | 生成队列调度（并发/优先级/失败重排） |
| 音频 | 后期 | 台词配音（TTS） |
| | 音效/混音师 | 配乐/音效/混音 |
| 质量门 | 审校 | approved/rejected+意见（媒体产物经视觉模型转文字描述后审） |
| 交付 | 剪辑师 | ffmpeg 拼接/字幕→成片+制作报告 |

角色定义见 `roles/*.md`（frontmatter：`name/label/tools/model`，正文为角色系统提示）。可自行增删——`roles/` 目录即角色注册表。

## 工具参考

**总控**：`studio_plan`（建项目+任务DAG）、`studio_dispatch`（派任务：parallel/chain 波次）、`studio_review`（LLM+视觉审校，rejected 自动重开任务）、`studio_progress`、`studio_messages`、`studio_resume`、`studio_list_roles`

**子 Agent 共享**：`studio_task_update`、`studio_messages`（收发）、`studio_blackboard`（读写）、`studio_artifacts`（提交/查询）、`studio_media`（generate 经队列，产物自动登记）、`studio_project_info`

## 验证

```bash
# 媒体层冒烟测试（真实调用生图/TTS/视觉审校/视频）
npx tsx examples/extensions/studio/smoke.ts <工作区根目录>

# 类型检查（仓库根目录）
npm run check
```

设计文档见 [docs/studio-design.md](docs/studio-design.md)。
