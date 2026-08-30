# C4-smoke · 最小成本冒烟：3 镜 / 480p / 竖屏写实

- 音频形态：`narration`
- runId：`run-mteguirk-18`
- 结论：**PASS**
- 总耗时：567.2s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实竖屏短片：清晨的面馆后厨，老板揉面、下锅、端到窗边第一位客人面前。三镜讲完「一天从一碗面开始」。",
    "keyMessage": "热气升起的时候，一天就开始了。"
  },
  "options": {
    "resolution": "480p",
    "aspectRatio": "9:16",
    "shotCount": 3,
    "clipDurationSec": 4,
    "fps": 24,
    "motionIntensity": "low",
    "detailBoost": false,
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
| script | done | 15.0s |
| visual | done | 120.2s |
| prompts | done | 145.3s |
| keyframes | done | 160.3s |
| clips | done | 516.2s |
| audio | done | 531.2s |
| export | done | 566.3s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T14:20:42.421Z |
| keyframes | resume（确认 3 镜） | 2026-08-29T14:21:22.514Z |

## 成片后的动作

- 无

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（2027KB / 阈值 50KB）
- ✅ 镜头数达标（3 / 期望 ≥3）
- ✅ 片段产物存在（3 段）
- ✅ 关键帧数 ≥ 片段数（3 vs 3）
- ✅ 旁白音轨存在（3 条）
- ✅ 五轴质检有分（综合 98（pass））

### 失败

- 无

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 9 | transitions.json, final.mp4, qa-SH01.jpg, qa-SH02.jpg, qa-SH03.jpg, shot-SH01.mp4, shot-SH02.mp4, shot-SH03.mp4 |
| 02-design | 8 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png, design-scene-SC02.png |
| 03-keyframes | 4 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png |
| 04-clips | 3 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4 |
| 05-audio | 3 | tts-SH01.mp3, tts-SH02.mp3, tts-SH03.mp3 |

成片体积：2027 KB