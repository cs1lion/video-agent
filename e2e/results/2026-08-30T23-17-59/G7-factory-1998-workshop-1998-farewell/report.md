# G7-factory-1998 · 《一九九八的车间》· 年代情感 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtghf6te-17`
- 结论：**PASS**
- 总耗时：658.3s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实年代短片：1998 年冬，国营机床厂车间。老师傅顾长根收到车间的转岗名单，徒弟大刘把自己的名字悄悄换成了徒弟的——被顾长根发现后师徒在机床边有一场压着嗓子的争执：「我五十了你是二十五」「厂里养过我全家」。三句旁白交代厂房与年代，年代情感厚重。写实国营车间：老机床、铁皮工具柜、车间广播、哈气成雾的冬天。",
    "keyMessage": "机器不停，人就得往前走。"
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
        "name": "顾长根",
        "description": "52 岁男性老师傅，深蓝色厂服配套袖，鸭舌帽檐压得低，指缝有机油，眼神硬"
      },
      {
        "name": "大刘",
        "description": "26 岁男性学徒工，同款深蓝厂服袖子卷起，短黑发，手背有伤疤，喉结滚动忍着话"
      }
    ],
    "scenes": [
      {
        "name": "国营车间",
        "description": "写实九十年代国营车间：老式机床、铁皮工具柜、高窗积雪天光、车间广播喇叭、哈气成雾"
      }
    ],
    "musicBrief": "车间机器低鸣与广播残响。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 60.1s |
| visual | done | 180.4s |
| prompts | done | 210.5s |
| keyframes | done | 235.5s |
| audio | done | 255.6s |
| clips | done | 451.0s |
| export | done | 656.5s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-31T00:13:19.209Z |
| keyframes | resume（确认 5 镜） | 2026-08-31T00:14:14.355Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.549,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":35,"wastedSec":0,"completedClips":6,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 顾长根 | zixinnansheng |
| 大刘 | cixingnansheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（6224KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 76（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 80 / 人物 70 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [zixinnansheng, cixingnansheng]）
- ✅ 角色音色互不相同（2/2（zixinnansheng, cixingnansheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 60 |
| pacing | 85 |
| physicalAccuracy | 80 |
| characterConsistency | 70 |
| audioSync | 40 |
| textQuality | 100 |

| 镜头 | 裁决 | 问题（物理:/人物:/文字:/字幕: 前缀标类别） |
| --- | --- | --- |
| SH01 | warn | 蒸汽特效虚假不自然，AI生成痕迹明显，人物风格与后续镜头不一致 |

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 9 | voice-cast.json, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH04-pad.mp3, tts-dialogue-SH04.mp3, tts-SH01.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 18 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01_v1.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05_v1.mp4, clip-SH05.mp4 |

成片体积：6224 KB