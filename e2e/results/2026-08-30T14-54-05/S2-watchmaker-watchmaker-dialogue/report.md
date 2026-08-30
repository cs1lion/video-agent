# S2-watchmaker · 《修表匠与大学生》· 五轮对讲 · 长镜对白

- 音频形态：`dialogue`
- runId：`run-mtfy1lk9-5`
- 结论：**PASS**
- 总耗时：558.3s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人剧情短片：老城修表铺。大学生林小满拿来奶奶留下的旧手表请修表匠贺师傅修理——表停在一个特殊的时间点。贺师傅一边拆表一边讲这块表的原主人三十年前来修过它，林小满边听边掉眼泪又笑。五轮对讲来回，旁白两句交代铺子与时间。全部戏在一张工作台与两只手上。",
    "keyMessage": "表修的不是时间，是没说完的话。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 7,
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
        "name": "贺师傅",
        "description": "58 岁男性修表匠，深棕色旧马甲配白衬衫，右眼戴单目放大镜，花白短发，手极稳"
      },
      {
        "name": "林小满",
        "description": "22 岁女性大学生，米白色针织开衫配格子裙，黑长直发，眼睛红肿，攥着一块旧女表"
      }
    ],
    "scenes": [
      {
        "name": "修表铺",
        "description": "写实老修表铺：玻璃柜台、台灯放大镜、挂钟一墙、绿罩工作灯、木质抽屉柜"
      }
    ],
    "musicBrief": "无音乐，只要镊子与齿轮的细响。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 25.1s |
| visual | done | 125.3s |
| prompts | done | 175.4s |
| keyframes | done | 205.5s |
| audio | done | 235.6s |
| clips | done | 461.0s |
| export | done | 556.3s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T15:09:57.317Z |
| keyframes | resume（确认 7 镜） | 2026-08-30T15:11:17.516Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.756,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":42,"wastedSec":0,"completedClips":7,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 贺师傅 | shenchennanyin |
| 林小满 | qingchunshaonv |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（7267KB / 阈值 50KB）
- ✅ 镜头数达标（7 / 期望 ≥7）
- ✅ 片段产物存在（7 段）
- ✅ 关键帧数 ≥ 片段数（7 vs 7）
- ✅ TTS 音轨存在（台词/旁白）（10 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 90（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 96 / 文字 100）
- ✅ 字幕结构审核通过（7 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [shenchennanyin, qingchunshaonv]）
- ✅ 角色音色互不相同（2/2（shenchennanyin, qingchunshaonv））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 93 |
| pacing | 92 |
| physicalAccuracy | 95 |
| characterConsistency | 96 |
| audioSync | 57 |
| textQuality | 100 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：7 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 11 | voice-cast.json, tts-dialogue-SH01-pad.mp3, tts-dialogue-SH01.mp3, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH05-pad.mp3, tts-dialogue-SH05.mp3, tts-SH03.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 24 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03_v1.png, design-prop-PR03.png |
| 03-keyframes | 8 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, key-SH06.png, key-SH07.png |
| 04-clips | 7 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4, clip-SH06.mp4, clip-SH07.mp4 |

成片体积：7267 KB