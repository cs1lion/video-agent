# C1-dialogue · 《雨夜末班》· 台词驱动 · 写实都市

- 音频形态：`dialogue`
- runId：`run-mtez6cnf-31`
- 结论：**FAIL**
- 总耗时：1138.9s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人短片：深夜十一点的城郊公交站，末班车迟迟不来。一位跑了一天外卖的中年男人蹲在站台边，把凉掉的包子掰了一半递给同在等车的女儿。父女在雨声里有一小段压着嗓子的对白，最后车灯由远及近——故事讲「抵达本身就已经是团圆」。",
    "keyMessage": "再远的路，也有人等你到站。"
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
        "name": "老周",
        "description": "46 岁外卖骑手，深蓝旧冲锋衣，胡茬，眼下有疲惫纹路，说话习惯低头"
      },
      {
        "name": "周小雨",
        "description": "11 岁女孩，校服外套偏大，背旧书包，头发被雨打湿贴在额角"
      }
    ],
    "scenes": [
      {
        "name": "城郊公交站",
        "description": "深夜写实：褪色广告灯箱、积水倒映暖黄路灯光、远处高架车流是虚焦光斑"
      },
      {
        "name": "末班公交车内",
        "description": "写实车厢：空座、冷白顶灯、车窗雨痕与自己的倒影"
      }
    ],
    "musicBrief": "低音量钢琴单音 + 雨声环境音，情绪克制，结尾随车灯渐亮微微抬起。"
  }
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | done | 20.1s |
| visual | done | 110.3s |
| prompts | done | 140.3s |
| keyframes | done | 165.4s |
| clips | done | 1052.2s |
| audio | done | 1077.2s |
| export | done | 1137.4s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |
| design | resume | 2026-08-29T22:53:37.474Z |
| keyframes | resume（确认 5 镜） | 2026-08-29T22:54:32.629Z |

## 成片后的动作

- 无

## 断言

### 通过

- ✅ 管线状态 done（实际 done）
- ✅ 全部阶段 done（7/7）
- ✅ 成片已归档
- ✅ 成片体积达标（6480KB / 阈值 50KB）
- ✅ 镜头数达标（5 / 期望 ≥5）
- ✅ 片段产物存在（5 段）
- ✅ 关键帧数 ≥ 片段数（5 vs 5）
- ✅ 注意：台词镜为 0（可能已降级为旁白，见事件日志）
- ✅ 五轴质检有分（综合 97（pass））

### 失败

- ❌ 台词镜存在（0 镜）

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 01-script | 2 | script.json, voice-directions.json |
| 07-qa | 3 | run-state.json, consistency.json, traces.ndjson |
| 06-export | 13 | transitions.json, final.mp4, qa-SH01.jpg, qa-SH02.jpg, qa-SH03.jpg, qa-SH04.jpg, qa-SH05.jpg, shot-SH01.mp4 |
| 02-design | 9 | visual-bible.json, design-bible.json, design-character-CH01.png, design-character-CH02_v1.png, design-character-CH02.png, design-prop-PR01.png, design-prop-PR02.png, design-scene-SC01.png |
| 03-keyframes | 6 | keyframes.json, key-SH01.png, key-SH02.png, key-SH03.png, key-SH04.png, key-SH05.png |
| 04-clips | 5 | clip-SH01.mp4, clip-SH02.mp4, clip-SH03.mp4, clip-SH04.mp4, clip-SH05.mp4 |
| 05-audio | 5 | tts-SH01.mp3, tts-SH02.mp3, tts-SH03.mp3, tts-SH04.mp3, tts-SH05.mp3 |

成片体积：6480 KB