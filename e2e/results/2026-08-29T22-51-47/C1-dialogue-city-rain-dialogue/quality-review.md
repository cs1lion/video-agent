# C1-dialogue 质量评审报告（重做）

- 用例：C1-dialogue · 《雨夜末班》· 台词驱动 · 写实都市
- runId：`run-mtez6cnf-31`
- 测试结论：**FAIL**（台词镜 = 0，audioDrive 降级为旁白，重做后仍失败）
- 评审时间：2026-08-29

## 1. 测试结果摘要

| 指标 | 结果 |
|------|------|
| 管线状态 | done |
| 阶段完成 | 7/7 |
| 成片体积 | 6480 KB |
| 镜头数 | 5 / 期望 ≥5 |
| 片段数 | 5 |
| 关键帧数 | 5 |
| 旁白音轨 | 5 条 |
| 质检综合 | 97（pass） |
| 台词镜 | **0（FAIL，重做后仍失败）** |

## 2. 产物完整性检查

### 02-design（美术设计）
- ✅ visual-bible.json
- ✅ design-bible.json
- ✅ design-character-CH01.png（老周）
- ✅ design-character-CH02_v1.png、design-character-CH02.png（周小雨，有 v1）
- ✅ design-prop-PR01.png、design-prop-PR02.png
- ✅ design-scene-SC01.png
- **状态**：齐备，有重绘历史

### 03-keyframes（关键帧）
- ✅ keyframes.json
- ✅ key-SH01.png ~ key-SH05.png（5 镜）
- **状态**：齐备

### 04-clips（片段）
- ✅ clip-SH01.mp4 ~ clip-SH05.mp4（5 段）
- **状态**：齐备

### 05-audio（音频）
- ✅ tts-SH01.mp3 ~ tts-SH05.mp3（5 条旁白）
- ⚠️ 无 dialogue 形态音频
- **状态**：旁白齐备，台词驱动仍降级

### 06-export（导出）
- ✅ final.mp4（6480 KB）
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

### 关键发现：重做后仍失败
- 第一次运行（run-mteh786o-19）：台词镜 = 0
- 第二次运行（run-mtez6cnf-31）：台词镜 = 0
- 说明这不是偶发问题，而是系统性 bug

### 可能根因
1. **A1 闸门逻辑**：audioDrive=dialogue 时可能强制降级
2. **coSpace 传递**：对话角色配置未正确传递给音频阶段
3. **服务端 bug**：台词镜生成逻辑有缺陷

### 音频质量
- 5 条 TTS 旁白音轨正常生成
- 质检 97 分（pass）
- **评分**：7/10（模式未生效）

## 4. 整体质量评分

**3/10**（重做后仍 FAIL）

## 5. 改进建议

1. **修复 dialogue 模式**：需检查服务端代码，audioDrive=dialogue 时应生成台词镜而非旁白
2. **增加调试日志**：在 audio 阶段输出 dialogueShotCount 计算过程
3. **单元测试**：为 dialogue 模式添加专门测试
