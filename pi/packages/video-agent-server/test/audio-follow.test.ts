/**
 * 台词跟读校验契约测试（qa/audio-follow.ts 纯函数部分）。
 *
 * 背景：reference 模式「模型自行配音」（不可懂人声）只有数值防线能抓——
 * 实测两态分隔极清（跟读失败 -0.227 vs 严格跟读 +0.990），阈值 0.35。
 * 本套用合成波形锁：同形 → 高相关；错位语速/杂乱波形 → 低相关；偏移容忍。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envelope, envelopeCorrelation, pearson, REFERENCE_FOLLOW_THRESHOLD } from "../src/qa/audio-follow.ts";

const SR = 8000;

/** 合成语音状波形：4Hz 基频包络调制的 220Hz 载波（有韵律起伏，像说话） */
function speechLike(seed: number, seconds: number): Int16Array {
	const n = Math.floor(SR * seconds);
	const out = new Int16Array(n);
	for (let i = 0; i < n; i += 1) {
		const t = i / SR;
		const syllable = Math.abs(Math.sin(2 * Math.PI * 4 * t + seed)); // 音节节奏
		const carrier = Math.sin(2 * Math.PI * 220 * t + seed);
		out[i] = Math.round(12000 * syllable * carrier);
	}
	return out;
}

/** 乱语波形：高频噪声 + 随机斩断（模型自行配音的「有吐字但不是人话」形态） */
function babbleLike(seed: number, seconds: number): Int16Array {
	const n = Math.floor(SR * seconds);
	const out = new Int16Array(n);
	let state = seed;
	for (let i = 0; i < n; i += 1) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		const gate = Math.sin(2 * Math.PI * 9 * (i / SR)) > 0 ? 1 : 0.1;
		out[i] = Math.round(((state % 20000) - 10000) * gate * 0.6);
	}
	return out;
}

describe("envelope / pearson（包络与相关）", () => {
	it("同形信号 → 相关≈1；零方差 → 0", () => {
		const a = speechLike(0, 3);
		assert.ok(Math.abs(pearson(envelope(a), envelope(a)) - 1) < 1e-6);
		assert.equal(pearson(envelope(new Int16Array(SR)), envelope(a)), 0, "全零输入零方差 → 0");
	});
});

describe("envelopeCorrelation（跟读判定）", () => {
	it("严格跟读（片音轨=参考音频本身）→ 接近 1，判 follows", () => {
		const ref = speechLike(1, 4);
		const corr = envelopeCorrelation(ref, ref);
		assert.ok(corr > 0.9, `实际 ${corr}`);
		assert.ok(corr >= REFERENCE_FOLLOW_THRESHOLD);
	});

	it("模型自行配音（乱语）→ 低相关，判 not-follows（-0.227 实测形态的合成近似）", () => {
		const ref = speechLike(2, 4);
		const babble = babbleLike(7, 4);
		const corr = envelopeCorrelation(babble, ref);
		assert.ok(corr < REFERENCE_FOLLOW_THRESHOLD, `实际 ${corr} 应低于阈值`);
	});

	it("±1.5s 内起点偏移可容忍（模型延迟开口）", () => {
		const ref = speechLike(3, 5);
		const delayed = new Int16Array(ref.length + SR); // 前垫 1s 静音
		delayed.set(ref, SR);
		const corr = envelopeCorrelation(delayed, ref);
		assert.ok(corr > 0.8, `偏移 1s 应仍高相关，实际 ${corr}`);
	});

	it("超长静音垫尾（A4 补静音形态）不破坏判定", () => {
		const ref = speechLike(4, 2);
		const padded = new Int16Array(SR * 5); // 2s 语音 + 3s 静音（尾部补齐到镜长）
		padded.set(ref, 0);
		const corr = envelopeCorrelation(padded, ref);
		assert.ok(corr > 0.8, `实际 ${corr}`);
	});
});
