# 剧本 C · 法庭上的交叉询问

## 一句话需求
一名年轻律师在法庭上对证人大律师进行交叉询问，对话如利刃般密集，每一句都在拆穿对方的谎言。

## 人物
- **陈律师**（Chen，男，32 岁）：新手诉讼律师，准备充分，语气客气但步步紧逼。
- **张律师**（Zhang，男，45 岁）：资深大律师，经验丰富，试图把每一个问题都引向模糊地带。

## 场景
- 现代法庭，木质栏杆、陪审团席、法官席。午后的阳光从高窗斜射进来，形成光束中的尘埃。

## 镜头（6 镜，密集对话驱动）

### SH01 · 起立
- **audioMode**：dialogue
- **dialogue**：
  - characterId：陈律师
  - lines.zh："张律师，您刚才说您的当事人那天晚上八点就到家了？"
  - lines.en："Counselor Zhang, you just said your client arrived home by eight o'clock that evening?"
  - emotion：礼貌但锐利
- **visual**：陈律师站在证人席前，手里拿着一支笔，轻轻敲击着笔记本。

### SH02 · 第一次确认
- **audioMode**：dialogue
- **dialogue**：
  - characterId：张律师
  - lines.zh："是的，我有通话记录和信用卡账单作证。"
  - lines.en："Yes, I have call records and credit card statements as proof."
  - emotion：自信
- **visual**：张律师站起来，把一份文件递给法庭书记员，动作从容不迫。

### SH03 · 拆穿
- **audioMode**：dialogue
- **dialogue**：
  - characterId：陈律师
  - lines.zh："但这份通话记录显示，那通电话是从距离现场三公里的基站发出的。"
  - lines.en："But this call record shows the call was routed through a cell tower three kilometers from the scene."
  - emotion：精确打击
- **visual**：陈律师用激光笔指向大屏幕上的基站地图，红点闪烁。

### SH04 · 挣扎
- **audioMode**：dialogue
- **dialogue**：
  - characterId：张律师
  - lines.zh："基站覆盖范围很广，三公里并不能证明什么。"
  - lines.en："Cell towers cover a wide area, three kilometers doesn't prove anything."
  - emotion：开始动摇但仍强硬
- **visual**：张律师拿起自己的水杯喝了一口，杯子在抖，水面泛起涟漪。

### SH05 · 致命一击
- **audioMode**：dialogue
- **dialogue**：
  - characterId：陈律师
  - lines.zh："可您当事人的车，那晚在高速出口的摄像头里拍到了。出口离您说的家，有四十公里。"
  - lines.en："But your client's car was caught on a highway exit camera that night. That exit is forty kilometers from the home you mentioned."
  - emotion：冷静收网
- **visual**：陈律师把另一张照片轻轻放在桌上，照片上是一辆白色轿车的车牌特写。

### SH06 · 沉默
- **audioMode**：dialogue
- **dialogue**：
  - characterId：张律师
  - lines.zh："……法官，我需要暂停一下。"
  - lines.en："... Your Honor, I need a brief recess."
  - emotion：罕见地沉默
- **visual**：张律师坐下来，第一次整理自己的领带，陪审团席传来纸张翻动的沙沙声。

## 旁白（画外音）
- narrationZh："法庭上最动人的时刻，往往不是慷慨激昂的陈词，而是某个瞬间的沉默。"
- narrationEn："The most moving moments in court are often not the passionate arguments, but a single moment of silence."

## 美术风格
冷白法庭色调，自然光从高窗射入，强调仪式感与权力空间。

## 剪辑提示
- 对话极快，每镜 3-5 秒；
- SH03 和 SH05 各插入 0.2s 的证据特写闪回；
- 全程硬切，模拟法庭实录的紧迫感。
