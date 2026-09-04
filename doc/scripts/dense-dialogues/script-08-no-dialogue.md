# 剧本 H · audioDrive=dialogue 模式下的非 dialogue 镜测试

> 性质：补遗 §5.3（"audioDrive: 'off' 但镜头 audioMode: 'dialogue' 组合无人防御"）回归测试。
> 引用：评审报告-已完成工作质量评估-2026-08-29.md §3.7

## 一句话需求
测试 audioDrive=dialogue 模式下，混合 5 个镜（narration / silent / dialogue 各 1-2 个）的脚本处理是否正确。

## 人物
- **林女士**（Lin，女，58 岁）：退休教师
- **小赵**（Zhao，男，28 岁）：护士

## 场景
- 社区医院候诊大厅，长椅，窗外有梧桐树

## 镜头（5 镜，混合 audioMode）

### SH01 · 开场旁白
- **audioMode**：narration
- **dialogue**：（无）
- **narrationZh**："这是一个普通周三的下午，社区医院候诊大厅里坐着一位老人和一个年轻人。"
- **visual**：候诊大厅全景，老人坐在左边长椅上，年轻人坐在右边长椅，低头看手机，窗外阳光斜射进来。

### SH02 · silent 镜
- **audioMode**：silent
- **dialogue**：（无）
- **visual**：老人抬起头，看了看墙上的钟，又看了看年轻人，欲言又止。

### SH03 · 老人台词
- **audioMode**：dialogue
- **dialogue**：
  - characterId：林女士
  - lines.zh："小伙子，你挂的是几号？"
  - emotion：温和
- **visual**：老人转头看向年轻人，微微倾身。

### SH04 · 年轻人台词
- **audioMode**：dialogue
- **dialogue**：
  - characterId：小赵
  - lines.zh："我挂的是 17 号。阿姨您呢？"
  - emotion：礼貌
- **visual**：年轻人抬头看老人，手机放下。

### SH05 · 收尾旁白
- **audioMode**：narration
- **dialogue**：（无）
- **narrationZh**："叫号机响了一下，老人的 12 号先到了。她站起来，向年轻人点了点头。"
- **visual**：老人站起来，向年轻人微笑点头。

## 美术风格
写实社区医院，自然光，安静氛围，无 BGM。

## 剪辑提示
- SH01 + SH05 是 narration，纯画面 + 旁白
- SH02 是 silent，纯画面（这是这个测试的关键，看是否被静默处理）
- SH03 + SH04 是 dialogue，需要 audioDrive=dialogue 支持
- D1 闸门要求台词镜是单说话人 → SH03 SH04 各一句台词
- 验证：narration/silent 镜不会被错误地配音（导致视频模型乱动嘴）
