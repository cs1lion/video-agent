# S3-tower-night · 《塔台夜班》· 管制员×机长 · 四轮对讲 + 冷调 BGM

- 音频形态：`dialogue+bgm`
- runId：`run-mtfydmna-6`
- 结论：**PASS**
- 总耗时：457.5s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人剧情短片：深夜机场塔台。管制员苏青引导一架晚点三小时的航班落地——机长周远航是她二十年前的飞行教官。对话是标准专业术语的克制往来，最后一句绕开术语回到师生。四轮对讲，旁白两句交代风与跑道。写实的塔台夜景：舷窗、雷达屏光、耳机话筒、远处跑道灯。",
    "keyMessage": "落地了，就回家。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 6,
    "clipDurationSec": 7,
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
        "name": "苏青",
        "description": "35 岁女性塔台管制员，深蓝色制服衬衫，头发一丝不苟束起，戴头戴耳机，眼神专注"
      },
      {
        "name": "周远航",
        "description": "51 岁男性机长，白色机长制服四道杠，短黑发掺白，下颌线硬朗，坐姿端正"
      }
    ],
    "scenes": [
      {
        "name": "塔台",
        "description": "写实机场塔台夜间：环形舷窗、雷达屏冷光、通话面板、咖啡杯、远处跑道灯串"
      }
    ],
    "musicBrief": "冷调低回的电子底床，克制。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 30.1s |
| visual | done | 140.3s |
| prompts | done | 200.4s |
| keyframes | done | 225.4s |
| audio | done | 245.5s |
| clips | done | 350.7s |
| export | done | 456.0s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T15:19:33.793Z |
| keyframes | resume（确认 6 镜） | 2026-08-30T15:20:58.970Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.396,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":21,"wastedSec":0,"completedClips":3,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 苏青 | jingdiannvsheng |
| 周远航 | zixinnansheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（3010KB / 阈值 50KB）
- ✅ 镜头数达标（6 / 期望 ≥6）
- ✅ 片段产物存在（3 段）
- ✅ 关键帧数 ≥ 片段数（6 vs 3）
- ✅ TTS 音轨存在（台词/旁白）（9 条）
- ✅ BGM 已入时间线
- ✅ 台词镜存在（1 镜）
- ✅ 质检有分（综合 84（warn））
- ✅ 物理/人物/文字审核轴齐备（物理 85 / 人物 95 / 文字 85）
- ✅ 字幕结构审核通过（3 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [jingdiannvsheng, zixinnansheng]）
- ✅ 角色音色互不相同（2/2（jingdiannvsheng, zixinnansheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 88 |
| pacing | 92 |
| physicalAccuracy | 85 |
| characterConsistency | 95 |
| audioSync | 50 |
| textQuality | 85 |

| 镜头 | 裁决 | 问题（物理:/人物:/文字:/字幕: 前缀标类别） |
| --- | --- | --- |
| SH03 | warn | 物理: 第一帧后景出现的手部在第二帧中凭空消失，存在穿帮；机长着装规范，通话内容专业。 |
| SH06 | warn | 字幕: '落落地了，就回家'存在文字重复错误。 |

- 字幕结构审核：3 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 11 | voice-cast.json, bgm.wav, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH05-pad.mp3, tts-dialogue-SH05.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 12 | transitions.json, final.mp4, qa-SH03-late.jpg, qa-SH03.jpg, qa-SH04-late.jpg, qa-SH04.jpg, qa-SH06-late.jpg, qa-SH06.jpg |
| 02-design | 8 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png, design-scene-SC02.png |
| 03-keyframes | 7 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, key-SH06.png |
| 04-clips | 3 | clip-SH03.mp4, clip-SH04.mp4, clip-SH06.mp4 |

成片体积：3010 KB