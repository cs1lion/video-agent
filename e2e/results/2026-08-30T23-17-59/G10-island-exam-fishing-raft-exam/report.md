# G10-island-exam · 《渔排上的考试》· 海岛日常 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtgips84-20`
- 结论：**PASS**
- 总耗时：588.1s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实海岛短片：南海渔排上，初三女孩海花在网箱边的木板屋里上网课，台风预警让回岛的渡轮停航——班主任林老师冒雨坐渔船把试卷送到渔排。师生在摇晃的渔排上完成一场特殊的考试，父亲在旁默默收网。三句旁白交代台风与海，对白带着海风味。写实海上渔排：浮桶、木板屋、渔网与浮标、雨点打在海面。",
    "keyMessage": "浪再大，课不能停。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 5,
    "clipDurationSec": 6,
    "fps": 24,
    "motionIntensity": "medium",
    "detailBoost": true,
    "promptLanguage": "zh",
    "negativePrompt": "anime, cartoon, illustration, 3d render, cgi plastic skin, painting, watermark, garbled text, on-screen captions, UI overlays, debug frames, low resolution, blur, distorted face, asymmetric eyes, distorted hands, extra fingers, morphing objects",
    "audioDrive": "dialogue"
  },
  "coSpace": {
    "characters": [
      {
        "name": "海花",
        "description": "14 岁女性渔家女孩，黑色马尾配旧红发绳，校服外套罩着防雨塑料布，膝上摊着试卷"
      },
      {
        "name": "林老师",
        "description": "36 岁女性班主任，短发别耳，深蓝色雨衣滴水，怀里抱着用塑料袋裹了三层的试卷袋"
      }
    ],
    "scenes": [
      {
        "name": "海上渔排",
        "description": "写实南海渔排：浮桶木板屋、渔网浮标、远处避风港船影、雨点砸在海面起白点"
      }
    ],
    "musicBrief": "雨打渔排声与远处海浪。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 45.1s |
| visual | done | 155.3s |
| prompts | done | 180.4s |
| keyframes | done | 205.5s |
| audio | done | 225.6s |
| clips | done | 471.2s |
| export | done | 586.5s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-31T00:49:08.096Z |
| keyframes | resume（确认 5 镜） | 2026-08-31T00:49:58.257Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.513,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":30,"wastedSec":0,"completedClips":5,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 海花 | qingchunshaonv |
| 林老师 | jingdiannvsheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（5834KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 86（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 95 / 文字 95）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [qingchunshaonv, jingdiannvsheng]）
- ✅ 角色音色互不相同（2/2（qingchunshaonv, jingdiannvsheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 90 |
| pacing | 92 |
| physicalAccuracy | 95 |
| characterConsistency | 95 |
| audioSync | 40 |
| textQuality | 95 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 9 | voice-cast.json, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH04-pad.mp3, tts-dialogue-SH04.mp3, tts-SH01.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 18 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 11 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-character-CH03.png, design-prop-PR01_v1.png, design-prop-PR01.png, design-prop-PR02.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：5834 KB