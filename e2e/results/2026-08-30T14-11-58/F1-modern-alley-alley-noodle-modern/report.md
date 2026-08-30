# F1-modern-alley · 《深巷面馆》· 现代中国都市 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtfw1qb6-1`
- 结论：**PASS**
- 总耗时：322.1s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人剧情短片：现代中国某城市的深夜深巷面馆。两句旁白开场与收尾（交代这条巷子二十年只卖一碗面），中间是老板与刚收车的女代驾司机小周的一来一往对白——「还是老位置？」「老位置，多加一勺辣」。旁白与对白交织，讲一碗面的默契。",
    "keyMessage": "深巷里的灯，为晚归的人留着。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 3,
    "clipDurationSec": 5,
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
        "name": "老板",
        "description": "55 岁男性面馆老板，花白寸头，深灰色毛线背心配白毛巾搭肩，袖口卷起"
      },
      {
        "name": "小周",
        "description": "28 岁女性代驾司机，短黑发，深蓝色代驾反光背心，说话利落"
      }
    ],
    "scenes": [
      {
        "name": "深巷面馆",
        "description": "写实深夜小面馆：暖黄灯泡、瓷砖墙、灶台蒸汽、窗边两张旧方桌"
      }
    ],
    "musicBrief": "无音乐，只留灶台蒸汽与巷子夜声。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 30.1s |
| visual | done | 135.3s |
| prompts | done | 165.4s |
| keyframes | done | 180.4s |
| audio | done | 195.5s |
| clips | done | 260.6s |
| export | done | 320.8s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T14:14:14.303Z |
| keyframes | resume（确认 3 镜） | 2026-08-30T14:14:59.410Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.565,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":15,"wastedSec":0,"completedClips":3,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 老板 | shenchennanyin |
| 小周 | jingdiannvsheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（2942KB / 阈值 50KB）
- ✅ 镜头数达标（3 / 期望 ≥3）
- ✅ 片段产物存在（3 段）
- ✅ 关键帧数 ≥ 片段数（3 vs 3）
- ✅ TTS 音轨存在（台词/旁白）（5 条）
- ✅ 台词镜存在（2 镜）
- ✅ 质检有分（综合 85（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 92 / 文字 95）
- ✅ 字幕结构审核通过（3 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [shenchennanyin, jingdiannvsheng]）
- ✅ 角色音色互不相同（2/2（shenchennanyin, jingdiannvsheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 90 |
| pacing | 92 |
| physicalAccuracy | 95 |
| characterConsistency | 92 |
| audioSync | 33 |
| textQuality | 95 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：3 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 6 | voice-cast.json, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-SH01.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 12 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 11 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01.png |
| 03-keyframes | 4 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png |
| 04-clips | 3 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4 |

成片体积：2942 KB