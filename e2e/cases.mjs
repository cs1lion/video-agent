/**
 * E2E 用例定义 —— 七套，覆盖 video-agent 最新版完整功能面。
 *
 * **2026-08-30 方案变更：全部用例统一为「台词驱动 + 剧情成片」**——
 * 每套都有人物对白（audioDrive=dialogue + coSpace，走 A1 闸门/D1 拆镜/台词 reference 口型链），
 * 每套都产出剧情短片成片（final.mp4）。此前 C2/C4/C5/C6 的旁白形态、C3 的纯 BGM 形态
 * 不再单独设用例；旁白与静音镜仍会作为剧情内的自然组成出现（脚本层按需混排），
 * BGM 能力由 C3/C7 继续覆盖。
 *
 * 字段说明：
 *  - brief      ：一句话需求 + 关键信息（进 EnrichedBrief.creative）
 *  - options    ：技术参数（走 resolveGenerationOptions 白名单校验）
 *  - coSpace    ：共创空间。**台词模式（audioDrive=dialogue）必须传**，否则 A1 闸门强制回落 off
 *  - bgm        ：背景音乐（{file} 优先本地，缺失时脚本合成占位 WAV）
 *  - postActions：成片之后的动作序列（重做 / 自审 / 制片主任 / 多画幅 / 组合出片）
 *  - expect     ：断言期望（lib/report.mjs 的验收依据）
 *
 * 风格约束：所有 brief 钉死「写实真人」；negativePrompt 排除非写实形态与乱码文字。
 * 注意：不要写真实品牌名、真实人名或受版权保护的内容。
 */

/** 写实风格通用负向词（叠加在人物出镜/干净产品预设之上） */
const REALISM_NEGATIVE = [
	"anime", "cartoon", "illustration", "3d render", "cgi plastic skin", "painting",
	"watermark", "garbled text", "on-screen captions", "UI overlays", "debug frames",
	"low resolution", "blur", "distorted face", "asymmetric eyes",
	"distorted hands", "extra fingers", "morphing objects",
].join(", ");

