# C3-bgm-only · 《空城六分钟》· 纯音乐无旁白 · 写实城市空镜

- 音频形态：`bgm`
- runId：`run-mteihuxx-22`
- 结论：**PASS**
- 总耗时：1519.9s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实空镜短片：清晨五点半的城市，全片没有人物对白、也没有旁白解说，只有街道、蒸汽、第一班地铁与天光渐亮。用六个镜头的推进讲一座城市从沉睡到醒来的完整过程，情绪完全靠画面与背景音乐完成。",
    "keyMessage": "城市醒来时，没有人为它配音。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 6,
    "clipDurationSec": 4,
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
| script | done | 20.1s |
| visual | done | 100.2s |
| prompts | done | 155.3s |
| keyframes | done | 275.5s |
| clips | done | 1412.9s |
| audio | done | 1422.9s |
| export | done | 1518.1s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T15:06:31.138Z |
| keyframes | resume（确认 6 镜） | 2026-08-29T15:09:26.480Z |

## 成片后的动作

- 无

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（8186KB / 阈值 50KB）
- ✅ 镜头数达标（6 / 期望 ≥6）
- ✅ 片段产物存在（6 段）
- ✅ 关键帧数 ≥ 片段数（6 vs 6）
- ✅ BGM 已入时间线
- ✅ 五轴质检有分（综合 72（pass））

### 失败

- 无

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 15 | transitions.json, final.mp4, qa-SH01.jpg, qa-SH02.jpg, qa-SH03.jpg, qa-SH04.jpg, qa-SH05.jpg, qa-SH06.jpg |
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01.png, design-scene-SC02.png |
| 03-keyframes | 7 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, key-SH06.png |
| 05-audio | 1 | bgm.wav |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4, clip-SH06.mp4 |

成片体积：8186 KB