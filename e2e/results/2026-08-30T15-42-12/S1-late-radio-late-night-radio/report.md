# S1-late-radio · 《深夜电台》· 主播×连线司机 · 四轮对讲

- 音频形态：`dialogue`
- runId：`run-mtfz9r4y-7`
- 结论：**PASS**
- 总耗时：608.3s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人剧情短片：深夜电台直播间。女主播方晚接进一位夜班出租车司机陈国平的电话连线——司机说今晚是他开车二十年最想哭的一晚，女儿考上了大学他却在两百公里外跑车；主播安静接话，两人一来一往四轮对讲，旁白两句交代时段与电波。全部情绪靠声音与面部特写完成。",
    "keyMessage": "有些路，是开给家里人听的。"
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
        "name": "方晚",
        "description": "32 岁女性电台主播，深酒红色衬衫，黑色齐肩发别一枚银夹，戴监听耳机，语速稳"
      },
      {
        "name": "陈国平",
        "description": "47 岁男性出租车司机，深蓝色工装夹克，短灰发，胡茬青黑，方向盘上搭着一条旧毛巾"
      }
    ],
    "scenes": [
      {
        "name": "电台直播间",
        "description": "写实的深夜电台：隔音棉墙、调音台推子、一盏桌面暖灯、防喷罩与话筒"
      },
      {
        "name": "出租车内",
        "description": "写实的深夜出租车驾驶位：零星路灯光扫过、挂饰轻晃、雨刮未开、仪表微光"
      }
    ],
    "musicBrief": "无音乐，只要直播间的安静与车内的引擎底噪。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 30.1s |
| visual | done | 185.5s |
| prompts | done | 220.5s |
| keyframes | done | 245.6s |
| audio | done | 265.6s |
| clips | done | 501.1s |
| export | done | 606.4s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-30T15:45:17.597Z |
| keyframes | resume（确认 6 镜） | 2026-08-30T15:46:17.736Z |

## 成片后的动作

| 动作 | 结果 |
| --- | --- |
| A/B 度量 | {"quotaUtilization":null,"effectiveThroughput":0.599,"p0LatencyP95":null,"wasteRate":null,"rejectionRate":null,"consumedSec":0,"effectiveSec":42,"wastedSec":0,"completedClips":6,"failedClips":0} |

## 配音选角

| 声部 | 音色 id |
| --- | --- |
| 旁白 | boyinnansheng |
| 方晚 | jingdiannvsheng |
| 陈国平 | zixinnansheng |

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（8281KB / 阈值 50KB）
- ✅ 镜头数达标（6 / 期望 ≥6）
- ✅ 片段产物存在（6 段）
- ✅ 关键帧数 ≥ 片段数（6 vs 6）
- ✅ TTS 音轨存在（台词/旁白）（10 条）
- ✅ 台词镜存在（4 镜）
- ✅ 质检有分（综合 89（pass））
- ✅ 物理/人物/文字审核轴齐备（物理 100 / 人物 100 / 文字 100）
- ✅ 字幕结构审核通过（6 行）
- ✅ 旁白音色与角色错开（旁白 boyinnansheng vs 角色 [jingdiannvsheng, zixinnansheng]）
- ✅ 角色音色互不相同（2/2（jingdiannvsheng, zixinnansheng））

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
| audioSync | 33 |
| textQuality | 100 |

- 逐镜审核：全部 ok（无物理/人物/文字/字幕问题被标记）

- 字幕结构审核：6 行，无重叠/缺口/编码问题

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 05-audio | 11 | voice-cast.json, tts-dialogue-SH01-pad.mp3, tts-dialogue-SH01.mp3, tts-dialogue-SH02-pad.mp3, tts-dialogue-SH02.mp3, tts-dialogue-SH03-pad.mp3, tts-dialogue-SH03.mp3, tts-dialogue-SH04-pad.mp3 |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 21 | transitions.json, final.mp4, qa-SH01-late.jpg, qa-SH01.jpg, qa-SH02-late.jpg, qa-SH02.jpg, qa-SH03-late.jpg, qa-SH03.jpg |
| 02-design | 11 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02.png, design-prop-PR01_v1.png, design-prop-PR01.png, design-prop-PR02.png, design-prop-PR03_v1.png |
| 03-keyframes | 7 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png, key-SH06.png |
| 04-clips | 6 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4, clip-SH06.mp4 |

成片体积：8281 KB