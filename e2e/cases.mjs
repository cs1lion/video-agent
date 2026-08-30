/**
 * E2E 用例定义 —— 十套样片（2026-08-30 第五版 · 古今中外）。
 *
 * **全部「台词驱动 + 剧情成片 + 写实真人」**，十个时代与地域（现代北京 / 北宋汴京 /
 * 1937 长江 / 1885 美国西部 / 1941 伦敦 / 盛唐长安 / 1504 佛罗伦萨 / 江户日本 /
 * 1924 巴黎 / 1985 北京胡同），考核面：
 *   - 台词链全流程（A1/D1/reference 口型）+ **跟读双关卡**（包络 + ASR 字面重合，自行配音自动降级重试）
 *   - 配音选角（24 官方音色分龄分性池：旁白与角色错开、角色按人物设计分配、男童女声反串）
 *   - 字幕烧录 + 结构审核；七轴质检（物理/人物/文字/字幕）
 *
 * 字段说明：
 *  - brief      ：一句话需求 + 关键信息（进 EnrichedBrief.creative）
 *  - options    ：技术参数（走 resolveGenerationOptions 白名单校验）
 *  - coSpace    ：共创空间。台词模式（audioDrive=dialogue）必须传，否则 A1 闸门强制回落 off
 *  - bgm        ：背景音乐（{file} 优先本地，缺失时脚本合成占位 WAV）
 *  - postActions：成片之后的动作序列
 *  - expect     ：断言期望（lib/report.mjs 的验收依据）
 *
 * 风格约束：brief 钉死「写实真人」；negativePrompt 排除非写实与乱码文字。
 * 角色描述钉死性别/年龄/发色/服装——人物一致性、配音选角、审核全依赖它。
 * 注意：不要写真实品牌名、真实人名或受版权保护的内容。
 */

/** 写实风格通用负向词 */
const REALISM_NEGATIVE = [
	"anime", "cartoon", "illustration", "3d render", "cgi plastic skin", "painting",
	"watermark", "garbled text", "on-screen captions", "UI overlays", "debug frames",
	"low resolution", "blur", "distorted face", "asymmetric eyes",
	"distorted hands", "extra fingers", "morphing objects",
].join(", ");

