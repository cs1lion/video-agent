/**
 * E2E 用例定义 —— 十套风格差异化回归片（2026-08-31 · 第七版）。
 *
 * **十种类型风格**（喜/悬/热血/乡土/职场/武侠意境/年代/都市情感/边疆/海岛），
 * 全部「台词驱动 + 剧情成片 + 写实真人」。本轮同时首验：
 *   - 质检-修复自动闭环（QA fail/人物物理 warn 镜自动 reshot，每 run 一轮）
 *   - 字幕 silencedetect 实测人声对齐（替代时长估算）
 *
 * 风格差异：喜剧快切 / 悬疑留白 / 热血快剪 / 乡土纪实 / 职场克制 /
 * 武侠意境 / 年代情感 / 都市轻爱 / 边疆辽阔 / 海岛日常。
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
		id: "G1-comedy-designated-driver",
		slug: "designated-driver-comedy",
		title: "《代驾夜话》· 轻喜剧 · 快节奏对白",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实轻喜剧短片：代驾司机小马接了一位话痨醉客——客户一路吹嘘自己当年「差一点就上市」，小马一句接一句地不动声色拆台，最后客户在小区门口清醒了，反过来请教小马「你们公司还招人吗」。两句旁白，快节奏对白与误会反转，节奏明快剪得碎。",
			keyMessage: "醉话吹出去，清醒收回来。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "小马", description: "26 岁男性代驾司机，深蓝色反光背心，短黑发，面无表情但眼里全是戏" },
				{ name: "钱总", description: "45 岁男性微醺客户，竖条纹衬衫松领带，头发微乱，手里攥着车钥匙转圈" },
			],
			scenes: [
				{ name: "夜间车内", description: "写实代驾夜间车内：方向盘、后视镜挂件、路灯光扫过车内、夜色车流" },
			],
			musicBrief: "轻快拨弦点缀，卡在拆台句上。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G2-suspense-metro",
		slug: "last-metro-diary",
		title: "《末班地铁的日记》· 悬疑留白 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实悬疑短片：末班地铁车厢，加班的女孩许星然捡到一本被人落下的日记，扉页写着「写给捡到它的人」。她按日记里的站名一站站找失主，每站遇到一个线索人物，最后发现日记是留给这条地铁线的告别礼物。旁白三句制造悬念，对白简短克制。写实末班地铁：空荡车厢、隧道灯闪、报站声。",
			keyMessage: "有人把想说的话，留在了最后一班车。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 6, clipDurationSec: 6, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "许星然", description: "27 岁女性加班白领，深灰色大衣配工牌挂绳，黑长发扎低马尾，眼下有倦容但眼神亮" },
				{ name: "值班员", description: "55 岁男性地铁站值班员，藏蓝色制服配制帽，花白鬓角，手里拿着对讲机" },
			],
			scenes: [
				{ name: "末班地铁", description: "写实末班地铁：空荡橙色座椅车厢、隧道灯频闪车窗、报站屏微光" },
			],
			musicBrief: "低频隧道轰鸣，悬念处突然安静。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 6, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G3-sports-tabletennis",
		slug: "dawn-table-tennis",
		title: "《凌晨四点的球馆》· 热血训练 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实热血短片：凌晨四点的老球馆，少年江野和当过省队陪练的父亲江建军加练——父亲喂球又狠又准，少年摔拍子吼「我练不动了」，父亲只回一句「捡回来」。三句旁白交代十年晨训，对白短促带火药味，最后一个球擦网落地的瞬间两人都没说话。写实球馆：旧木地板、成筐的球、汗透的球衣、高窗透进的第一缕天光。",
			keyMessage: "捡回来的不是球，是不服。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "high", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "江野", description: "16 岁男性少年球员，红色球服汗透贴背，短碎发滴汗，手腕缠肌效贴，眼神倔" },
				{ name: "江建军", description: "45 岁男性父亲兼陪练，旧运动外套袖口磨亮，平头有白发，小臂肌肉线条硬，表情不外露" },
			],
			scenes: [
				{ name: "老球馆", description: "写实老训练球馆：磨旧木地板、成筐乒乓球、白炽灯高悬、高窗天光初亮、墙上旧奖旗" },
			],
			musicBrief: "乒乓球击打声为主，收尾一声球鞋摩擦地板。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G4-rural-harvest",
		slug: "harvest-before-rain",
		title: "《抢收前的雨》· 南方乡土 · 纪实质感",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实乡土短片：南方稻田，天气预报说大雨今晚到。父亲贵叔和返乡的女儿秋禾抢收最后两亩稻子——父亲不肯用收割机嫌浪费谷粒，女儿又气又心疼。三句旁白交代天色与收成，对白全是大白话。写实南方稻田：沉甸甸的稻穗、乌云压田、雨点试探、胶鞋踩进泥里。",
			keyMessage: "谷粒回到仓里，雨才敢落下来。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "贵叔", description: "59 岁男性稻农，深皮肤皱纹深，旧军绿雨衣搭肩，卷着裤腿踩泥，草帽绳勒着下巴" },
				{ name: "秋禾", description: "26 岁女性返乡女儿，马尾辫配旧鸭舌帽，长袖衬衫袖子挽到手肘，戴劳保手套抱稻捆" },
			],
			scenes: [
				{ name: "南方稻田", description: "写实南方稻田：沉甸甸金黄稻穗、乌云低垂、田埂泥泞、远山雨雾、麻雀掠过" },
			],
			musicBrief: "蛙声与远处雷声，无配乐。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G5-hospital-first-op",
		slug: "first-surgery-restraint",
		title: "《第一台手术》· 医院 · 职业克制",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实职业短片：县医院手术室，年轻器械护士苏芒第一次配合主刀医师程一舟做急诊阑尾手术。程一舟话极少，每个指令只有两个字「刀」「纱布」；苏芒手快心细，术后程一舟只说了一句「明天继续」。两句旁白交代深夜急诊，职业对白极简克制，情绪全在动作里。写实手术室：无影灯、器械盘、监护仪滴声、口罩上的眼睛。",
			keyMessage: "医生的话越少，说明他越专注。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "程一舟", description: "44 岁男性主刀医师，深绿色手术衣帽全包只露眼睛，眉骨有疤，手部动作极稳" },
				{ name: "苏芒", description: "24 岁女性器械护士，浅绿色手术衣，头发全包进帽子，只露一双专注的眼，手上动作快而轻" },
			],
			scenes: [
				{ name: "县医院手术室", description: "写实县级医院手术室：无影灯、器械台、绿色消毒巾、监护仪微光、墙上时钟" },
			],
			musicBrief: "只有监护仪规律滴声。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G6-wuxia-inn",
		slug: "desert-inn-closing",
		title: "《大漠客栈打烊》· 武侠意境 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实武侠意境短片：大漠边关的小客栈打烊夜。掌柜的秋娘收拾碗筷，多年不走的老镖头秦无边坐在角落喝闷酒——他说这是最后一次走镖回来，刀已经锈在鞘里了。秋娘给他温了壶酒，说刀锈了人才睡得着。三句旁白交代风沙与驼铃，对白古意简淡，意境苍凉无打斗。写实地貌：黄土墙、油灯、酒坛、门外沙丘月色。",
			keyMessage: "刀锈了，人就该歇了。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "秋娘", description: "48 岁女性客栈掌柜，靛蓝布衣配深色围裙，发髻插木簪，眼角细纹，擦碗的手不停" },
				{ name: "秦无边", description: "60 岁男性老镖头，深灰色旧布袍，花白长须，腰间一柄锈鞘长刀，指节粗大" },
			],
			scenes: [
				{ name: "大漠客栈", description: "写实大漠客栈夜：黄土墙、油灯如豆、粗瓷酒坛、木桌木凳、门外沙丘与月色" },
			],
			musicBrief: "风沙声与远处驼铃，极简。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G7-factory-1998",
		slug: "workshop-1998-farewell",
		title: "《一九九八的车间》· 年代情感 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实年代短片：1998 年冬，国营机床厂车间。老师傅顾长根收到车间的转岗名单，徒弟大刘把自己的名字悄悄换成了徒弟的——被顾长根发现后师徒在机床边有一场压着嗓子的争执：「我五十了你是二十五」「厂里养过我全家」。三句旁白交代厂房与年代，年代情感厚重。写实国营车间：老机床、铁皮工具柜、车间广播、哈气成雾的冬天。",
			keyMessage: "机器不停，人就得往前走。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "顾长根", description: "52 岁男性老师傅，深蓝色厂服配套袖，鸭舌帽檐压得低，指缝有机油，眼神硬" },
				{ name: "大刘", description: "26 岁男性学徒工，同款深蓝厂服袖子卷起，短黑发，手背有伤疤，喉结滚动忍着话" },
			],
			scenes: [
				{ name: "国营车间", description: "写实九十年代国营车间：老式机床、铁皮工具柜、高窗积雪天光、车间广播喇叭、哈气成雾" },
			],
			musicBrief: "车间机器低鸣与广播残响。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G8-rooftop-ot",
		slug: "office-rooftop-lights",
		title: "《加班楼的灯》· 都市情感 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实都市情感短片：深夜写字楼天台，连续加班三周的程序员陆一鸣和产品经理夏澄上来透气，两人隔着栏杆聊「如果明天辞职了想干什么」——从互相打趣到说出真话：他想回家陪爷爷收一季稻，她想在楼下的桥边开一家旧书店。三句旁白交代城市灯火，对白轻巧渐进。写实天台夜景：栏杆、城市灯海、风、两杯便利店的关东煮。",
			keyMessage: "灯是给别人看的，话是说给自己人的。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "陆一鸣", description: "29 岁男性程序员，深灰色连帽卫衣配工牌挂绳，短黑发微乱，手里捧着关东煮纸杯" },
				{ name: "夏澄", description: "28 岁女性产品经理，燕麦色大衣配米色围巾，长发披肩，倚着栏杆转手机" },
			],
			scenes: [
				{ name: "写字楼天台", description: "写实的深夜写字楼天台：金属栏杆、城市灯海虚化、风起发丝、两杯便利店热食" },
			],
			musicBrief: "城市底噪与极轻的钢琴单音。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G9-frontier-post",
		slug: "pamir-mail-route",
		title: "《帕米尔邮路》· 边疆 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实边疆短片：帕米尔高原的邮路上，马背邮递员艾力和哨所年轻士兵小杨在垭口相遇——小杨等家里的包裹等了两个月，艾力把最上层的信递给他：大学的录取通知书到了。两句旁白交代海拔与风，对白朴实，讲一条邮路串起的牵挂。写实高原：雪峰、经幡、马蹄踏雪、邮包上的冰碴。",
			keyMessage: "海拔四千米，信照样到。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "艾力", description: "38 岁男性马背邮递员，古铜色脸庞，深绿色旧棉大衣配皮帽，邮包搭在肩上，笑起来露白牙" },
				{ name: "小杨", description: "20 岁男性边防士兵，军大衣配绒帽，脸被风吹得通红，站姿笔直，接过信时手在抖" },
			],
			scenes: [
				{ name: "高原垭口", description: "写实帕米尔垭口：雪峰连绵、经幡在风里、马蹄踏雪、邮包冰碴、天空湛蓝到发黑" },
			],
			musicBrief: "高原风声与马铃，辽阔留白。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "G10-island-exam",
		slug: "fishing-raft-exam",
		title: "《渔排上的考试》· 海岛日常 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实海岛短片：南海渔排上，初三女孩海花在网箱边的木板屋里上网课，台风预警让回岛的渡轮停航——班主任林老师冒雨坐渔船把试卷送到渔排。师生在摇晃的渔排上完成一场特殊的考试，父亲在旁默默收网。三句旁白交代台风与海，对白带着海风味。写实海上渔排：浮桶、木板屋、渔网与浮标、雨点打在海面。",
			keyMessage: "浪再大，课不能停。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 6, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "海花", description: "14 岁女性渔家女孩，黑色马尾配旧红发绳，校服外套罩着防雨塑料布，膝上摊着试卷" },
				{ name: "林老师", description: "36 岁女性班主任，短发别耳，深蓝色雨衣滴水，怀里抱着用塑料袋裹了三层的试卷袋" },
			],
			scenes: [
				{ name: "海上渔排", description: "写实南海渔排：浮桶木板屋、渔网浮标、远处避风港船影、雨点砸在海面起白点" },
			],
			musicBrief: "雨打渔排声与远处海浪。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},
];

export function caseById(id) {
	return CASES.find((c) => c.id === id);
}
