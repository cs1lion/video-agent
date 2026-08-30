# C6-redo-chain · 《最后一剪》· 重做链路（补拍/重录/组合出片）· 写实理发店

- 音频形态：`narration`
- runId：`run-mtemyxwj-29`
- 结论：**FAIL**
- 总耗时：911.7s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人短片：老城区一家开了三十年的理发店，老板最后一次为老街坊剃头、擦镜子、摘下转灯。旁白平静，讲一门手艺的谢幕。",
    "keyMessage": "有些门关上，是因为它已经完成了。"
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
| script | done | 25.1s |
| visual | done | 155.4s |
| prompts | done | 180.4s |
| keyframes | done | 200.5s |
| clips | done | 761.6s |
| audio | done | 786.7s |
| export | done | 861.9s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T17:12:41.491Z |
| keyframes | resume（确认 5 镜） | 2026-08-29T17:13:26.630Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| 补拍镜头 | SH04 |
| 重录旁白 | SH01 |
| 组合出片 | 1 次 |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（3764KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（4 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 4）
- ✅ 旁白音轨存在（5 条）
- ✅ 五轴质检有分（综合 90（pass））
- ✅ 补拍产生历史版本（1 个 _v1）
- ✅ 补拍动作已派发

### 失败

- ❌ 组合出片产出交付版（无）

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 07-qa | 4 | run-state.json, consistency.json, traces.ndjson, cuts.json |
| 06-export | 19 | transitions.json, cut1-shot-SH01.mp4, cut1-shot-SH02.mp4, cut1-shot-SH03.mp4, cut1-shot-SH04.mp4, cut1-shot-SH05.mp4, cut1-subs.ass, final.mp4 |
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01.png, design-scene-SC02_v1.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04_v1.mp4, clip-SH05.mp4 |
| 08-assets | 1 | cut1.mp4 |
| 05-audio | 6 | tts-SH01_v1.mp3, tts-SH01.mp3, tts-SH02.mp3, tts-SH03.mp3, tts-SH04.mp3, tts-SH05.mp3 |

成片体积：3764 KB