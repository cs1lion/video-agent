# C6-redo-chain 质量评审报告

- 用例：C6-redo-chain · 《最后一剪》· 重做链路（补拍/重录/组合出片）· 写实理发店
- runId：`run-mtemyxwj-29`
- 测试结论：**FAIL**（cut-N.mp4 放置于 08-assets，未在 06-export）
- 评审时间：2026-08-29

## 1. 测试结果摘要

| 指标 | 结果 |
|------|------|
| 管线状态 | done |
| 阶段完成 | 7/7 |
| 成片体积 | 3764 KB |
| 镜头数 | 5 / 期望 ≥5 |
| 片段数 | 4（含 1 个 _v1） |
| 关键帧数 | 5 |
| 旁白音轨 | 5 条（含 1 个 _v1） |
| 质检综合 | 90（pass） |
| 补拍版本 | 1 个 _v1 |
| 组合出片 | 1 次 |

## 2. 产物完整性检查

### 02-design（美术设计）
- ✅ visual-bible.json
- ✅ design-bible.json
- ✅ design-character-CH01.png
- ✅ design-prop-PR01.png、design-prop-PR02.png、design-prop-PR03.png
- ✅ design-scene-SC01.png
- ✅ design-scene-SC02_v1.png（重绘版本）
- **状态**：齐备，有重绘历史

### 03-keyframes（关键帧）
- ✅ keyframes.json
- ✅ key-SH01.png ~ key-SH05.png（5 镜）
- **状态**：齐备

### 04-clips（片段）
- ✅ clip-SH01.mp4 ~ clip-SH05.mp4（5 段）
- ✅ clip-SH04_v1.mp4（补拍历史版本）
- **状态**：齐备，有版本化

### 05-audio（音频）
- ✅ tts-SH01.mp3 ~ tts-SH05.mp3（5 条）
- ✅ tts-SH01_v1.mp3（重录历史版本）
- **状态**：齐备，有版本化

### 06-export（导出）
- ✅ final.mp4（3764 KB）
- ✅ transitions.json
- ✅ cut1-shot-SH01.mp4 ~ cut1-shot-SH05.mp4（5 段）
- ✅ cut1-subs.ass
- ❌ **cut1.mp4 缺失**（组合出片主文件）
- **状态**：部分缺失

### 08-assets（兜底目录）
- ✅ cut1.mp4（组合出片主文件）
- **状态**：文件存在，但位置错误

### 07-qa（质检）
- ✅ run-state.json
- ✅ consistency.json
- ✅ traces.ndjson
- ✅ cuts.json
- **状态**：齐备

## 3. 质量评估

### 重做链路执行
1. **补拍**：SH04 补拍成功，产生 clip-SH04_v1.mp4
2. **重录**：SH01 旁白重录成功，产生 tts-SH01_v1.mp3
3. **组合出片**：执行成功，但 cut1.mp4 放入 08-assets 而非 06-export
- **评分**：7/10

### 版本化检查
- ✅ clip-SH04_v1.mp4 存在
- ✅ tts-SH01_v1.mp3 存在
- ✅ design-scene-SC02_v1.png 存在
- **评分**：9/10

### 导出质量
- 成片 3764 KB
- 质检综合 90 分（pass）
- cut1-shot-* 文件齐备
- **评分**：7/10

## 4. 问题

### 主要问题：cut1.mp4 位置错误
- cut1.mp4 被放入 08-assets/
- 期望位置：06-export/
- 导致断言 `requireComposeCut` 失败

### 可能原因
1. collect.mjs 的 bucketOf() 函数未正确识别 cut-N.mp4
2. 服务端生成 cut1.mp4 时路径处理有误

## 5. 整体质量评分

**7/10**

重做链路执行成功，版本化正常，但组合出片文件归档位置错误导致用例 FAIL。

## 6. 改进建议

1. **修复归档逻辑**：修改 collect.mjs 的 bucketOf()，确保 cut-N.mp4 归入 06-export/
2. **验证 cut1.mp4**：确认 cut1.mp4 是否为有效视频文件
3. **增强断言**：在 report.mjs 中同时检查 06-export 和 08-assets 的 cut 文件
