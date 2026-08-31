# G1-comedy-designated-driver · 《代驾夜话》· 轻喜剧 · 快节奏对白

- 音频形态：`dialogue`
- runId：`run-mtgfjwh6-11`
- 结论：**PASS**
- 总耗时：507.7s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实轻喜剧短片：代驾司机小马接了一位话痨醉客——客户一路吹嘘自己当年「差一点就上市」，小马一句接一句地不动声色拆台，最后客户在小区门口清醒了，反过来请教小马「你们公司还招人吗」。两句旁白，快节奏对白与误会反转，节奏明快剪得碎。",
    "keyMessage": "醉话吹出去，清醒收回来。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 5,
    "clipDurationSec": 5,
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
        "name": "小马",
        "description": "26 岁男性代驾司机，深蓝色反光背心，短黑发，面无表情但眼里全是戏"
      },
      {
        "name": "钱总",
        "description": "45 岁男性微醺客户，竖条纹衬衫松领带，头发微乱，手里攥着车钥匙转圈"
      }
    ],
    "scenes": [
      {
        "name": "夜间车内",
        "description": "写实代驾夜间车内：方向盘、后视镜挂件、路灯光扫过车内、夜色车流"
      }
    ],
    "musicBrief": "轻快拨弦点缀，卡在拆台句上。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 15.0s |
| visual | done | 90.2s |
| prompts | done | 120.3s |
| keyframes | done | 140.3s |
| audio | done | 150.3s |
| clips | done | 425.9s |
| export | done | 506.1s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T23:19:29.697Z |
| keyframes | resume（确认 5 镜） | 2026-08-30T23:20:19.804Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.597,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":26,"wastedSec":0,"completedClips":5,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 小马 | zixinnansheng |
| 钱总 | cixingnansheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（7075KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ TTS 音轨存在（台词/旁白）（11 条）
- ✅ 台词镜存在（5 镜）
- ✅ 质检有分（综合 82（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 100 / 人物 100 / 文字 100）
- ✅ 字幕结构审核通过（5 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [zixinnansheng, cixingnansheng]）
- ✅ 角色音色互不相同（2/2（zixinnansheng, cixingnansheng））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 90 |
| pacing | 92 |
| physicalAccuracy | 100 |
| characterConsistency | 100 |
| audioSync | 0 |
| textQuality | 100 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：5 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 12 | voice-cast.json, tts-dialogue-SH01-pad.mp3, tts-dialogue-SH01.mp3, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03-r2.mp3, tts-dialogue-SH03.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 18 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 8 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png, design-scene-SC02.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |

成片体积：7075 KB