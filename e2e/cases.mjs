/**
 * E2E 用例定义 —— 迭代优化轮 · 多轮对话压力片（2026-08-30 第六版）。
 *
 * 本轮考核重点（用户定案）：**台词口型对应台词、多轮对话仍符合逻辑**——
 * 三套全部高密度对白（交替说话人多轮往复），验证 dubOver/跟读校验/选角在
 * 连续对话场景下的稳定性。进阶项：更长单镜（6-8s）、更多镜数（6-7）、
 * 有情绪设计的和弦 BGM（S3 冷调）。
 *
 * 字段说明：
 *  - brief      ：一句话需求 + 关键信息（进 EnrichedBrief.creative）
 *  - options    ：技术参数（走 resolveGenerationOptions 白名单校验）
 *  - coSpace    ：共创空间。台词模式（audioDrive=dialogue）必须传，否则 A1 闸门强制回落 off
 *  - bgm        ：背景音乐（{file} 优先本地，缺失时合成；mood = 和弦合成情绪）
 *  - postActions：成片之后的动作序列
 *  - expect     ：断言期望（lib/report.mjs 的验收依据）
 *
 * 风格约束：brief 钉死「写实真人」；negativePrompt 排除非写实与乱码文字。
 * 角色描述钉死性别/年龄/发色/服装。
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
		id: "S1-late-radio",
		slug: "late-night-radio",
		title: "《深夜电台》· 主播×连线司机 · 四轮对讲",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：深夜电台直播间。女主播方晚接进一位夜班出租车司机陈国平的电话连线——司机说今晚是他开车二十年最想哭的一晚，女儿考上了大学他却在两百公里外跑车；主播安静接话，两人一来一往四轮对讲，旁白两句交代时段与电波。全部情绪靠声音与面部特写完成。",
			keyMessage: "有些路，是开给家里人听的。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 6, clipDurationSec: 7, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "方晚", description: "32 岁女性电台主播，深酒红色衬衫，黑色齐肩发别一枚银夹，戴监听耳机，语速稳" },
				{ name: "陈国平", description: "47 岁男性出租车司机，深蓝色工装夹克，短灰发，胡茬青黑，方向盘上搭着一条旧毛巾" },
			],
			scenes: [
				{ name: "电台直播间", description: "写实的深夜电台：隔音棉墙、调音台推子、一盏桌面暖灯、防喷罩与话筒" },
				{ name: "出租车内", description: "写实的深夜出租车驾驶位：零星路灯光扫过、挂饰轻晃、雨刮未开、仪表微光" },
			],
			musicBrief: "无音乐，只要直播间的安静与车内的引擎底噪。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 6, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "S2-watchmaker",
		slug: "watchmaker-dialogue",
		title: "《修表匠与大学生》· 五轮对讲 · 长镜对白",
		audioForm: "dialogue",
		brief: {
			logline:
				"写实真人剧情短片：老城修表铺。大学生林小满拿来奶奶留下的旧手表请修表匠贺师傅修理——表停在一个特殊的时间点。贺师傅一边拆表一边讲这块表的原主人三十年前来修过它，林小满边听边掉眼泪又笑。五轮对讲来回，旁白两句交代铺子与时间。全部戏在一张工作台与两只手上。",
			keyMessage: "表修的不是时间，是没说完的话。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 7, clipDurationSec: 6, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "贺师傅", description: "58 岁男性修表匠，深棕色旧马甲配白衬衫，右眼戴单目放大镜，花白短发，手极稳" },
				{ name: "林小满", description: "22 岁女性大学生，米白色针织开衫配格子裙，黑长直发，眼睛红肿，攥着一块旧女表" },
			],
			scenes: [
				{ name: "修表铺", description: "写实老修表铺：玻璃柜台、台灯放大镜、挂钟一墙、绿罩工作灯、木质抽屉柜" },
			],
			musicBrief: "无音乐，只要镊子与齿轮的细响。",
		},
		bgm: null,
		postActions: [{ type: "metrics" }],
		expect: { minShots: 7, requireDialogueShots: true, requireTtsAudio: true, requireBgm: false, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},

	{
		id: "S3-tower-night",
		slug: "tower-control-night",
		title: "《塔台夜班》· 管制员×机长 · 四轮对讲 + 冷调 BGM",
		audioForm: "dialogue+bgm",
		brief: {
			logline:
				"写实真人剧情短片：深夜机场塔台。管制员苏青引导一架晚点三小时的航班落地——机长周远航是她二十年前的飞行教官。对话是标准专业术语的克制往来，最后一句绕开术语回到师生。四轮对讲，旁白两句交代风与跑道。写实的塔台夜景：舷窗、雷达屏光、耳机话筒、远处跑道灯。",
			keyMessage: "落地了，就回家。",
		},
		options: {
			resolution: "720p", aspectRatio: "16:9", shotCount: 6, clipDurationSec: 7, fps: 24,
			motionIntensity: "low", detailBoost: true, promptLanguage: "zh",
			negativePrompt: REALISM_NEGATIVE, audioDrive: "dialogue",
		},
		coSpace: {
			characters: [
				{ name: "苏青", description: "35 岁女性塔台管制员，深蓝色制服衬衫，头发一丝不苟束起，戴头戴耳机，眼神专注" },
				{ name: "周远航", description: "51 岁男性机长，白色机长制服四道杠，短黑发掺白，下颌线硬朗，坐姿端正" },
			],
			scenes: [
				{ name: "塔台", description: "写实机场塔台夜间：环形舷窗、雷达屏冷光、通话面板、咖啡杯、远处跑道灯串" },
			],
			musicBrief: "冷调低回的电子底床，克制。",
		},
		bgm: { file: "assets/bgm.mp3", name: "bgm.mp3", synthIfMissing: true, synthSeconds: 45, mood: "cold" },
		postActions: [{ type: "metrics" }],
		expect: { minShots: 6, requireDialogueShots: true, requireTtsAudio: true, requireBgm: true, requireSubtitlesAudit: true, requireVoiceDistinction: true },
	},
];

export function caseById(id) {
	return CASES.find((c) => c.id === id);
}
