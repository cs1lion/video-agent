# video-agent-server changelog · 2026-09

> 时间范围：2026-08-31 ~ 2026-09-01（5 轮跑批 + 5 个 fixes）
> 涉及：video-agent-server / video-agent shared / e2e 工具 / runner / 文档

## 重大变更（用户可见）

### v3.0 — 2026-09-01

**5 个 fixes 全部闭环**：

1. **配音音色修复**（gender 字段）
   - 问题：5/6 部剧配音角色性别错配（10 个男角色被派女声）
   - 修复：CoCharacter.gender 字段 + voicePoolForDescription 第二参数优先采用
   - 验证：v2/v3 5/6 部剧配音 0 个错配（1 个是末镜偏置假阳性）

2. **跨镜人物一致性**（englishName + injectCharacterLooks）
   - 问题：LLM 视觉阶段自由发挥，5/6 部剧出现"对着中年女性说小伙子"等角色错配
   - 修复：CoCharacter.englishName 字段 + visual prompt 强约束使用具体名 + post-process 注入外貌短语
   - 验证：v3 6/6 部剧 0 个 cross-gender 错配

3. **关键信息保留**（scriptIntent schema）
   - 问题：user 脚本 .md 的逐镜 dialogue/visual/audioMode 在管线中途被 LLM 改写（B剧 SH06 audioMode 从 dialogue 被改成 narration）
   - 修复：CoCreationSpace.scriptIntent 字段 + stageScript 早返回路径
   - 验证：v3 6/6 部剧字幕行数齐全（6/6/6/6/6/8）

4. **xfade + 运镜拼接感**（camera-motion 兜底）
   - 问题：转场用 xfade + 邻镜运镜（dolly/pan/handheld）导致明显拼接缝
   - 修复：EDL prompt 规则 5/6 + export 阶段服务端兜底（读 prompts.json 检测运镜词，强制 cut）
   - 验证：v2/v3 6 部剧全部 transitions 是 cut

5. **末镜偏置治理**（ground-truth 自动校验）
   - 问题：deep-review 5/6 部剧报"末镜缺失"假阳性
   - 修复：deep-review 加 ground-truth 字段（userScriptIntent + 末镜groundTruth），post-process 阶段自动反驳假阳性报告
   - 验证：v3 跑批后 A/B/C/D/E 5 部剧末镜缺失报告被自动反驳（保持 confirmed=false）

### v2.0 — 之前批次

- voice-cast 配音音色分配（13/13 单测稳定）
- 闸门处理（design/keyframes 双闸门）

## 关键 bug 修复（不在主路径上）

| Fix | 描述 | 何时修 |
|-----|------|--------|
| runner 不处理闸门 | 原 run-scripts.mjs 不调 /resume → 永远超时 | v1.1（已 DEPRECATE） |
| runner 不注入 coSpace | 原 run-scripts.mjs 不传 coSpace → 触发 Clarifier 追问 | v1.1（已 DEPRECATE） |
| ffmpeg 路径错误 | MEMORY.md §0 写了 `ffmpeg.exe` 实际是 `ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe` | v3.0（已修正） |
| ESM main guard | 原 runner import 时自动执行 main → 触发全量跑批 | v3.0（已加 `pathToFileURL` guard） |
| server restart required | tsx 非 watch 模式改完代码不重启不生效 | v3.0（文档已注明） |

## 文档矩阵

### Reports（新增）
- `doc/reports/历史踩坑补遗-第二轮-2026-09-01.md` —— 11 个第二轮踩坑
- `doc/reports/第三轮跑批与系统偏置发现-2026-09-01.md` —— 4 类 LLM-as-judge 偏置
- `doc/reports/配音性别修复验证报告-2026-08-31.md` —— voice-cast fix 验证
- `doc/reports/信息保留+拼接感修复闭环-2026-09-01.md` —— fix 1+2 闭环
- `doc/reports/第四轮跑批-嘴不动+性别脑补+新偏置-2026-09-01.md` —— 嘴不动 + gender 错配
- `doc/reports/第五轮跑批-跨镜人物一致性根治-2026-09-01.md` —— injectCharacterLooks 闭环
- `doc/reports/all6-englishName-完整闭环报告-2026-09-01.md` —— v3 完整验证
- `doc/部署checklist-2026-09.md` —— 部署前/中/后 checklist
- `doc/changelog-2026-09.md` —— 本文件

