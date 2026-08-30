# F3-republic-ferry · 《三峡夜航》· 1937 长江客轮 · 台词 + BGM

- 音频形态：`dialogue+bgm`
- runId：`run-mtfwjlw8-3`
- 结论：**PASS**
- 总耗时：563.2s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人剧情短片：1937 年冬，长江夜航客轮的甲板。船员夫妻做最后一遍巡查——妻子清点救生圈念叨时局，丈夫检查缆绳劝她宽心；旁白两句交代这班船连夜送人西去。对白克制，汽笛一声，两人并肩看江面灯火。写实民国江轮：木质甲板、煤油灯、救生圈成排、江雾与灯火。",
    "keyMessage": "船往上游走，人往心里回。"
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
        "name": "陈海生",
        "description": "45 岁男性江轮水手长，古铜色皮肤，藏青色旧制服外套，花白胡茬，嗓音沙哑沉稳"
      },
      {
        "name": "秀珍",
        "description": "42 岁女性，陈海生的妻子，齐耳灰黑短发，深蓝色布衫配围裙，手里攥着一方旧手帕"
      }
    ],
    "scenes": [
      {
        "name": "江轮甲板",
        "description": "写实民国夜航江轮：木质甲板、煤油挂灯、救生圈、缆绳桩、江雾里的灯火"
      }
    ],
    "musicBrief": "江风与汽笛环境音，一段旧式弦乐低回。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 35.1s |
| visual | done | 160.5s |
| prompts | done | 200.6s |
| keyframes | done | 220.6s |
| audio | done | 245.7s |
| clips | done | 491.2s |
| export | done | 561.4s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T14:28:33.815Z |
| keyframes | resume（确认 5 镜） | 2026-08-30T14:29:33.958Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.538,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":25,"wastedSec":0,"completedClips":5,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 陈海生 | shenchennanyin |
| 秀珍 | jingdiannvsheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（4702KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（7 条）
- ✅ BGM 已入时间线
- ✅ 台词镜存在（2 镜）
- ✅ 质检有分（综合 92（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 100 / 人物 100 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [shenchennanyin, jingdiannvsheng]）
- ✅ 角色音色互不相同（2/2（shenchennanyin, jingdiannvsheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 98 |
| pacing | 90 |
| physicalAccuracy | 100 |
| characterConsistency | 100 |
| audioSync | 60 |
| textQuality | 100 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 9 | voice-cast.json, bgm.wav, tts-dialogue-SH01-pad.mp3, tts-dialogue-SH01.mp3, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-SH03.mp3, tts-SH04.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 18 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 7 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：4702 KB