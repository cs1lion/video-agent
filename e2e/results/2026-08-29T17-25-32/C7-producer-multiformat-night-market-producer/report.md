# C7-producer-multiformat · 《夜市收摊》· 制片主任 + 多画幅分发 · 写实夜市

- 音频形态：`narration`
- runId：`run-mteniss3-30`
- 结论：**FAIL**
- 总耗时：788.5s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人短片：凌晨一点的夜市，摊主收摊、洗刷、熄灯，最后推着车走进巷子。旁白只有三句，讲一个城市背面的人如何结束一天。",
    "keyMessage": "城市睡着前，有人在替它收拾。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 5,
    "clipDurationSec": 4,
    "fps": 24,
    "motionIntensity": "medium",
    "detailBoost": true,
    "promptLanguage": "zh",
    "negativePrompt": "anime, cartoon, illustration, 3d render, cgi plastic skin, painting, watermark, garbled text, on-screen captions, UI overlays, debug frames, low resolution, blur, distorted face, asymmetric eyes, distorted hands, extra fingers, morphing objects",
    "audioDrive": "off"
  },
  "coSpace": null
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 20.0s |
| visual | done | 140.3s |
| prompts | done | 170.4s |
| keyframes | done | 190.4s |
| clips | done | 621.4s |
| audio | done | 641.4s |
| export | done | 701.6s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T17:27:53.116Z |
| keyframes | resume（确认 5 镜） | 2026-08-29T17:28:43.236Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| 多画幅重导出 | 9:16:done |
| 动作留痕 | kitchenObserve: HTTP 404: Not Found |
| 动作留痕 | kitchenApply: HTTP 404: Not Found |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（4700KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ 旁白音轨存在（5 条）
- ✅ BGM 已入时间线
- ✅ 五轴质检有分（综合 82（pass））
- ✅ 竖屏分发版已导出（final-9x16.mp4）
- ✅ 注意：动作留痕 kitchenObserve: HTTP 404: Not Found
- ✅ 注意：动作留痕 kitchenApply: HTTP 404: Not Found

### 失败

- ❌ 制片主任观察可用（0 条建议）

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 14 | transitions.json, final-9x16.mp4, final.mp4, qa-SH01.jpg, qa-SH02.jpg, qa-SH03.jpg, qa-SH04.jpg, qa-SH05.jpg |
| 02-design | 10 | visual-bible.json, design-bible.json, design-character-CH01.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01_v1.png, design-scene-SC01.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 05-audio | 6 | bgm.wav, tts-SH01.mp3, tts-SH02.mp3, tts-SH03.mp3, tts-SH04.mp3, tts-SH05.mp3 |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：4700 KB