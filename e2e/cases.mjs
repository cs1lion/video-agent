/**
 * E2E 用例定义 —— 七套，覆盖 video-agent 最新版完整功能面。
 *
 * 字段说明：
 *  - brief      ：一句话需求 + 关键信息（进 EnrichedBrief.creative）
 *  - options    ：技术参数（走 resolveGenerationOptions 白名单校验）
 *  - coSpace    ：共创空间。**台词模式（audioDrive=dialogue）必须传**，否则 A1 闸门强制回落 off
 *  - bgm        ：背景音乐（{file} 优先本地，缺失时脚本合成占位 WAV）
 *  - postActions：成片之后的动作序列（重做 / 自审 / 制片主任 / 多画幅 / 组合出片）
 *  - expect     ：断言期望（lib/report.mjs 的验收依据）
 *
 * 风格约束：所有 brief 钉死「写实真人」；negativePrompt 排除非写实形态。
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
				"写实真人短片：深夜十一点的城郊公交站，末班车迟迟不来。一位跑了一天外卖的中年男人蹲在站台边，把凉掉的包子掰了一半递给同在等车的女儿。父女在雨声里有一小段压着嗓子的对白，最后车灯由远及近——故事讲「抵达本身就已经是团圆」。",
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
		expect: { minShots: 5, requireDialogueShots: true, requireNarrationAudio: false, requireBgm: false },
	},

	{
		id: "C2-narration",
		slug: "harbor-dawn-narration",
		title: "《开海》· 旁白叙事 · 写实渔村",
		audioForm: "narration",
		brief: {
			logline:
				"写实真人纪录风短片：天没亮的渔港，一位老渔妇独自解开缆绳、检查网眼、发动马达，小船驶出防波堤时太阳正好从海平面抬起来。全片无人物台词，由一段克制的男声旁白串起她三十年的出海日常——讲「重复本身是一种勇气」。",
			keyMessage: "日复一日，也是一种远航。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "off",
		},
		coSpace: null,
		bgm: null,
		postActions: [{ type: "keyframeReview" }, { type: "metrics" }],
		expect: { minShots: 5, requireDialogueShots: false, requireNarrationAudio: true, requireBgm: false },
	},

	{
		id: "C3-bgm-only",
		slug: "city-empty-bgm",
		title: "《空城六分钟》· 纯音乐无旁白 · 写实城市空镜",
		audioForm: "bgm",
		brief: {
			logline:
				"写实空镜短片：清晨五点半的城市，全片没有人物对白、也没有旁白解说，只有街道、蒸汽、第一班地铁与天光渐亮。用六个镜头的推进讲一座城市从沉睡到醒来的完整过程，情绪完全靠画面与背景音乐完成。",
			keyMessage: "城市醒来时，没有人为它配音。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 6, clipDurationSec: 4, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "off",
		},
		coSpace: null,
		bgm: { file: "assets/bgm.mp3", name: "bgm.mp3", synthIfMissing: true, synthSeconds: 45 },
		postActions: [{ type: "metrics" }],
		expect: { minShots: 6, requireDialogueShots: false, requireNarrationAudio: false, requireBgm: true },
	},

	{
		id: "C4-smoke",
		slug: "minimal-smoke",
		title: "最小成本冒烟：3 镜 / 480p / 竖屏写实",
		audioForm: "narration",
		brief: {
			logline:
				"写实竖屏短片：清晨的面馆后厨，老板揉面、下锅、端到窗边第一位客人面前。三镜讲完「一天从一碗面开始」。",
			keyMessage: "热气升起的时候，一天就开始了。",
		},
		options: {
			resolution: "480p", aspectRatio: "9:16", shotCount: 3, clipDurationSec: 4, fps: 24,
			motionIntensity: "low", detailBoost: false, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "off",
		},
		coSpace: null,
		bgm: null,
		postActions: [],
		expect: { minShots: 3, requireDialogueShots: false, requireNarrationAudio: true, requireBgm: false },
	},

	{
		id: "C5-longfilm-review",
		slug: "highway-ten-shots",
		title: "《一千公里》· 10 镜长片 + 出图自审 · 写实公路",
		audioForm: "narration",
		brief: {
			logline:
				"写实真人公路短片：一位退休长途货车司机最后一次跑车，从装货、出城、服务区独坐、暴雨夜驾、到清晨把车钥匙交给徒弟。十镜讲完一段三十年的公路人生，旁白克制，结尾留白。",
			keyMessage: "路会记得每一个把它跑完的人。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 10, clipDurationSec: 5, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "off",
		},
		coSpace: null,
		bgm: null,
		// 长片最容易暴露「设计卡与关键帧漂移」：成片后跑一次双向自审，结论落 02/03 目录
		postActions: [{ type: "designReview" }, { type: "keyframeReview" }, { type: "metrics" }],
		expect: {
			minShots: 10, requireDialogueShots: false, requireNarrationAudio: true, requireBgm: false,
			requireDesignReview: true, requireKeyframeReview: true,
		},
	},

	{
		id: "C6-redo-chain",
		slug: "barber-redo-chain",
		title: "《最后一剪》· 重做链路（补拍/重录/组合出片）· 写实理发店",
		audioForm: "narration",
		brief: {
			logline:
				"写实真人短片：老城区一家开了三十年的理发店，老板最后一次为老街坊剃头、擦镜子、摘下转灯。旁白平静，讲一门手艺的谢幕。",
			keyMessage: "有些门关上，是因为它已经完成了。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 5, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "off",
		},
		coSpace: null,
		bgm: null,
		// 完整的重做链路：补拍最差镜 → 重录一镜旁白 → 组合出片（验证版本化 + 限次台账）
		postActions: [
			{ type: "reshot", pick: "worst", instruction: "把老人手部的动作拍清楚，光线再暖一点" },
			{ type: "retts", pick: "first", instruction: "语气更平静一些，语速放慢" },
			{ type: "compose" },
			{ type: "metrics" },
		],
		expect: {
			minShots: 5, requireDialogueShots: false, requireNarrationAudio: true, requireBgm: false,
			requireReshotVersion: true, requireComposeCut: true,
		},
	},

	{
		id: "C7-producer-multiformat",
		slug: "night-market-producer",
		title: "《夜市收摊》· 制片主任 + 多画幅分发 · 写实夜市",
		audioForm: "narration",
		brief: {
			logline:
				"写实真人短片：凌晨一点的夜市，摊主收摊、洗刷、熄灯，最后推着车走进巷子。旁白只有三句，讲一个城市背面的人如何结束一天。",
			keyMessage: "城市睡着前，有人在替它收拾。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 5, clipDurationSec: 4, fps: 24,
			motionIntensity: "medium", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "off",
		},
		coSpace: null,
		bgm: { file: "assets/bgm.mp3", name: "bgm.mp3", synthIfMissing: true, synthSeconds: 40 },
		// 制片主任 observe/apply（B2 只读建议）+ 导演优先级契约 + 竖屏重导出（多平台分发）
		postActions: [
			{ type: "kitchenObserve" },
			{ type: "kitchenApply" },
			{ type: "reexport", aspectRatio: "9:16" },
			{ type: "metrics" },
		],
		expect: {
			minShots: 5, requireDialogueShots: false, requireNarrationAudio: true, requireBgm: true,
			requirePortraitExport: true, requireKitchenObservation: true,
		},
	},
];

export function caseById(id) {
	return CASES.find((c) => c.id === id);
}
