# G2-suspense-metro · 《末班地铁的日记》· 悬疑留白 · 台词驱动

- 音频形态：`dialogue`
- runId：`run-mtgfuuhv-12`
- 结论：**PASS**
- 总耗时：462.7s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实悬疑短片：末班地铁车厢，加班的女孩许星然捡到一本被人落下的日记，扉页写着「写给捡到它的人」。她按日记里的站名一站站找失主，每站遇到一个线索人物，最后发现日记是留给这条地铁线的告别礼物。旁白三句制造悬念，对白简短克制。写实末班地铁：空荡车厢、隧道灯闪、报站声。",
    "keyMessage": "有人把想说的话，留在了最后一班车。"
  },
  "options": {
    "resolution": "720p",
    "aspectRatio": "16:9",
    "shotCount": 6,
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
        "name": "许星然",
        "description": "27 岁女性加班白领，深灰色大衣配工牌挂绳，黑长发扎低马尾，眼下有倦容但眼神亮"
      },
      {
        "name": "值班员",
        "description": "55 岁男性地铁站值班员，藏蓝色制服配制帽，花白鬓角，手里拿着对讲机"
      }
    ],
    "scenes": [
      {
        "name": "末班地铁",
        "description": "写实末班地铁：空荡橙色座椅车厢、隧道灯频闪车窗、报站屏微光"
      }
    ],
    "musicBrief": "低频隧道轰鸣，悬念处突然安静。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 70.1s |
| visual | done | 160.3s |
| prompts | done | 195.4s |
| keyframes | done | 220.4s |
| audio | done | 240.5s |
| clips | done | 375.8s |
| export | done | 461.0s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T23:29:10.431Z |
| keyframes | resume（确认 6 镜） | 2026-08-30T23:30:10.546Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.783,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":36,"wastedSec":0,"completedClips":6,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 许星然 | jingdiannvsheng |
| 值班员 | shenchennanyin |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（5738KB / 阈值 50KB）
- ✅ 镜头数达标（6 / 期望 ≥6）
- ✅ 片段产物存在（6 段）
- ✅ 关键帧数 ≥ 片段数（6 vs 6）
- ✅ TTS 音轨存在（台词/旁白）（10 条）
- ✅ 台词镜存在（4 镜）
- ✅ 质检有分（综合 86（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 100 / 人物 100 / 文字 95）
- ✅ 字幕结构审核通过（6 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [jingdiannvsheng, shenchennanyin]）
- ✅ 角色音色互不相同（2/2（jingdiannvsheng, shenchennanyin））

### 失败

- 无

## 审核（物理错误 / 人物不一致 / 文字乱码 / 字幕错误）

| 审核轴 | 分数 |
| --- | --- |
| briefFit | 95 |
| visualConsistency | 90 |
| pacing | 88 |
| physicalAccuracy | 100 |
| characterConsistency | 100 |
| audioSync | 33 |
| textQuality | 95 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：6 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 11 | voice-cast.json, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH04-pad.mp3, tts-dialogue-SH04.mp3, tts-dialogue-SH05-pad.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 21 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 10 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03.png, design-scene-SC01.png |
| 03-keyframes | 7 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, key-SH06.png |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4, clip-SH06.mp4 |

成片体积：5738 KB