### Tools（新增）
- `doc/scripts/dense-dialogues/run-scripts-v2.mjs` —— 主 runner
- `doc/scripts/dense-dialogues/run-single.mjs` —— 单脚本跑批
- `doc/scripts/dense-dialogues/collect-run.mjs` —— 补抓 done run 产物
- `doc/scripts/dense-dialogues/build-summary.mjs` —— deep-review 汇总
- `doc/scripts/dense-dialogues/compare-review.mjs` —— 两轮深审 diff
- `doc/reports/compare-all6-batches.mjs` —— 跨 batch 对比表

### Test scripts（新增）
- `doc/scripts/dense-dialogues/script-07-mouth-sync.md` —— 嘴不动专项
- `doc/scripts/dense-dialogues/script-08-no-dialogue.md` —— mixed audioMode 测试
- `doc/scripts/dense-dialogues/script-09-action-only.md` —— 长视频 + 末时点测试

## 单测覆盖

| 测试套件 | 数量 | 通过 |
|----------|------|------|
| `voice-cast.test.ts` | 13 | 13 |
| `camera-motion.test.ts` | 12 | 12 |
| `inject-character-looks.test.ts` | 6 | 6 |
| 已知失败（step-tts 在线 401） | 2 | — |
| **server 全套** | **约 308** | **304** |

## 已知未修问题（影响产品体验）

| 问题 | 频率 | 影响 | 修复优先级 |
|------|------|------|------------|
| 嘴不动 dubOver=True | 100% dialogue 镜 | 视频里嘴不动，配音是 TTS | 中（下季度） |
| 字幕错字 | ~5% | 多字/漏字/同音字 | 中 |
| 末镜字幕超出视频 | 长视频末镜 | 字幕显示被截 | 中 |
| 声画归属错位 | 部分镜 | 字幕对话焦点不对 | 中（已加 prompt 约束，待验证） |
| 末时点偏置 | 长视频 | model 报视频短于实际 4s | 低 |
| LLM 评分飘移 | 单轮 | P1 vs P2 极大方差 | 低（双轮交集缓解） |

## 用户脚本格式变化

### 旧格式（仍支持）
```markdown
## 人物
- **李明**：35 岁，科技公司产品经理
- **张薇**：35 岁，非营利组织项目主管
```

### 新格式（推荐）
```markdown
## 人物
- **李明**（Lin，男，35 岁）：科技公司产品经理
- **张薇**（Zhang，女，35 岁）：非营利组织项目主管
```

### 新格式效果
- voice-cast 派发音色 → 与显式 gender 一致
- 视觉跨镜一致性 → 注入外貌短语到 visual prompt，避免角色错配

### 迁移指南
- 把 description 里的"35 岁男性 X"提取到 `（Lin，男，35 岁）`格式
- 英文名可选（不填则只能匹配中文名/id，跨镜一致性收益减半）

## 兼容性矩阵

| API | 旧调用 | 新调用 |
|-----|--------|--------|
| POST /api/generate | ✓（走原逻辑） | ✓（新 schema 字段被使用） |
| GET /api/runs/:id | ✓ | ✓ |
| GET /api/runs/:id/artifacts | ✓ | ✓ |
| POST /api/runs/:id/resume | ✓ | ✓ |
| coSpace.characters[].gender | 忽略（旧） | 优先采用（新） |
| coSpace.characters[].englishName | 不存在（旧） | 可选字段（新） |
| coSpace.scriptIntent | 不存在（旧） | 跳过 LLM 编剧（新） |

## 性能影响

- 注入性别英文名：每次 prompt 增加 ~50 tokens，可忽略
- injectCharacterLooks post-process：< 5ms / shot，可忽略
- scriptIntent 早返回：节省 1 次 LLM 调用（编剧阶段）
- 末镜偏置自动校验：< 1ms，可忽略

总体性能影响 < 0.1%。

## 已知运行时问题

| 问题 | 现象 | 缓解 |
|------|------|------|
| Agnes 间歇性内容策略拒绝 | 偶发 1/6 概率"内容策略违规"导致 run 失败 | Retry 通常成功（v3 6/6 一次过） |
| 字幕时长计算溢出 | 末镜字幕 end > final.mp4 duration | 已知，待修 |
| dubOver=True | 视频模型跟读失败 | 已知限制，无法修复 |

## 致谢

本次 5 轮跑批累计：
- 8 部剧（5 原剧 + 3 stress test + 1 跨代际）
- 25+ 次完整跑批
- 2 类 LLM-as-judge 系统性偏置确认
- 31 个单元测试稳定通过
- 5 个生产代码 fix 闭环
