# G8-rooftop-ot · 《加班楼的灯》· 都市情感 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtghtd2g-18`
- 结论：**PASS**
- 总耗时：823.3s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实都市情感短片：深夜写字楼天台，连续加班三周的程序员陆一鸣和产品经理夏澄上来透气，两人隔着栏杆聊「如果明天辞职了想干什么」——从互相打趣到说出真话：他想回家陪爷爷收一季稻，她想在楼下的桥边开一家旧书店。三句旁白交代城市灯火，对白轻巧渐进。写实天台夜景：栏杆、城市灯海、风、两杯便利店的关东煮。",
    "keyMessage": "灯是给别人看的，话是说给自己人的。"
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
        "name": "陆一鸣",
        "description": "29 岁男性程序员，深灰色连帽卫衣配工牌挂绳，短黑发微乱，手里捧着关东煮纸杯"
      },
      {
        "name": "夏澄",
        "description": "28 岁女性产品经理，燕麦色大衣配米色围巾，长发披肩，倚着栏杆转手机"
      }
    ],
    "scenes": [
      {
        "name": "写字楼天台",
        "description": "写实的深夜写字楼天台：金属栏杆、城市灯海虚化、风起发丝、两杯便利店热食"
      }
    ],
    "musicBrief": "城市底噪与极轻的钢琴单音。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 40.1s |
| visual | done | 170.4s |
| prompts | done | 210.5s |
| keyframes | done | 230.5s |
| audio | done | 250.5s |
| clips | done | 420.9s |
| export | done | 821.8s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-31T00:24:10.471Z |
| keyframes | resume（确认 5 镜） | 2026-08-31T00:25:10.616Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.438,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":35,"wastedSec":0,"completedClips":6,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 陆一鸣 | zixinnansheng |
| 夏澄 | jingdiannvsheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（4572KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（9 条）
- ✅ 台词镜存在（4 镜）
- ✅ 质检有分（综合 87（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 100 / 人物 100 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [zixinnansheng, jingdiannvsheng]）
- ✅ 角色音色互不相同（2/2（zixinnansheng, jingdiannvsheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 98 |
| visualConsistency | 95 |
| pacing | 95 |
| physicalAccuracy | 100 |
| characterConsistency | 100 |
| audioSync | 20 |
| textQuality | 100 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 10 | voice-cast.json, tts-dialogue-SH01-pad.mp3, tts-dialogue-SH01.mp3, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH04-pad.mp3, tts-dialogue-SH04.mp3, tts-dialogue-SH05-pad.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 18 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 10 | visual-bible.json, design-bible.json, design-character-CH01_v1.png, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02_v1.png, design-prop-PR02.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04_v1.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：4572 KB