/**
 * 无依赖的 BGM 占位音合成：纯 Node 写标准 16-bit PCM WAV。
 * 用途：C3「纯背景音乐」用例在没有本地音乐文件时，也能跑通完整的混音/闪避链路。
 * 音色：两个低频正弦叠加 + 缓慢的音量起伏（避免刺耳，便于听感判断 BGM 是否真的进了时间线）。
 */

import * as fs from "node:fs";

export function synthesizeWav({ seconds = 45, sampleRate = 44100, outPath }) {
	const total = Math.floor(seconds * sampleRate);
	const data = Buffer.alloc(total * 2); // 16-bit mono
	const freqs = [110, 164.81]; // A2 + E3（纯五度）
	for (let i = 0; i < total; i += 1) {
		const t = i / sampleRate;
		// 缓慢起伏（0.12Hz）+ 轻微淡入淡出，避免首尾爆音
		const swell = 0.35 + 0.25 * Math.sin(2 * Math.PI * 0.06 * t);
		const fadeIn = Math.min(1, t / 2);
		const fadeOut = Math.min(1, (seconds - t) / 3);
		let v = 0;
		for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
		v = (v / freqs.length) * swell * fadeIn * fadeOut * 0.5;
		const s = Math.max(-1, Math.min(1, v));
		data.writeInt16LE(Math.round(s * 32767), i * 2);
	}

	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // fmt chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);

	fs.writeFileSync(outPath, Buffer.concat([header, data]));
	return outPath;
}

/** 读本地音乐文件 → dataUrl（服务端按 MIME 白名单校验） */
export function fileToDataUrl(file) {
	const buf = fs.readFileSync(file);
	const ext = file.toLowerCase().split(".").pop();
	const mime =
		ext === "mp3"
			? "audio/mpeg"
			: ext === "wav"
				? "audio/wav"
				: ext === "m4a"
					? "audio/mp4"
					: ext === "ogg"
						? "audio/ogg"
						: ext === "flac"
							? "audio/flac"
							: "audio/mpeg";
	return `data:${mime};base64,${buf.toString("base64")}`;
}