export const CASES = [
	{
		id: "F1-modern-alley",
		slug: "alley-noodle-modern",
		title: "《深巷面馆》· 现代中国都市 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：现代中国某城市的深夜深巷面馆。两句旁白开场与收尾（交代这条巷子二十年只卖一碗面），中间是老板与刚收车的女代驾司机小周的一来一往对白——「还是老位置？」「老位置，多加一勺辣」。旁白与对白交织，讲一碗面的默契。",
			keyMessage: "深巷里的灯，为晚归的人留着。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 3, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "老板", description: "55 岁男性面馆老板，花白寸头，深灰色毛线背心配白毛巾搭肩，袖口卷起" },
				{ name: "小周", description: "28 岁女性代驾司机，短黑发，深蓝色代驾反光背心，说话利落" },
			],
			scenes: [
				{ name: "深巷面馆", description: "写实深夜小面馆：暖黄灯泡、瓷砖墙、灶台蒸汽、窗边两张旧方桌" },
			],
			musicBrief: "无音乐，只留灶台蒸汽与巷子夜声。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 3, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F2-ancient-bianjing",
		slug: "bianjing-rain-night",
		title: "《汴河夜雨》· 北宋汴京 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：北宋汴京，虹桥边的夜市落着细雨。落魄书生沈砚之在灯笼摊前与更夫老周避雨对饮，书生叹科举三度落第，更夫讲自己打了三十年更「听遍全城的梦话」。三句旁白交代时辰与雨势，对白朴素见心。写实宋代市井：油纸灯笼、湿石板路、酒旗、乌篷檐滴雨。",
			keyMessage: "灯火不问功名，照人一样亮。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "沈砚之", description: "32 岁男性书生，洗旧的天青色直裰，束发戴小冠，眉目清瘦，手指有茧" },
				{ name: "老周", description: "58 岁男性更夫，灰褐色短褐衣，腰挂铜锣与灯笼，花白胡须，脚步稳" },
			],
			scenes: [
				{ name: "虹桥夜市", description: "写实北宋夜市：油纸灯笼串、湿漉漉石板路反光、酒旗、木檐滴雨、远处桥影" },
			],
			musicBrief: "雨声环境音，远处隐约更锣，收尾一声琴。",
		},
		bgm: null,
		postActions: [{ type: "designReview" }, { type: "keyframeReview" }, { type: "metrics" }],
		expect: {
			minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false,
			requireDesignReview: true, requireKeyframeReview: true,
			requireSubtitlesAudit: true, requireVoiceDistinction: true,
		},
	},

	{
		id: "F3-republic-ferry",
		slug: "yangtze-ferry-1937",
		title: "《三峡夜航》· 1937 长江客轮 · 台词 + BGM",
		audioForm: "dialogue+bgm",
		brief: {
			logline:
				"写实真人剧情短片：1937 年冬，长江夜航客轮的甲板。船员夫妻做最后一遍巡查——妻子清点救生圈念叨时局，丈夫检查缆绳劝她宽心；旁白两句交代这班船连夜送人西去。对白克制，汽笛一声，两人并肩看江面灯火。写实民国江轮：木质甲板、煤油灯、救生圈成排、江雾与灯火。",
			keyMessage: "船往上游走，人往心里回。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "陈海生", description: "45 岁男性江轮水手长，古铜色皮肤，藏青色旧制服外套，花白胡茬，嗓音沙哑沉稳" },
				{ name: "秀珍", description: "42 岁女性，陈海生的妻子，齐耳灰黑短发，深蓝色布衫配围裙，手里攥着一方旧手帕" },
			],
			scenes: [
				{ name: "江轮甲板", description: "写实民国夜航江轮：木质甲板、煤油挂灯、救生圈、缆绳桩、江雾里的灯火" },
			],
			musicBrief: "江风与汽笛环境音，一段旧式弦乐低回。",
		},
		bgm: { file: "assets/bgm.mp3", name: "bgm.mp3", synthIfMissing: true, synthSeconds: 40 },
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: true, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F4-western-stagecoach",
		slug: "dusty-trail-1885",
		title: "《最后一班马车》· 1885 美国西部 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：1885 年美国西部，尘土驿站黄昏。老车夫Cole把最后一班马车停进站，与放下枪多年的老枪手Wade在门廊下对饮咖啡——Cole劝他别再碰枪，Wade说他早就不想听了，但手比脑子诚实。两句旁白交代荒原与黄昏，对白短促见性格。写实西部：黄土主街、木质门廊、马车与马匹、落日长影。",
			keyMessage: "有些人放下枪，是枪先放下了他。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 4, clipDurationSec: 5, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "Cole", description: "60 岁男性马车夫，灰白络腮胡，宽檐毡帽，土黄色风衣，脸上全是风沙纹" },
				{ name: "Wade", description: "48 岁男性退休枪手，深棕色皮背心配白衬衫，左腰空枪套，眼神锐利，鬓角花白" },
			],
			scenes: [
				{ name: "驿站门廊", description: "写实西部驿站：黄土主街、木质门廊与摇椅、拴马桩、落日把影子拉得很长" },
			],
			musicBrief: "口琴与风声，克制。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 4, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F5-london-1941",
		slug: "underground-wedding-1941",
		title: "《防空洞的婚礼》· 1941 伦敦 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：1941 年伦敦大轰炸期间，地铁站台防空洞里。即将归队的年轻士兵George与未婚妻Eileen借着烛光交换戒指，周围是裹着毛毯的邻居——旁白两句交代警报与黄昏，两人低声对白讲「明天的婚礼改到今晚」。写实战时伦敦：地铁站台、铁轨、烛光、行李与毛毯、远处闷响。",
			keyMessage: "警报响的时候，更要说愿意。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "George", description: "24 岁男性英军士兵，卡其色军装外套，短棕发，袖口磨白，手里攥着一枚旧戒指" },
				{ name: "Eileen", description: "22 岁女性，栗色卷发披肩，墨绿色呢子大衣配围巾，眼角有泪光但笑着" },
			],
			scenes: [
				{ name: "地铁站台", description: "写实战时伦敦地铁防空洞：弧形瓷砖墙、铁轨、烛光排、裹毛毯打盹的人群" },
			],
			musicBrief: "远处闷响与近处烛光静谧对比，结尾一句口琴。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F6-tang-lantern",
		slug: "shangyuan-lanterns-tang",
		title: "《上元灯市》· 盛唐长安 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：盛唐上元夜，长安安化门内灯市如昼。扎灯的少女阿绮与巡夜的书吏裴衍在灯棚下斗嘴——她扎的走马灯转得比他的文书快，他查灯油查了一夜。卖糖的小豆子凑热闹念灯谜。三句旁白交代上元与灯火，对白轻快见性情。写实唐风灯市：花灯连绵、胡商驼队剪影、石板路映光、襦裙与幞头。",
			keyMessage: "灯是人间的星星，一年落回地面一次。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "阿绮", description: "17 岁女性扎灯匠，杏色襦裙配深红披帛，双环髻缀小绒花，指尖有灯油与茧，笑起来眉眼弯" },
				{ name: "裴衍", description: "26 岁男性金吾卫书吏，深青色圆领袍配黑色幞头，腰挂木牌与名册，神情严肃但耳根易红" },
				{ name: "小豆子", description: "8 岁男性卖糖小童，粗布短褐，头上总顶着一撮呆毛，手里糖人从不舍得吃" },
			],
			scenes: [
				{ name: "长安灯市", description: "写实盛唐上元灯市：连绵花灯与走马灯、石板路映暖光、远处城楼灯影、人潮衣袂" },
			],
			musicBrief: "市声与 distant 琵琶，热闹但不喧宾夺主。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F7-florence-fresco",
		slug: "florence-apprentice-1504",
		title: "《学徒的壁画》· 1504 佛罗伦萨 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：1504 年佛罗伦萨，湿壁画工作室的清晨。老画师Maestro Benci检查学徒Matteo连夜补的穹顶小天使——翅膀的透视歪了一指，Benci没有骂他，反而讲了自己年轻时毁掉整面墙的那个清晨。两句旁白交代时代与颜料味，师徒对白克制而温热。写实文艺复兴工作室：脚手架、石膏灰、颜料罐、天光从高窗斜切。",
			keyMessage: "大师的第一课，是学会怎么毁掉一面墙。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 4, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "Benci", description: "52 岁男性画师，灰白卷发束在脑后，深蓝色罩衫沾满石膏粉与颜料指印，腰间挂一串小刀" },
				{ name: "Matteo", description: "16 岁男性学徒，亚麻衬衣挽袖，鼻梁有雀斑，双手指缝全是石膏灰，眼神又怕又亮" },
			],
			scenes: [
				{ name: "湿壁画工作室", description: "写实文艺复兴工作室：木脚手架、未完成的穹顶壁画、颜料罐与刷子、高窗天光斜切灰尘" },
			],
			musicBrief: "清晨鸟鸣与远处的钟声，安静克制。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 4, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F8-edo-snow",
		slug: "edo-soba-snow-night",
		title: "《江户雪夜》· 江户日本 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：江户深冬雪夜，日本桥边的小荞麦面摊。收摊前的老板娘阿常给躲雪的落拓武士佐久间多添了一勺热汤——他说身无分文，她说雪天里的客人不算客人。三句旁白交代雪与灯火，对白简短，讲一碗热汤的体面。写实江户夜雪：纸灯笼积雪、木摊蒸汽、蓝染暖帘、木屐声与落雪声。",
			keyMessage: "雪夜里多添的那一勺，是人间还讲理的证据。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 4, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "阿常", description: "54 岁女性荞麦面摊老板娘，靛蓝色和服罩着深色围裙，头发用木簪绾起，手脚麻利，嘴角带笑" },
				{ name: "佐久间", description: "38 岁男性落拓武士，褪色的深灰羽织，佩一柄旧刀，短发束起，肩上落满雪，坐姿仍旧笔直" },
			],
			scenes: [
				{ name: "桥边面摊", description: "写实江户雪夜面摊：木摊蒸汽、纸灯笼积雪、蓝染暖帘、雪片落进灯光里" },
			],
			musicBrief: "落雪声与三味线单音，极简。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 4, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F9-paris-bookshop",
		slug: "left-bank-bookshop-1924",
		title: "《左岸的书店》· 1924 巴黎 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：1924 年巴黎左岸，一间穷作家常蹭暖的书店。年轻记者Eli想赊一本诗集被店主Margot指着账本数落——账本上全是没还钱的大人物名字；最后她把书塞给他，说写出手稿再还。两句旁白交代塞纳河的雾与打字机声，对白机智带刺。写实左岸书店：木书架顶到天花板、黄铜台灯、玻璃门雾气、纸页与烟草味。",
			keyMessage: "书店的账本，记的都是还没写出来的书。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 4, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "Margot", description: "61 岁女性书店主，银灰色发髻别两支钢笔，深绿色针织开衫配长裙，圆框眼镜滑在鼻尖" },
				{ name: "Eli", description: "25 岁男性记者，深灰色粗花呢外套配围巾，头发乱，怀里总夹着一沓稿纸" },
			],
			scenes: [
				{ name: "左岸书店", description: "写实 1920s 巴黎书店：顶天木书架、黄铜台灯、玻璃门雾气、旧沙发与纸堆" },
			],
			musicBrief: "雨刷玻璃声与远处手风琴，轻。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 4, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "F10-beijing-tape",
		slug: "hutong-cassette-1985",
		title: "《胡同磁带》· 1985 北京胡同 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：1985 年北京深秋的胡同大杂院。返城青年大军用三个月零工钱买了台双卡录音机，母亲一边数落他乱花钱一边凑过去听——磁带里是他在农场自己写的歌；邻居大爷端着茶缸子来串门，被音乐勾起了当年文工团的往事。三句旁白交代年代与鸽哨，对白生活气十足。写实 80 年代北京：灰墙红门、蜂窝煤、搪瓷缸、鸽哨掠过屋顶。",
			keyMessage: "日子紧巴的时候，歌是自家酿的糖。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "大军", description: "23 岁男性返城青年，蓝色工装外套配白球鞋，寸头，手里宝贝似的捧着一台双卡录音机" },
				{ name: "母亲", description: "50 岁女性，大军母亲，花白短发别发卡，藏蓝色对襟褂子，围裙没摘，眼角全是笑纹" },
				{ name: "赵大爷", description: "67 岁男性退休文工团员，灰色中山装扣得整齐，鼻梁架老花镜，端着印花搪瓷茶缸" },
			],
			scenes: [
				{ name: "胡同大杂院", description: "写实 80 年代北京大杂院：灰墙红门、蜂窝煤堆、晾衣绳、搪瓷缸、屋顶鸽群与鸽哨" },
			],
			musicBrief: "录音机里的歌声做戏中乐，环境音是鸽哨与自行车铃。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},
];

export function caseById(id) {
	return CASES.find((c) => c.id === id);
}
