# 剧本 I · 末时点系统性偏置测试（deep-review 第 4 类偏置）

> 性质：第 4 类 LLM-as-judge 系统性偏置验证脚本。
> 现象：D剧/E剧 deep-review 报"成片可见时长 18.89/23.60s"，实际 ffprobe = 22.67/27.87s，**少判 4 秒**。
> 假设：step-3.7-flash 视频理解对长视频的"结束点"判断有偏差（早于实际 end ~4s）。

## 一句话需求
设计一个 7 镜、总时长 ~35s 的剧本（比之前 6 镜~25s 长），让模型必须看到视频末尾才能正确判断 SH07 存在。如果模型误判"视频在 30s 结束"，就会再次出现"末镜缺失"幻觉。

## 人物
- **马工**（男，52 岁）：老车间工人
- **小王**（男，24 岁）：新来的学徒

## 场景
- 老国营工厂车间，午休时间，几个老师傅围坐着喝茶

## 镜头（7 镜，明显长视频）

### SH01 · 老马开场
- **audioMode**：dialogue
- **dialogue**：
  - characterId：马工
  - lines.zh："小王，你爸当年就在这台机床上。"
  - emotion：怀旧
- **visual**：老马坐在机床边，手指摸着操作面板上的磨痕。

### SH02 · 小王反应
- **audioMode**：dialogue
- **dialogue**：
  - characterId：小王
  - lines.zh："我……我不知道。马师傅您认识我爸？"
  - emotion：惊讶
- **visual**：小王手里的茶杯停在半空，看着老马。

### SH03 · 老马回忆
- **audioMode**：dialogue
- **dialogue**：
  - characterId：马工
  - lines.zh："80 年代的劳模。我刚进厂的时候，他带的我。"
  - emotion：慢慢说
- **visual**：老马站起来，走到窗边，背对镜头，望着窗外的车间。

### SH04 · 其他师傅插话
- **audioMode**：dialogue
- **dialogue**：
  - characterId：马工
  - lines.zh："老王师傅为人厚道，可惜走得太早。"
  - emotion：叹息
- **visual**：旁边的老师傅（背景人物）也站起来，跟老马一起望着窗外。

### SH05 · 小王追问
- **audioMode**：dialogue
- **dialogue**：
  - characterId：小王
  - lines.zh："那我爸他……喜欢什么？"
  - emotion：小心翼翼
- **visual**：小王走近老马，站在他身边。

### SH06 · 老马递东西
- **audioMode**：dialogue
- **dialogue**：
  - characterId：马工
  - lines.zh："这把扳手，是他当年留下来的——我替他保管了 20 年。"
  - emotion：庄重
- **visual**：老马从工具箱里拿出一把旧扳手，递给小王。

### SH07 · 小王接过
- **audioMode**：dialogue
- **dialogue**：
  - characterId：小王
  - lines.zh："谢谢马师傅。我会好好干的。"
  - emotion：坚定
- **visual**：小王双手接过扳手，低头看，眼眶红了。镜头慢慢拉远，整个车间在画面里。

## 旁白
无。

## 美术风格
写实 80 年代国营工厂，淡黄调，午后的阳光从高窗射入，灰尘在光线里浮动。

## 剪辑提示
- 7 镜比标准 6 镜多 1 镜，总时长 ~35s
- SH07 是末镜，video 必须有 ~5s 才能把"镜头慢慢拉远"做完整
- 期望：deep-review 能正确看到 35s 完整视频，不报"末镜缺失"
- **验证点**：如果 deep-review 报"末镜在 X 秒处中断，X < 35s"——说明末时点偏置在长视频上更明显
