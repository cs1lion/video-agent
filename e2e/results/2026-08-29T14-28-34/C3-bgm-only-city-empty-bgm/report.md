# C3-bgm-only · 《空城六分钟》· 纯音乐无旁白 · 写实城市空镜

- 音频形态：`bgm`
- runId：`run-mtehzn97-21`
- 结论：**FAIL**
- 总耗时：843.0s

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
| visual | done | 95.2s |
| prompts | done | 130.4s |
| keyframes | done | 155.4s |
| clips | running | 842.7s |
| audio | pending | 842.7s |
| export | pending | 842.7s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T14:52:16.416Z |
| keyframes | resume（确认 6 镜） | 2026-08-29T14:53:16.610Z |

## 断言

### 通过

- ✅ 镜头数达标（6 / 期望 ≥6）
- ✅ 片段产物存在（1 段）
- ✅ 关键帧数 ≥ 片段数（6 vs 1）
- ✅ BGM 已入时间线

### 失败

- ❌ 管线状态 done（实际 cancelled）
- ❌ 全部阶段 done（4/7）
- ❌ 成片已归档
- ❌ 成片体积达标（0KB / 阈值 50KB）
- ❌ 缺少质检结论（verdict）

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 1 | script.json |
| 07-qa | 2 | run-state.json, traces.ndjson |
| 02-design | 8 | visual-bible.json, design-bible.json, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01.png, design-scene-SC02.png, design-scene-SC03.png |
| 03-keyframes | 7 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, key-SH06.png |
| 05-audio | 1 | bgm.wav |
| 04-clips | 1 | clip-SH01.mp4 |

成片体积：0 KB