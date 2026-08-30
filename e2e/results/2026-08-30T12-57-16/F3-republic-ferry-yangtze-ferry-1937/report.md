# F3-republic-ferry · 《三峡夜航》· 1937 长江客轮 · 台词 + BGM

- 音频形态：`dialogue+bgm`
- runId：`run-mtftx1d8-3`
- 结论：**PASS**
- 总耗时：502.9s

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
| script | done | 40.1s |
| visual | done | 115.2s |
| prompts | done | 165.3s |
| keyframes | done | 190.4s |
| audio | done | 210.4s |
| clips | done | 410.9s |
| export | done | 501.0s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T13:14:16.305Z |
| keyframes | resume（确认 5 镜） | 2026-08-30T13:15:31.461Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.604,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":25,"wastedSec":0,"completedClips":5,"failedClips":0} |

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
- ✅ 成片体积达标（6034KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（6 条）
- ✅ BGM 已入时间线
- ✅ 台词镜存在（2 镜）
- ✅ 质检有分（综合 85（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 95 / 人物 90 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [shenchennanyin, jingdiannvsheng]）
- ✅ 角色音色互不相同（2/2（shenchennanyin, jingdiannvsheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 85 |
| visualConsistency | 92 |
| pacing | 95 |
| physicalAccuracy | 95 |
| characterConsistency | 90 |
| audioSync | 40 |
| textQuality | 100 |

| 镜头 | 裁决 | 问题（物理:/人物:/文字:/字幕: 前缀标类别） |
| --- | --- | --- |
| SH05 | warn | 字幕:包含现代网络用语'扫码带走同款'，与宋代历史背景严重违和 |

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 00-input | 5 | brief.json, coSpace.json, cost-estimate.json, options.json, request.json |
| 01-script | 4 | artifacts-prompts.json, artifacts-script.json, script.json, voice-directions.json |
| 02-design | 11 | artifacts-bible.json, artifacts-design.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png |
| 03-keyframes | 8 | artifacts-keyframes.json, gate-keyframes-snapshot.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, keyframes.json |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |
| 05-audio | 8 | bgm.wav, tts-dialogue-SH01-pad.mp3, tts-dialogue-SH01.mp3, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-SH03.mp3, tts-SH05.mp3, voice-cast.json |
| 06-export | 18 | final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg, qa-SH04-late.jpg |
| 07-qa | 5 | consistency.json, run-state.json, traces.ndjson, traces.ndjson.json, verdict.json |
| 08-assets | 40 | bgm.wav, clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4, design-character-CH01.png, design-character-CH02.png |

成片体积：6034 KB