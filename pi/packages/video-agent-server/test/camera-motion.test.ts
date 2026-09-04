/**
 * 拼接安全：hasCameraMotion 检测函数（2026-09-01 补遗 §5 落地）。
 *
 * 该函数被 export 阶段的拼接感兜底调用：邻镜 clip prompt 含镜头运动词 + 转场 ≠ cut → 强制 cut。
 * 因为这个决策直接决定最终成片里有没有"xfade + 运镜"叠加的拼接缝，必须锁。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasCameraMotion } from "../src/prompts.ts";

describe("hasCameraMotion（拼接感兜底）", () => {
	// ----- 命中：含镜头运动词 -----
	it("dolly push-in 是运镜（拼接安全要求 cut）", () => {
		assert.equal(hasCameraMotion("medium shot, slow dolly push-in on the detective"), true);
	});
	it("handheld 跟拍是运镜", () => {
		assert.equal(hasCameraMotion("handheld follow shot, shaky cam, urgent mood"), true);
	});
	it("pan / tilt / tracking 都是运镜", () => {
		assert.equal(hasCameraMotion("slow pan left across the room"), true);
		assert.equal(hasCameraMotion("tilt up to reveal the ceiling"), true);
		assert.equal(hasCameraMotion("tracking shot following the suspect"), true);
	});
	it("zoom / pull-back / crane / steadicam 都是运镜", () => {
		assert.equal(hasCameraMotion("slow zoom into the face"), true);
		assert.equal(hasCameraMotion("pull-back reveals the courtyard"), true);
		assert.equal(hasCameraMotion("crane shot rising above the city"), true);
		assert.equal(hasCameraMotion("steadicam enters the room"), true);
	});
	it("大小写不敏感", () => {
		assert.equal(hasCameraMotion("DOLLY PUSH-IN"), true);
		assert.equal(hasCameraMotion("Handheld Follow"), true);
	});

	// ----- 命中：连字符与空格都接受 -----
	it("push-in / push in 两种写法都命中", () => {
		assert.equal(hasCameraMotion("push-in slowly"), true);
		assert.equal(hasCameraMotion("push in slowly"), true);
	});
	it("pull-back / pull back 都命中", () => {
		assert.equal(hasCameraMotion("pull-back to wide"), true);
		assert.equal(hasCameraMotion("pull back wide"), true);
	});

	// ----- 不命中：纯对话/静态镜头 -----
	it("无运镜词的纯对话镜不命中", () => {
		assert.equal(
			hasCameraMotion("medium close-up of two men sitting at a metal table, cold overhead light"),
			false,
		);
	});
	it("static locked-off shot 不命中", () => {
		assert.equal(hasCameraMotion("static locked-off wide shot of the room"), false);
	});
	it("空字符串不命中", () => {
		assert.equal(hasCameraMotion(""), false);
	});

	// ----- 边界：词边界必须严格（避免误命中） -----
	it("'panning' 不命中（不在词表里；只命中 pan）", () => {
		// panning 不是精确词，应通过 "pan" 命中（因为 pan 后面跟字母会被 \\b 拒绝）
		assert.equal(hasCameraMotion("panning shot"), false);
	});
	it("'follows' 不命中（不在词表里）", () => {
		// "follows" 不是 "follow"；要严格词边界
		assert.equal(hasCameraMotion("he follows her down"), false);
	});
});
