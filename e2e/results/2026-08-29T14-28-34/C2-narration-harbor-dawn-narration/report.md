# C2-narration · 《开海》· 旁白叙事 · 写实渔村

- 音频形态：`narration`
- runId：`run-mtehx001-20`
- 结论：**FAIL**
- 总耗时：120.4s

## 需求与参数

```json
{
  "brief": {
    "logline": "写实真人纪录风短片：天没亮的渔港，一位老渔妇独自解开缆绳、检查网眼、发动马达，小船驶出防波堤时太阳正好从海平面抬起来。全片无人物台词，由一段克制的男声旁白串起她三十年的出海日常——讲「重复本身是一种勇气」。",
    "keyMessage": "日复一日，也是一种远航。"
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
    "audioDrive": "off"
  },
  "coSpace": null
}
```

## 阶段耗时

| 阶段 | 状态 | 耗时 |
| --- | --- | --- |
| script | failed | 120.4s |
| visual | pending | 120.4s |
| prompts | pending | 120.4s |
| keyframes | pending | 120.4s |
| clips | pending | 120.4s |
| audio | pending | 120.4s |
| export | pending | 120.4s |

## 闸门决策

| 闸门 | 动作 | 时间 |
| --- | --- | --- |


## 断言

### 通过

- ✅ 关键帧数 ≥ 片段数（0 vs 0）

### 失败

- ❌ 管线状态 done（实际 failed）
- ❌ 全部阶段 done（0/7）
- ❌ 成片已归档
- ❌ 成片体积达标（0KB / 阈值 50KB）
- ❌ 镜头数达标（0 / 期望 ≥5）
- ❌ 片段产物存在（0 段）
- ❌ 旁白音轨存在（0 条）
- ❌ 缺少质检结论（verdict）

## 产物清单

| 目录 | 数量 | 文件（最多 8 个） |
| --- | --- | --- |
| 07-qa | 2 | run-state.json, traces.ndjson |

成片体积：0 KB