# G5-hospital-first-op · 《第一台手术》· 医院 · 职业克制

- 音频形态：`dialogue`
- runId：`run-mtggrd23-15`
- 结论：**PASS**
- 总耗时：502.6s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实职业短片：县医院手术室，年轻器械护士苏芒第一次配合主刀医师程一舟做急诊阑尾手术。程一舟话极少，每个指令只有两个字「刀」「纱布」；苏芒手快心细，术后程一舟只说了一句「明天继续」。两句旁白交代深夜急诊，职业对白极简克制，情绪全在动作里。写实手术室：无影灯、器械盘、监护仪滴声、口罩上的眼睛。",
    "keyMessage": "医生的话越少，说明他越专注。"
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
        "name": "程一舟",
        "description": "44 岁男性主刀医师，深绿色手术衣帽全包只露眼睛，眉骨有疤，手部动作极稳"
      },
      {
        "name": "苏芒",
        "description": "24 岁女性器械护士，浅绿色手术衣，头发全包进帽子，只露一双专注的眼，手上动作快而轻"
      }
    ],
    "scenes": [
      {
        "name": "县医院手术室",
        "description": "写实县级医院手术室：无影灯、器械台、绿色消毒巾、监护仪微光、墙上时钟"
      }
    ],
    "musicBrief": "只有监护仪规律滴声。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 35.0s |
| visual | done | 120.2s |
| prompts | done | 165.4s |
| keyframes | done | 210.5s |
| audio | done | 230.5s |
| clips | done | 426.0s |
| export | done | 501.1s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T23:53:47.428Z |
| keyframes | resume（确认 5 镜） | 2026-08-30T23:55:17.658Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.6,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":30,"wastedSec":0,"completedClips":5,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 程一舟 | zixinnansheng |
| 苏芒 | qingchunshaonv |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（2724KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 87（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 95 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [zixinnansheng, qingchunshaonv]）
- ✅ 角色音色互不相同（2/2（zixinnansheng, qingchunshaonv））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 92 |
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
| 02-design | 7 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：2724 KB