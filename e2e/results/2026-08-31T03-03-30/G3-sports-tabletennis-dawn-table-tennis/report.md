# G3-sports-tabletennis · 《凌晨四点的球馆》· 热血训练 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtgnlx5e-22`
- 结论：**PASS**
- 总耗时：798.4s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实热血短片：凌晨四点的老球馆，少年江野和当过省队陪练的父亲江建军加练——父亲喂球又狠又准，少年摔拍子吼「我练不动了」，父亲只回一句「捡回来」。三句旁白交代十年晨训，对白短促带火药味，最后一个球擦网落地的瞬间两人都没说话。写实球馆：旧木地板、成筐的球、汗透的球衣、高窗透进的第一缕天光。",
    "keyMessage": "捡回来的不是球，是不服。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 5,
    "clipDurationSec": 6,
    "fps": 24,
    "motionIntensity": "high",
    "detailBoost": true,
    "promptLanguage": "zh",
    "negativePrompt": "anime, cartoon, illustration, 3d render, cgi plastic skin, painting, watermark, garbled text, on-screen captions, UI overlays, debug frames, low resolution, blur, distorted face, asymmetric eyes, distorted hands, extra fingers, morphing objects",
    "audioDrive": "dialogue"
  },
  "coSpace": {
    "characters": [
      {
        "name": "江野",
        "description": "16 岁男性少年球员，红色球服汗透贴背，短碎发滴汗，手腕缠肌效贴，眼神倔"
      },
      {
        "name": "江建军",
        "description": "45 岁男性父亲兼陪练，旧运动外套袖口磨亮，平头有白发，小臂肌肉线条硬，表情不外露"
      }
    ],
    "scenes": [
      {
        "name": "老球馆",
        "description": "写实老训练球馆：磨旧木地板、成筐乒乓球、白炽灯高悬、高窗天光初亮、墙上旧奖旗"
      }
    ],
    "musicBrief": "乒乓球击打声为主，收尾一声球鞋摩擦地板。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 70.1s |
| visual | done | 155.3s |
| prompts | done | 200.4s |
| keyframes | done | 250.5s |
| audio | done | 275.6s |
| clips | done | 521.1s |
| export | done | 796.7s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-31T03:06:05.897Z |
| keyframes | resume（确认 5 镜） | 2026-08-31T03:07:41.097Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.454,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":35,"wastedSec":0,"completedClips":6,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 江野 | qingniandaxuesheng |
| 江建军 | shenchennanyin |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（4576KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（8 条）
- ✅ 台词镜存在（3 镜）
- ✅ 质检有分（综合 85（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 80 / 文字 70）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [qingniandaxuesheng, shenchennanyin]）
- ✅ 角色音色互不相同（2/2（qingniandaxuesheng, shenchennanyin））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 85 |
| visualConsistency | 80 |
| pacing | 85 |
| physicalAccuracy | 95 |
| characterConsistency | 80 |
| audioSync | 100 |
| textQuality | 70 |

| 镜头 | 裁决 | 问题（物理:/人物:/文字:/字幕: 前缀标类别） |
| --- | --- | --- |
| SH02 | warn | 背景墙文字"東庫切蒜館"为伪中文乱码，疑似AI生成错误。 |
| SH05 | warn | 背景招牌"東庫切蒜館"文字错误（应为老球馆相关字样），属明显乱码。 |

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 9 | voice-cast.json, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH04-pad.mp3, tts-dialogue-SH04.mp3, tts-SH01.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 18 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 8 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05_v1.mp4, clip-SH05.mp4 |

成片体积：4576 KB