# C2-narration · 《开海》· 旁白叙事 · 写实渔村

- 音频形态：`narration`
- runId：`run-mtez6csi-32`
- 结论：**PASS**
- 总耗时：1512.9s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人纪录风短片：天没亮的渔港，一位老渔妇独自解开缆绳、检查网眼、发动马达，小船驶出防波堤时太阳正好从海平面抬起来。全片无人物台词，由一段克制的男声旁白串起她三十年的出海日常——讲「重复本身是一种勇气」。",
    "keyMessage": "日复一日，也是一种远航。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 5,
    "clipDurationSec": 5,
    "fps": 24,
    "motionIntensity": "low",
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
| script | done | 15.0s |
| visual | done | 125.3s |
| prompts | done | 175.4s |
| keyframes | done | 210.5s |
| clips | done | 1357.7s |
| audio | done | 1377.8s |
| export | done | 1478.0s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T22:53:52.695Z |
| keyframes | resume（确认 5 镜） | 2026-08-29T22:55:17.895Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| 关键帧自审 | 5 帧（fail 0 / warn 0） |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（6208KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ 旁白音轨存在（5 条）
- ✅ 五轴质检有分（综合 94（pass））

### 失败

- 无

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 13 | transitions.json, final.mp4, qa-SH01.jpg, qa-SH02.jpg, qa-SH03.jpg, qa-SH04.jpg, qa-SH05.jpg, shot-SH01.mp4 |
| 02-design | 8 | visual-bible.json, design-bible.json, design-character-CH01.png, design-prop-PR01.png, design-prop-PR02_v1.png, design-prop-PR02.png, design-scene-SC01.png, design-scene-SC02.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |
| 05-audio | 5 | tts-SH01.mp3, tts-SH02.mp3, tts-SH03.mp3, tts-SH04.mp3, tts-SH05.mp3 |

成片体积：6208 KB