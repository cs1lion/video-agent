# G6-wuxia-inn · 《大漠客栈打烊》· 武侠意境 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtgh2784-16`
- 结论：**PASS**
- 总耗时：603.0s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实武侠意境短片：大漠边关的小客栈打烊夜。掌柜的秋娘收拾碗筷，多年不走的老镖头秦无边坐在角落喝闷酒——他说这是最后一次走镖回来，刀已经锈在鞘里了。秋娘给他温了壶酒，说刀锈了人才睡得着。三句旁白交代风沙与驼铃，对白古意简淡，意境苍凉无打斗。写实地貌：黄土墙、油灯、酒坛、门外沙丘月色。",
    "keyMessage": "刀锈了，人就该歇了。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 5,
    "clipDurationSec": 6,
    "fps": 24,
    "motionIntensity": "low",
    "detailBoost": true,
    "promptLanguage": "zh",
    "negativePrompt": "anime, cartoon, illustration, 3d render, cgi plastic skin, painting, watermark, garbled text, on-screen captions, UI overlays, debug frames, low resolution, blur, distorted face, asymmetric eyes, distorted hands, extra fingers, morphing objects",
    "audioDrive": "dialogue"
  },
  "coSpace": {
    "characters": [
      {
        "name": "秋娘",
        "description": "48 岁女性客栈掌柜，靛蓝布衣配深色围裙，发髻插木簪，眼角细纹，擦碗的手不停"
      },
      {
        "name": "秦无边",
        "description": "60 岁男性老镖头，深灰色旧布袍，花白长须，腰间一柄锈鞘长刀，指节粗大"
      }
    ],
    "scenes": [
      {
        "name": "大漠客栈",
        "description": "写实大漠客栈夜：黄土墙、油灯如豆、粗瓷酒坛、木桌木凳、门外沙丘与月色"
      }
    ],
    "musicBrief": "风沙声与远处驼铃，极简。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 60.1s |
| visual | done | 150.3s |
| prompts | done | 200.4s |
| keyframes | done | 230.5s |
| audio | done | 245.6s |
| clips | done | 385.9s |
| export | done | 601.3s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-31T00:02:43.140Z |
| keyframes | resume（确认 5 镜） | 2026-08-31T00:04:03.339Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.601,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":35,"wastedSec":0,"completedClips":6,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 秋娘 | jingdiannvsheng |
| 秦无边 | shenchennanyin |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（6631KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 87（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 95 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [jingdiannvsheng, shenchennanyin]）
- ✅ 角色音色互不相同（2/2（jingdiannvsheng, shenchennanyin））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 92 |
| visualConsistency | 95 |
| pacing | 90 |
| physicalAccuracy | 95 |
| characterConsistency | 95 |
| audioSync | 40 |
| textQuality | 100 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 9 | voice-cast.json, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH04-pad.mp3, tts-dialogue-SH04.mp3, tts-SH01.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 18 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03_v1.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：6631 KB