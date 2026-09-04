# 剧本 F · 跨代际家宴（voice-cast 压力测试）

> 性质：voice-cast fix 的压力测试用例。**故意覆盖全部 6 个分龄分性音色池**
> （maleElder / maleAdult / maleYoung / femaleElder / femaleAdult / femaleYoung），
> 并对 narrative 端做性别显式声明，验证 runner → CoCharacter.gender → voicePoolForDescription 的链路。
>
> 与 A-E 五剧不同的差异化点：
>   - 6 个角色跨三代（祖辈 / 父辈 / 子辈）
>   - 同性不同龄并存（男爷爷 vs 男青年、女奶奶 vs 女青年）
>   - 性别描述都走新格式 `(男/女，X 岁)`，不依赖 regex 兜底
>   - 镜头数提到 8 镜（比标准 6 镜多 2 镜，留出旁白 + 多角色切换空间）

## 一句话需求
中秋家宴，76 岁的爷爷要卖掉祖宅去养老院，35 岁的父亲想接爷爷同住，22 岁的女儿刚毕业想创业要钱，18 岁的儿子高三备考想保持安静。6 个人围坐一桌，3 道菜之间对话层层升级——最后谁也没说服谁，但爷爷还是把祖宅钥匙交给了孙女"保管"。

## 人物
- **爷爷**（Ye，男，76 岁）：退休工人，耳背但固执，说话声音洪亮，习惯用方言
- **奶奶**（Nai，女，74 岁）：退休护士，心细如发，总在调停，讲话轻声但精准
- **父亲**（Father，男，35 岁）：中层管理，沉稳务实，习惯先讲数据再讲感情
- **母亲**（Mother，女，34 岁）：小学老师，善于共情，说话慢但每句都落在情绪上
- **女儿**（Xiaoyu，女，22 岁）：应届毕业生，自信张扬，语速快，常引用新词
- **儿子**（Son，男，18 岁）：高三学生，话少但冷幽默，常用一句话噎住全桌

## 场景
- 老北京四合院的中秋家宴，圆桌铺红布，中间摆 3 道家常菜（红烧肉、清蒸鱼、拌黄瓜）
- 头顶挂着 1 盏暖黄吊灯，窗外的槐树叶子微黄，远处有鸽哨
- 背景音：电视机播着晚会、孙子放炮的零星声响

## 镜头（8 镜，密集对话驱动）

### SH01 · 爷爷开场
- **audioMode**：dialogue
- **dialogue**：
  - characterId：爷爷
  - lines.zh："今儿个八月十五，我把话撂这儿——这院子，我要卖了，去养老院。"
  - lines.en："Today is the Mid-Autumn Festival. I want to say this clearly — I'm selling this courtyard. Moving to a nursing home."
  - emotion：倔强，但声音微颤
- **visual**：爷爷放下筷子，环视全桌，吊灯把影子投在红桌布上

### SH02 · 父亲反对
- **audioMode**：dialogue
- **dialogue**：
  - characterId：父亲
  - lines.zh："爸，您别急——咱家四代都住这儿，您去养老院像什么话？"
  - lines.en："Dad, hold on — four generations have lived here. What would people say if you went to a nursing home?"
  - emotion：理性，但喉咙发紧
- **visual**：父亲端起茶杯又放下，手指关节发白

### SH03 · 女儿支持爷爷
- **audioMode**：dialogue
- **dialogue**：
  - characterId：女儿
  - lines.zh："爷爷，您想去就去——房子卖了，正好给我当创业启动资金。"
  - lines.en："Grandpa, if you want to go, go. The sale proceeds can be my startup capital."
  - emotion：自信且轻松
- **visual**：女儿站起来夹了一块红烧肉，手机屏幕亮着"创业计划书"

### SH04 · 母亲劝解
- **audioMode**：dialogue
- **dialogue**：
  - characterId：母亲
  - lines.zh："爸，您看这样行不行——我们搬过来陪您，院子不用卖。"
  - lines.en："Dad, what if we move in with you? No need to sell the courtyard."
  - emotion：温柔，但眼眶红了
- **visual**：母亲给爷爷碗里夹了块鱼，轻轻拍他的手背

### SH05 · 儿子冷幽默
- **audioMode**：dialogue
- **dialogue**：
  - characterId：儿子
  - lines.zh："你们商量完了吗？我还有两套模拟卷。"
  - lines.en："Are you done? I still have two mock papers to finish."
  - emotion：冷幽默
- **visual**：儿子低头用筷子戳拌黄瓜，假装看手机上的倒计时

### SH06 · 奶奶的总结
- **audioMode**：dialogue
- **dialogue**：
  - characterId：奶奶
  - lines.zh："老头子折腾了一辈子，临了想去个清静地方，就随他吧。"
  - lines.en："Your grandfather's been restless his whole life. If he wants peace at the end, let him."
  - emotion：轻声，但一字一顿
- **visual**：奶奶给爷爷碗里倒了一勺汤，手指稳但眼睛没抬

### SH07 · 父亲让步
- **audioMode**：dialogue
- **dialogue**：
  - characterId：父亲
  - lines.zh："行，爸。但养老院得我们挑，费用我们出。"
  - lines.en："Fine, Dad. But we pick the nursing home. We pay the fees."
  - emotion：退让，但眼窝深
- **visual**：父亲点头，红烧肉筷子停在半空

### SH08 · 爷爷交钥匙
- **audioMode**：dialogue
- **dialogue**：
  - characterId：爷爷
  - lines.zh："我把这钥匙给小雨——她要创业，就拿去。院子没了，根还在。"
  - lines.en："I'll give this key to Xiaoyu — she wants to start a business, so take it. The courtyard may go, but the roots stay."
  - emotion：温和、平静、放手
- **visual**：爷爷从口袋里摸出一把铜钥匙，慢慢推到孙女手边，窗外鸽哨响

## 旁白（画外音）
- narrationZh："有些家不是房子，是几代人围坐一桌还能吵起来的地方。"
- narrationEn："A home isn't a house — it's where generations can still argue around the same table."

## 美术风格
暖黄主调，写实北京四合院中秋夜，圆桌+红桌布+暖黄吊灯+全家中景，光线有暖有冷（窗户是冷月，灯下是暖黄），剪辑保留对话张力。

## 剪辑提示
- SH01→SH03 节奏快（家宴爆发期）
- SH04→SH06 节奏放慢（情感沉淀期）
- SH08 用 8 秒长镜头（无剪辑），镜头从爷爷手指慢慢推到孙女手心
- 字幕全程跟随台词，台词镜不上旁白字幕
