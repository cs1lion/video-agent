# ROADMAP · video-agent 中长期目标（2026-08-31 立项）

> 来源：《doc/methodology/方法论小结-LLM审阅意见驱动优化-2026-08-31.md》§二。
> 立项约定：每项目标有「验收标准」——做到什么程度算完成，避免"做了"和"做好了"混淆。
> 排期原则：小成本确定性修复优先；生产行为变更需整批重验；模型上限类问题只记录不硬修。

## 已完成基线（2026-08-31）

- 台词链路根本性修复 + G 批次十套 10/10 回归（82-88 分）
- 质检-修复自动闭环：fail 路径 4 片实证；warn 路径 category 结构化驱动
- 深审评审稳定化：严重度校准 + 双轮取交集（误修率下降实证）
- audioSync 口径修正（全语音镜语音就绪率）；测试 285/285
- CloudBase 台词音频托管（COS 公开 URL，2026-08-29 实测定案）
- 演示就绪包（一键启动 + 动线 + 兜底成片）

## 近期（本迭代内）

### N1 · 词级时间戳字幕
- 官方支持确凿：TTS `timestamp: true`，硬约束 `return_url=true` 或 `stream_format="sse"`
  （否则 400）；`items[].start/end_time` 已累加前序切句；对齐失败 items 可能为空须容错。
- 对接点：dialogue-audio TTS 请求加参数 → 时间轴落盘 → export 字幕起止改用实测词时间
  （叠加现有三重收束做保险）。dubOver 镜只改善「字幕↔人声」，不解决「口型↔人声」。
- **验收**：台词镜字幕起止与实测人声段偏差 ≤0.2s（抽帧+时长对比）；现有 285 测试不回归。

## 中期（下一个迭代）

### M1 · 深审按需化
- 双轮交集是 2× 视觉调用的固定成本；改为「首轮 QA 出现 warn/fail 才触发」，
  深审从每批必跑变成闭环的二次确认器，成本跟着风险走。
- **验收**：全 ok 批次零深审调用；含问题批次深审自动跑且 confirmed 进修复清单。

### M2 · 审阅-修复配对数据沉淀（RLHF 数据层第一块砖）
- 闭环触发时自动存三元组：（问题意见, 组装的 instruction, 复审前后 verdict）→
  `doc/decisions/` 之外新增配对数据落盘（ndjson 追加）。
- **验收**：任一闭环触发批次产出配对记录；字段可回放触发现场（decision-trace.md Phase ①
  的数据源就绪）。

### M3 · 云端常态化运行
- CloudBase 云托管部署（2026-08-31 完成《施工报告-部署-cloudbase-2026-08-31.md》）→
  下一步：实例常驻策略验证（10 分钟生成不被缩零打断）、run 产物持久化方案
  （COS 归档 vs 本地盘）、密钥全部环境变量化（models.json 出镜像）。
- **验收**：外部访问者从公网提交 brief → 闸门确认 → 拿到成片与质检报告，全程不碰部署机。

## 长期（方向性）

### L1 · 决策轨迹（decision-trace.md Phase ①，待批准实施）
- L2 trace：deliberation 决策点落 decisions.ndjson；PreferenceRecord V2；episode.json。
- 状态：方案已定稿待批准（见 `pi/packages/video-agent-server/docs/architecture/decision-trace.md`）。

### L2 · 从"修片"到"修偏好"（质量闭环 × RLHF 合流）
- 闭环留痕（意见→动作→结果）结构上已接近 preference pair；deliberation 侧已有
  PreferenceRecord。Phase ① 批准后两条线在数据层合流——审阅意见驱动的每次优化
  同时是一条偏好训练样本。
- **验收**：一批真实运行产出可训练的偏好数据集（≥100 条配对记录，字段完整可回放）。

## 明确不做（维持）

- ASR 字错率报告（额度 402 风险，双关卡已覆盖核心职责）
- 音色复刻（无真人样本，选角系统已覆盖需求）
- 多 agent 协作 / auto-dispatch 默认开启 / directorChat 升级 ReAct / 读视频模型进管线
  （director-agent.md「不做」清单）
