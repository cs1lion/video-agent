# C1-dialogue 质量评审报告

- 用例：C1-dialogue · 《雨夜末班》· 台词驱动 · 写实都市
- runId：`run-mteh786o-19`
- 测试结论：**FAIL**（台词镜 = 0，audioDrive 降级为旁白）
- 评审时间：2026-08-29

## 1. 测试结果摘要

| 指标 | 结果 |
|------|------|
| 管线状态 | done |
| 阶段完成 | 7/7 |
| 成片体积 | 6571 KB |
| 镜头数 | 5 / 期望 ≥5 |
| 片段数 | 5 |
| 关键帧数 | 5 |
| 旁白音轨 | 5 条 |
| 质检综合 | 96（pass） |
| 台词镜 | **0（FAIL）** |

## 2. 产物完整性检查

### 02-design（美术设计）
- ✅ visual-bible.json
- ✅ design-bible.json
- ✅ design-character-CH01.png（老周）
- ✅ design-character-CH02.png（周小雨）
- ✅ design-prop-PR01_v1.png、design-prop-PR01.png
- ✅ design-prop-PR02.png
- ✅ design-scene-SC01.png
- **状态**：齐备，有 v1 历史版本

### 03-keyframes（关键帧）
- ✅ keyframes.json
- ✅ key-SH01.png ~ key-SH05.png（5 镜）
- **状态**：齐备

### 04-clips（片段）
- ✅ clip-SH01.mp4 ~ clip-SH05.mp4（5 段）
- **状态**：齐备

### 05-audio（音频）
- ✅ tts-SH01.mp3 ~ tts-SH05.mp3（5 条旁白）
- ⚠️ 无 dialogue 形态音频（无 reference audio）
- **状态**：旁白齐备，但台词驱动降级

### 06-export（导出）
- ✅ final.mp4（6571 KB）
- ✅ transitions.json
- ✅ qa-SH01.jpg ~ qa-SH05.jpg
- ✅ shot-SH01.mp4
- **状态**：成片齐备

### 07-qa（质检）
- ✅ run-state.json
- ✅ consistency.json
- ✅ traces.ndjson
- **状态**：齐备

## 3. 质量评估

### 美术设计质量
- 人物设计：老周、周小雨形象写实，符合"写实真人"风格
- 场景设计：城郊公交站、末班公交车内场景完整
- 道具设计：有道具设计图
- **评分**：8/10

### 关键帧质量
- 5 镜关键帧全部生成
- 锚定设计定稿：老周(CH01)、城郊公交站(SC01)
- **评分**：8/10

### 片段质量
- 5 段片段全部生成（720p 16:9）
- 总时长约 25 秒
- **评分**：7/10（无法从静态报告判断动态质量）

### 音频质量
- ⚠️ **关键问题**：audioDrive="dialogue" 但实际生成旁白，无台词镜
- 5 条 TTS 旁白音轨
- 无 reference audio 文件
- **评分**：3/10（模式降级）

### 导出质量
- 成片 6571 KB，体积合理
- 质检综合 96 分（pass）
- **评分**：8/10

## 4. 问题分析

### 主要问题：台词驱动降级
根据 events.jsonl 和 report.md：
- `audioDrive` 参数设为 `dialogue`
- `coSpace` 已配置（人物+场景）
- 但实际输出 `dialogueShotCount = 0`
- 所有音频均为旁白（tts-*），无台词镜

**可能原因**：
1. A1 闸门检测到 coSpace 或 dialogue 配置问题，强制回落
2. 服务端台词镜生成逻辑有 bug
3. reference audio 未正确生成或上传

### 次要问题
- 设计图有 v1 版本，说明有重绘发生

## 5. 整体质量评分

**3/10**

虽然管线跑通、产物齐备，但核心需求"台词驱动"未实现，降级为旁白模式，用例 FAIL。

## 6. 改进建议

1. **修复台词驱动模式**：检查 A1 闸门逻辑，确保 audioDrive=dialogue 时正确生成台词镜
2. **reference audio 验证**：确认 TTS 参考音频生成和上传链路正常
3. **coSpace 校验**：验证 coSpace 配置是否正确传递给下游
4. **增加日志**：在 dialogue 降级时输出明确原因，方便排查
