# C7-producer-multiformat 质量评审报告

- 用例：C7-producer-multiformat · 《夜市收摊》· 制片主任 + 多画幅分发 · 写实夜市
- runId：`run-mteniss3-30`
- 测试结论：**FAIL**（kitchenObserve/kitchenApply 返回 404）
- 评审时间：2026-08-29

## 1. 测试结果摘要

| 指标 | 结果 |
|------|------|
| 管线状态 | done |
| 阶段完成 | 7/7 |
| 成片体积 | 4700 KB |
| 镜头数 | 5 / 期望 ≥5 |
| 片段数 | 5 |
| 关键帧数 | 5 |
| 旁白音轨 | 5 条 |
| BGM | bgm.wav |
| 质检综合 | 82（pass） |
| 竖屏重导出 | final-9x16.mp4 |
| kitchenObserve | HTTP 404 |
| kitchenApply | HTTP 404 |

## 2. 产物完整性检查

### 02-design（美术设计）
- ✅ visual-bible.json
- ✅ design-bible.json
- ✅ design-character-CH01.png
- ✅ design-prop-PR01.png、design-prop-PR02.png、design-prop-PR03.png
- ✅ design-scene-SC01.png、design-scene-SC01_v1.png
- **状态**：齐备

### 03-keyframes（关键帧）
- ✅ keyframes.json
- ✅ key-SH01.png ~ key-SH05.png（5 镜）
- **状态**：齐备

### 04-clips（片段）
- ✅ clip-SH01.mp4 ~ clip-SH05.mp4（5 段）
- **状态**：齐备

### 05-audio（音频）
- ✅ tts-SH01.mp3 ~ tts-SH05.mp3（5 条）
- ✅ bgm.wav（BGM）
- **状态**：齐备，BGM 已入

### 06-export（导出）
- ✅ final.mp4（4700 KB）
- ✅ final-9x16.mp4（竖屏版本）
- ✅ transitions.json
- ✅ qa-SH01.jpg ~ qa-SH05.jpg
- **状态**：齐备，多画幅导出成功

### 07-qa（质检）
- ✅ run-state.json
- ✅ consistency.json
- ✅ traces.ndjson
- **状态**：齐备

## 3. 质量评估

### 多画幅导出
- ✅ 16:9 版本：final.mp4
- ✅ 9:16 版本：final-9x16.mp4
- **评分**：10/10

### BGM 集成
- ✅ bgm.wav 已生成并入时间线
- **评分**：9/10

### 制片主任功能
- ❌ kitchenObserve：HTTP 404
- ❌ kitchenApply：HTTP 404
- **评分**：0/10（功能不可用）

### 导出质量
- 成片 4700 KB
- 质检综合 82 分（pass）
- **评分**：8/10

## 4. 问题分析

### kitchenObserve/kitchenApply 404
根据 report.md：
- 两个端点均返回 HTTP 404 Not Found
- 可能原因：
  1. 服务端未注册这些路由
  2. 服务版本过旧，不支持 B2/B3 功能
  3. 路由路径不匹配

### 验证
之前检查确认现有服务（8787）的 server.ts 包含 kitchen/observe 和 kitchen/apply 路由，但实际调用返回 404，可能是：
- 服务未重启加载新代码
- 路由注册条件不满足
- 环境差异

## 5. 整体质量评分

**6/10**

多画幅导出成功，但制片主任功能完全不可用，导致核心功能 FAIL。

## 6. 改进建议

1. **修复 kitchen 路由**：确认服务端是否正确加载了 producer.ts 和 kitchen 相关路由
2. **服务重启**：如果修改了代码，确保服务重启
3. **端点验证**：在 e2e 脚本中增加服务端能力探测，提前发现 404
4. **降级处理**：如果 kitchen 功能不可用，可降级为跳过该断言
