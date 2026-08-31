# G4-rural-harvest · 《抢收前的雨》· 南方乡土 · 纪实质感

- 音频形态：`dialogue`
- runId：`run-mtgghx41-14`
- 结论：**PASS**
- 总耗时：437.6s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实乡土短片：南方稻田，天气预报说大雨今晚到。父亲贵叔和返乡的女儿秋禾抢收最后两亩稻子——父亲不肯用收割机嫌浪费谷粒，女儿又气又心疼。三句旁白交代天色与收成，对白全是大白话。写实南方稻田：沉甸甸的稻穗、乌云压田、雨点试探、胶鞋踩进泥里。",
    "keyMessage": "谷粒回到仓里，雨才敢落下来。"
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
        "name": "贵叔",
        "description": "59 岁男性稻农，深皮肤皱纹深，旧军绿雨衣搭肩，卷着裤腿踩泥，草帽绳勒着下巴"
      },
      {
        "name": "秋禾",
        "description": "26 岁女性返乡女儿，马尾辫配旧鸭舌帽，长袖衬衫袖子挽到手肘，戴劳保手套抱稻捆"
      }
    ],
    "scenes": [
      {
        "name": "南方稻田",
        "description": "写实南方稻田：沉甸甸金黄稻穗、乌云低垂、田埂泥泞、远山雨雾、麻雀掠过"
      }
    ],
    "musicBrief": "蛙声与远处雷声，无配乐。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 65.1s |
| visual | done | 165.3s |
| prompts | done | 190.4s |
| keyframes | done | 215.4s |
| audio | done | 240.5s |
| clips | done | 375.8s |
| export | done | 435.9s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T23:47:11.891Z |
| keyframes | resume（确认 5 镜） | 2026-08-30T23:48:02.008Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.695,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":30,"wastedSec":0,"completedClips":5,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 贵叔 | shenchennanyin |
| 秋禾 | jingdiannvsheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（8459KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 87（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 95 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
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
| 02-design | 10 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01_v1.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：8459 KB