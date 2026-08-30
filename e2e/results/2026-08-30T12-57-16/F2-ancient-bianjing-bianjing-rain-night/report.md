# F2-ancient-bianjing · 《汴河夜雨》· 北宋汴京 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtftlt1h-2`
- 结论：**PASS**
- 总耗时：521.0s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人剧情短片：北宋汴京，虹桥边的夜市落着细雨。落魄书生沈砚之在灯笼摊前与更夫老周避雨对饮，书生叹科举三度落第，更夫讲自己打了三十年更「听遍全城的梦话」。三句旁白交代时辰与雨势，对白朴素见心。写实宋代市井：油纸灯笼、湿石板路、酒旗、乌篷檐滴雨。",
    "keyMessage": "灯火不问功名，照人一样亮。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 5,
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
        "name": "沈砚之",
        "description": "32 岁男性书生，洗旧的天青色直裰，束发戴小冠，眉目清瘦，手指有茧"
      },
      {
        "name": "老周",
        "description": "58 岁男性更夫，灰褐色短褐衣，腰挂铜锣与灯笼，花白胡须，脚步稳"
      }
    ],
    "scenes": [
      {
        "name": "虹桥夜市",
        "description": "写实北宋夜市：油纸灯笼串、湿漉漉石板路反光、酒旗、木檐滴雨、远处桥影"
      }
    ],
    "musicBrief": "雨声环境音，远处隐约更锣，收尾一声琴。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 25.0s |
| visual | done | 110.2s |
| prompts | done | 160.4s |
| keyframes | done | 180.4s |
| audio | done | 200.5s |
| clips | done | 385.9s |
| export | done | 461.1s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T13:05:27.040Z |
| keyframes | resume（确认 5 镜） | 2026-08-30T13:06:37.210Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| 设计图自审 | 6 张（fail 0 / warn 0） |
| 关键帧自审 | 5 帧（fail 0 / warn 0） |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.651,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":25,"wastedSec":0,"completedClips":5,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 沈砚之 | zixinnansheng |
| 老周 | shenchennanyin |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（6417KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 88（fail））
- ✅ 物理/人物/文字审核轴齐备（物理 100 / 人物 100 / 文字 100）
- ✅ 字幕结构审核通过（4 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [zixinnansheng, shenchennanyin]）
- ✅ 角色音色互不相同（2/2（zixinnansheng, shenchennanyin））
- ✅ 设计图自审有结论（6 张）
- ✅ 关键帧自审有结论（5 帧）

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 90 |
| visualConsistency | 95 |
| pacing | 90 |
| physicalAccuracy | 100 |
| characterConsistency | 100 |
| audioSync | 40 |
| textQuality | 100 |

| 镜头 | 裁决 | 问题（物理:/人物:/文字:/字幕: 前缀标类别） |
| --- | --- | --- |
| SH05 | fail | 未提供对应帧 |

- 字幕结构审核：4 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 00-input | 5 | brief.json, coSpace.json, cost-estimate.json, options.json, request.json |
| 01-script | 4 | artifacts-prompts.json, artifacts-script.json, script.json, voice-directions.json |
| 02-design | 11 | artifacts-bible.json, artifacts-design.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png |
| 03-keyframes | 8 | artifacts-keyframes.json, gate-keyframes-snapshot.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, keyframes.json |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |
| 05-audio | 9 | tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH04-pad.mp3, tts-dialogue-SH04.mp3, tts-SH01.mp3, tts-SH05.mp3 |
| 06-export | 18 | final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg, qa-SH04-late.jpg |
| 07-qa | 5 | consistency.json, run-state.json, traces.ndjson, traces.ndjson.json, verdict.json |
| 08-assets | 41 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png |

成片体积：6417 KB