export const CASES = [
	{
		id: "C1-dialogue",
		slug: "city-rain-dialogue",
		title: "《雨夜末班》· 台词驱动 · 写实都市",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：深夜十一点的城郊公交站，末班车迟迟不来。一位跑了一天外卖的中年男人蹲在站台边，把凉掉的包子掰了一半递给同在等车的女儿。父女在雨声里有一小段压着嗓子的对白，最后车灯由远及近——故事讲「抵达本身就已经是团圆」。",
			keyMessage: "再远的路，也有人等你到站。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "老周", description: "46 岁外卖骑手，深蓝旧冲锋衣，胡茬，眼下有疲惫纹路，说话习惯低头" },
				{ name: "周小雨", description: "11 岁女孩，校服外套偏大，背旧书包，头发被雨打湿贴在额角" },
			],
			scenes: [
				{ name: "城郊公交站", description: "深夜写实：褪色广告灯箱、积水倒映暖黄路灯光、远处高架车流是虚焦光斑" },
				{ name: "末班公交车内", description: "写实车厢：空座、冷白顶灯、车窗雨痕与自己的倒影" },
			],
			musicBrief: "低音量钢琴单音 + 雨声环境音，情绪克制，结尾随车灯渐亮微微抬起。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false },
	},

	{
		id: "C2-dialogue",
		slug: "harbor-dawn-dialogue",
		title: "《开海》· 台词驱动 · 写实渔村",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：天没亮的渔港，老渔妇林阿桃带第一次跟她出海的孙女小满解开缆绳、检查网眼、发动马达。小船驶出防波堤时太阳正好从海平面抬起来，祖孙俩在甲板上有几段朴素的对白——奶奶讲三十年前的开海日，孙女问「海那么大，鱼认得你吗」——故事讲「日复一日的重复，本身就是一种勇气」。",
			keyMessage: "日复一日，也是一种远航。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "林阿桃", description: "58 岁渔妇，古铜色皮肤，蓝布头巾，手上全是常年拉网留下的老茧，笑起来眼角很深" },
				{ name: "小满", description: "9 岁女孩，穿 oversized 的橙色救生衣，扎两个辫子，第一次出海既兴奋又抓紧船舷" },
			],
			scenes: [
				{ name: "渔港码头", description: "凌晨四点的写实渔港：缆绳桩、泡沫浮球、柴油味、船灯在湿漉漉地面拉出倒影" },
				{ name: "近海甲板", description: "写实木质渔船甲板：鱼筐、缆绳盘、天光从海平面抬起，防波堤渐远" },
			],
			musicBrief: "海浪环境音为主，一两句独奏口琴，克制而温暖。",
		},
		bgm: null,
		postActions: [{ type: "keyframeReview" }, { type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false },
	},

	{
		id: "C3-dialogue-bgm",
		slug: "city-morning-dialogue-bgm",
		title: "《第一笼蒸汽》· 台词 + BGM · 写实城市清晨",
		audioForm: "dialogue+bgm",
		brief: {
			logline:
				"写实真人剧情短片：清晨五点半的巷口早餐摊，第一笼包子刚上汽。摊主夫妻一边麻利地擀皮、装袋、找零，一边拌着嘴——丈夫嫌妻子把酱料罐摆歪，妻子笑他记错熟客口味；常客小学生跑来买早餐，一段晨光里的短对话。用镜头的推进讲一座城市醒来前的第一桩买卖。",
			keyMessage: "城市醒来时，先有一笼蒸汽。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 6, clipDurationSec: 4, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "陈建国", description: "52 岁早餐摊主，白背心外套深蓝围裙，袖口沾面粉，嗓门大、动作快" },
				{ name: "秀兰", description: "50 岁摊主妻子，碎花罩衣，围着旧毛线围脖，记账找零麻利，爱笑" },
			],
			scenes: [
				{ name: "巷口早餐摊", description: "写实清晨：竹蒸笼冒汽、煤炉火光、旧玻璃柜里的豆浆杯、路灯与天光交替" },
			],
			musicBrief: "轻快的民谣吉他 + 环境人声，音量让位于台词。",
		},
		bgm: { file: "assets/bgm.mp3", name: "bgm.mp3", synthIfMissing: true, synthSeconds: 45 },
		postActions: [{ type: "metrics" }],
		expect: { minShots: 6, requireDialogueShots: true, requireTtsAudio: true, requireBgm: true },
	},

	{
		id: "C4-smoke",
		slug: "minimal-smoke",
		title: "最小成本冒烟：3 镜 / 480p / 竖屏 · 台词驱动",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实竖屏剧情短片：清晨的面馆后厨，老板把一碗面端到窗边熟客面前，熟客说了句「老样子，多放辣」，老板应了一声。三镜讲完「一天从一碗面开始」的对话日常。",
			keyMessage: "热气升起的时候，一天就开始了。",
		},
		options: {
			resolution: "480p", aspectRatio: "9:16", shotCount: 3, clipDurationSec: 4, fps: 24,
			motionIntensity: "low", detailBoost: false, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "老板", description: "40 多岁面馆老板，灰色汗衫，围裙油亮，手上有烫疤" },
				{ name: "熟客", description: "60 岁退休老街坊，马褂式外套，坐窗边固定位置，端碗稳" },
			],
			scenes: [
				{ name: "面馆窗边", description: "写实小面馆：灶台热气、老式吊扇、窗边两张方桌" },
			],
			musicBrief: "无音乐，只有后厨环境声。",
		},
		bgm: null,
		postActions: [],
		expect: { minShots: 3, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false },
	},

	{
		id: "C5-longfilm-review",
		slug: "highway-ten-shots",
		title: "《一千公里》· 10 镜台词长片 + 出图自审 · 写实公路",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人公路剧情短片：退休长途货车司机老崔最后一次跑车，徒弟小江随车。从装货、出城、服务区吃面，到暴雨夜驾驶室里的师徒对话——徒弟劝他退休别跑了，师傅说「方向盘比儿子跟我久」——最后清晨老崔把车钥匙交给徒弟。十镜讲完一段三十年的公路人生，对白克制，结尾留白。",
			keyMessage: "路会记得每一个把它跑完的人。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 10, clipDurationSec: 5, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "老崔", description: "60 岁货车司机，褪色工装夹克，保温杯茶垢，左手搭窗烟不离手" },
				{ name: "小江", description: "24 岁徒弟，卫衣外罩反光背心，坐在副驾总在记路牌" },
			],
			scenes: [
				{ name: "货车驾驶室", description: "写实重卡驾驶室：挂饰晃动、仪表盘、雨刮与湿挡风玻璃" },
				{ name: "高速公路与服务区", description: "写实公路：夜间车灯长曝感、服务区白炽灯、蒸汽大锅面摊" },
			],
			musicBrief: "低音量公路摇滚起，结尾收在单簧管，情绪克制。",
		},
		bgm: null,
		// 长片最容易暴露「设计卡与关键帧漂移」：成片后跑一次双向自审，结论落 02/03 目录
		postActions: [{ type: "designReview" }, { type: "keyframeReview" }, { type: "metrics" }],
		expect: {
			minShots: 10, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false,
			requireDesignReview: true, requireKeyframeReview: true,
		},
	},

	{
		id: "C6-redo-chain",
		slug: "barber-redo-chain",
		title: "《最后一剪》· 台词驱动 + 重做链路（补拍/重录/组合出片）· 写实理发店",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：老城区一家开了三十年的理发店，老板徐师傅最后一次为老街坊赵叔剃头。两人一边剃头一边回忆这条街的旧事——「你还是当年那个毛头小子」「你手艺是街口最稳的」——擦镜子、摘下转灯，讲一门手艺的谢幕。",
			keyMessage: "有些门关上，是因为它已经完成了。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "徐师傅", description: "65 岁理发师，白大褂式工作服，老花镜滑在鼻尖，手稳" },
				{ name: "赵叔", description: "62 岁老街坊，灰色毛呢中山装，围着旧理发围布坐在转椅上" },
			],
			scenes: [
				{ name: "老理发店内", description: "写实老店：转椅、壁挂旧镜、铁皮工具盒、午后斜光里的浮尘" },
			],
			musicBrief: "老收音机质感的弦乐，若有似无。",
		},
		bgm: null,
		// 完整的重做链路：补拍最差镜 → 重录一镜台词/旁白 → 组合出片（验证版本化 + 限次台账）
		postActions: [
			{ type: "reshot", pick: "worst", instruction: "把老人手部的动作拍清楚，光线再暖一点" },
			{ type: "retts", pick: "first", instruction: "语气更平静一些，语速放慢" },
			{ type: "compose" },
			{ type: "metrics" },
		],
		expect: {
			minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false,
			requireReshotVersion: true, requireComposeCut: true,
		},
	},

	{
		id: "C7-producer-multiformat",
		slug: "night-market-producer",
		title: "《夜市收摊》· 台词驱动 + 制片主任 + 多画幅分发 · 写实夜市",
		audioForm: "dialogue+bgm",
		brief: {
			logline:
				"写实真人剧情短片：凌晨一点的夜市，摊主夫妻收摊。妻子数着零钱念叨今天卖了多少，丈夫洗刷铁板应声；隔壁摊主过来收最后一串烤面筋，三两句寒暄；最后两人熄灯推车走进巷子。对白只有几句，讲一个城市背面的人如何结束一天。",
			keyMessage: "城市睡着前，有人在替它收拾。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 4, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "阿德", description: "45 岁烧烤摊主，黑色围裙，手臂有烫伤印，嗓音沙哑" },
				{ name: "阿珍", description: "43 岁摊主妻子，格子衬衫，马尾辫，数钱极快，说话直" },
			],
			scenes: [
				{ name: "夜市烧烤摊", description: "写实夜市收摊时分：铁板余温、塑料凳倒扣、暖黄灯泡串熄灭、蒸汽散尽" },
			],
			musicBrief: "环境人声为主，收尾一句温柔的合成器垫底。",
		},
		bgm: { file: "assets/bgm.mp3", name: "bgm.mp3", synthIfMissing: true, synthSeconds: 40 },
		// 制片主任 observe/apply（B2 只读建议）+ 导演优先级契约 + 竖屏重导出（多平台分发）
		postActions: [
			{ type: "kitchenObserve" },
			{ type: "kitchenApply" },
			{ type: "reexport", aspectRatio: "9:16" },
			{ type: "metrics" },
		],
		expect: {
			minShots: 5, requireDialogueShots: true, requireTtsAudio: true, requireBgm: true,
			requirePortraitExport: true, requireKitchenObservation: true,
		},
	},
];

export function caseById(id) {
	return CASES.find((c) => c.id === id);
}
