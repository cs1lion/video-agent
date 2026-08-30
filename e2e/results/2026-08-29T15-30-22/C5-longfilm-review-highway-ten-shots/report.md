# C5-longfilm-review · 《一千公里》· 10 镜长片 + 出图自审 · 写实公路

- 音频形态：`narration`
- runId：`run-mtejn9ek-24`
- 结论：**PASS**
- 总耗时：1551.3s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人公路短片：一位退休长途货车司机最后一次跑车，从装货、出城、服务区独坐、暴雨夜驾、到清晨把车钥匙交给徒弟。十镜讲完一段三十年的公路人生，旁白克制，结尾留白。",
    "keyMessage": "路会记得每一个把它跑完的人。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 10,
    "clipDurationSec": 5,
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
| script | done | 25.1s |
| visual | done | 130.3s |
| prompts | done | 190.4s |
| keyframes | done | 235.5s |
| clips | done | 1332.8s |
| audio | done | 1372.8s |
| export | done | 1473.1s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T15:39:12.580Z |
| keyframes | resume（确认 10 镜） | 2026-08-29T15:40:57.853Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| 设计图自审 | 7 张（fail 0 / warn 0） |
| 关键帧自审 | 10 帧（fail 0 / warn 0） |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（11476KB / 阈值 50KB）
- ✅ 镜头数达标（10 / 期望 ≥10）
- ✅ 片段产物存在（10 段）
- ✅ 关键帧数 ≥ 片段数（10 vs 10）
- ✅ 旁白音轨存在（10 条）
- ✅ 五轴质检有分（综合 87（fail））
- ✅ 设计图自审有结论（7 张）
- ✅ 关键帧自审有结论（10 帧）

### 失败

- 无

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 23 | transitions.json, final.mp4, qa-SH01.jpg, qa-SH02.jpg, qa-SH03.jpg, qa-SH04.jpg, qa-SH05.jpg, qa-SH06.jpg |
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png, design-scene-SC02.png |
| 03-keyframes | 11 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, key-SH06.png, key-SH07.png |
| 04-clips | 10 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4, clip-SH06.mp4, clip-SH07.mp4, clip-SH08.mp4 |
| 05-audio | 10 | tts-SH01.mp3, tts-SH02.mp3, tts-SH03.mp3, tts-SH04.mp3, tts-SH05.mp3, tts-SH06.mp3, tts-SH07.mp3, tts-SH08.mp3 |

成片体积：11476 KB