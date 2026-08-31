# G9-frontier-post · 《帕米尔邮路》· 边疆 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtgib2oo-19`
- 结论：**PASS**
- 总耗时：683.3s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实边疆短片：帕米尔高原的邮路上，马背邮递员艾力和哨所年轻士兵小杨在垭口相遇——小杨等家里的包裹等了两个月，艾力把最上层的信递给他：大学的录取通知书到了。两句旁白交代海拔与风，对白朴实，讲一条邮路串起的牵挂。写实高原：雪峰、经幡、马蹄踏雪、邮包上的冰碴。",
    "keyMessage": "海拔四千米，信照样到。"
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
        "name": "艾力",
        "description": "38 岁男性马背邮递员，古铜色脸庞，深绿色旧棉大衣配皮帽，邮包搭在肩上，笑起来露白牙"
      },
      {
        "name": "小杨",
        "description": "20 岁男性边防士兵，军大衣配绒帽，脸被风吹得通红，站姿笔直，接过信时手在抖"
      }
    ],
    "scenes": [
      {
        "name": "高原垭口",
        "description": "写实帕米尔垭口：雪峰连绵、经幡在风里、马蹄踏雪、邮包冰碴、天空湛蓝到发黑"
      }
    ],
    "musicBrief": "高原风声与马铃，辽阔留白。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 40.1s |
| visual | done | 155.3s |
| prompts | done | 180.4s |
| keyframes | done | 220.5s |
| audio | done | 250.5s |
| clips | done | 400.9s |
| export | done | 681.5s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-31T00:37:41.775Z |
| keyframes | resume（确认 5 镜） | 2026-08-31T00:38:46.931Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.532,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":35,"wastedSec":0,"completedClips":6,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 艾力 | zixinnansheng |
| 小杨 | qingniandaxuesheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（5893KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 88（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 93 / 人物 98 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [zixinnansheng, qingniandaxuesheng]）
- ✅ 角色音色互不相同（2/2（zixinnansheng, qingniandaxuesheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 98 |
| pacing | 95 |
| physicalAccuracy | 93 |
| characterConsistency | 98 |
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
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02_v1.png, design-prop-PR02.png, design-prop-PR03.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02_v1.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：5893 KB