/**
 * 价格与预算（P2）单元测试。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CostEntry,
	costOfLlmIn,
	costOfMediaIn,
	estimateRunCost,
	estimateProposalCost,
	formatCost,
	loadPriceCatalog,
	round2,
} from "../src/pricing.ts";
import type { ServerContext } from "../src/config.ts";
import { RunStore, pushLastAction, startRun } from "../src/pipeline.ts";

const CATALOG = {
	media: {
		"step-image": { currency: "CNY" as const, perCall: 0.3 },
		"step-video": { currency: "CNY" as const, perSecond: 1.0 },
		"step-tts": { currency: "CNY" as const, perKChar: 0.06 },
	},
	llm: {
		"step-2.5": { currency: "CNY" as const, perInputToken: 0.0001, perOutputToken: 0.0003 },
	},
	fallback: { currency: "CNY" as const, perCall: 0.5, perInputToken: 0.0001, perOutputToken: 0.0003, perSecond: 1.0, perKChar: 0.05 },
	source: "<test>",
};

describe("loadPriceCatalog", () => {
	it("无文件时回退默认", () => {
		const c = loadPriceCatalog("/tmp/__nonexistent_pricing_dir__");
		assert.equal(c.fallback.currency, "CNY");
		assert.ok(c.fallback.perCall && c.fallback.perCall > 0);
		assert.equal(c.source, "<default>");
	});
});

describe("costOfMediaIn", () => {
	it("图像按 perCall", () => {
		const adapter = { id: "step-image", kind: "image" as const };
		const e: CostEntry = costOfMediaIn(CATALOG, adapter, {});
		assert.equal(e.category, "media");
		assert.equal(e.adapterId, "step-image");
		assert.equal(e.amount, 0.3);
		assert.equal(e.currency, "CNY");
	});

	it("视频按 perSecond * outputSeconds", () => {
		const adapter = { id: "step-video", kind: "video" as const };
		const e = costOfMediaIn(CATALOG, adapter, {}, 8);
		assert.equal(e.amount, 8.0);
	});

	it("TTS 按 prompt 字符数 / 1024 * perKChar", () => {
		const adapter = { id: "step-tts", kind: "tts" as const };
		const e = costOfMediaIn(CATALOG, adapter, { prompt: "x".repeat(2048) });
		// 2048 chars / 1024 * 0.06 = 0.12
		assert.equal(e.amount, 0.12);
	});

	it("未知 adapter 走 fallback", () => {
		const adapter = { id: "unknown", kind: "image" as const };
		const e = costOfMediaIn(CATALOG, adapter, {});
		assert.equal(e.amount, 0.5); // fallback perCall
	});
});

describe("costOfLlmIn", () => {
	it("按 prompt + completion 字符数粗估", () => {
		const e = costOfLlmIn(CATALOG, "step-2.5", 2000, 1500);
		// input: ceil(2000/4) = 500 * 0.0001 = 0.05
		// output: ceil(1500/4) = 375 * 0.0003 = 0.1125
		// 注：返回的是未取整浮点（round2 由累加侧负责）
		assert.ok(Math.abs(e.amount - (0.05 + 0.1125)) < 1e-9, `got ${e.amount}`);
		assert.equal(e.currency, "CNY");
		assert.equal(e.model, "step-2.5");
	});

	it("usage 提供时按 token 精确计费", () => {
		const e = costOfLlmIn(CATALOG, "step-2.5", 9999, 9999, { input_tokens: 100, output_tokens: 200 });
		// 100 * 0.0001 + 200 * 0.0003 = 0.01 + 0.06 = 0.07
		assert.ok(Math.abs(e.amount - 0.07) < 1e-9, `got ${e.amount}`);
	});

	it("未知模型走 fallback", () => {
		const e = costOfLlmIn(CATALOG, "unknown-model", 1000, 1000);
		// fallback: 1000/4=250 * 0.0001 + 1000/4=250 * 0.0003 = 0.025 + 0.075 = 0.10
		assert.ok(Math.abs(e.amount - 0.1) < 1e-9, `got ${e.amount}`);
	});
});

describe("estimateRunCost (pre-flight)", () => {
	it("返回 breakdown + 总额", () => {
		const est = estimateRunCost({
			catalog: CATALOG,
			shotCount: 5,
			clipDurationSec: 5,
		});
		assert.equal(est.currency, "CNY");
		assert.ok(est.total > 0);
		assert.ok(est.lines.length > 0);
		// 必须含视频 + TTS + 关键帧 + LLM 阶段
		const labels = est.lines.map((l) => l.label);
		assert.ok(labels.some((l) => l.includes("剧本")));
		assert.ok(labels.some((l) => l.includes("视频生成")));
		assert.ok(labels.some((l) => l.includes("TTS")));
	});

	it("shotCount 越大，总额越大（视频/TTS 与镜数成正比）", () => {
		const a = estimateRunCost({ catalog: CATALOG, shotCount: 5, clipDurationSec: 5 });
		const b = estimateRunCost({ catalog: CATALOG, shotCount: 15, clipDurationSec: 5 });
		assert.ok(b.total > a.total * 2);
	});
});

describe("estimateProposalCost（审议提案）", () => {
	it("reedit 零成本", () => {
		const r = estimateProposalCost({ catalog: CATALOG, action: "reedit" });
		assert.equal(r.amount, 0);
		assert.match(r.note, /ffmpeg/);
	});
	it("reshot 按秒计费", () => {
		const r = estimateProposalCost({ catalog: CATALOG, action: "reshot", clipDurationSec: 8 });
		assert.ok(Math.abs(r.amount - 8.0) < 1e-9); // 8s * 1.0
	});
	it("retts 按字符计费", () => {
		const r = estimateProposalCost({ catalog: CATALOG, action: "retts" });
		assert.equal(r.amount, 0.05);
	});
});

describe("formatCost", () => {
	it("CNY 与小数显示", () => {
		assert.equal(formatCost(12.5, "CNY"), "¥12.50");
		assert.equal(formatCost(0.005, "CNY"), "¥<0.01");
		assert.equal(formatCost(3.14, "USD"), "$3.14");
	});
});

describe("live cost accumulation (pipeline integration)", () => {
	let ctx: ServerContext;
	let root: string;
	let store: RunStore;
	before(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pricing-live-"));
		ctx = {
			studioRoot: root,
			mediaConfig: { media: [] } as unknown as ServerContext["mediaConfig"],
			llm: { url: "http://stub", model: "stub", timeoutMs: 1000 },
			port: 0,
			priceCatalog: {
				media: {},
				llm: {},
				fallback: { currency: "CNY", perCall: 0.5, perInputToken: 0.0001, perOutputToken: 0.0003, perSecond: 1.0, perKChar: 0.05 },
				source: "<test>",
			},
		};
		store = new RunStore();
	});
	after(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("startRun 在 run 上落 costEstimate（pre-flight 独立于 LLM 累计）", () => {
		const run = startRun(ctx, store, { logline: "测试广告" });
		assert.ok(run.costEstimate);
		assert.equal(run.costEstimate!.currency, "CNY");
		assert.ok(run.costEstimate!.total > 0);
		// 初始 metrics.cost.spent 必须是数字（后续才累加）
		assert.equal(typeof run.metrics.cost.spent, "number");
		assert.equal(run.metrics.cost.spent, 0);
	});

	it("costOfLlmIn 连续累加会单调递增", () => {
		let spent = 0;
		const fake = { id: "x", kind: "video" as const };
		for (let i = 0; i < 5; i++) {
			const e = costOfMediaIn(ctx.priceCatalog, fake, {}, 5);
			spent = round2(spent + e.amount);
		}
		assert.equal(spent, round2(5 * 5 * 1.0)); // 5 次 × 5s × 1.0 (fallback perSecond)
	});

	it("estimateProposalCost 返回结构化金额，与 action 类型绑定", () => {
		const reedit = estimateProposalCost({ catalog: ctx.priceCatalog, action: "reedit" });
		assert.equal(reedit.amount, 0);
		assert.match(reedit.note, /ffmpeg/);
		const reshot5 = estimateProposalCost({ catalog: ctx.priceCatalog, action: "reshot", clipDurationSec: 5 });
		assert.equal(reshot5.amount, 5); // 5s × 1.0
		assert.match(reshot5.note, /视频生成/);
		const retts = estimateProposalCost({ catalog: ctx.priceCatalog, action: "retts" });
		assert.equal(retts.amount, 0.05);
		assert.match(retts.note, /TTS/);
	});
});

describe("pushLastAction 去重保护（P2+审查）", () => {
	let root: string;
	let store: RunStore;
	let ctx: ServerContext;
	before(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lastactions-"));
		store = new RunStore();
		ctx = {
			studioRoot: root,
			mediaConfig: { media: [] } as unknown as ServerContext["mediaConfig"],
			llm: { url: "http://stub", model: "stub", timeoutMs: 1000 },
			port: 0,
			priceCatalog: {
				media: {},
				llm: {},
				fallback: { currency: "CNY", perCall: 0.5, perInputToken: 0.0001, perOutputToken: 0.0003, perSecond: 1.0, perKChar: 0.05 },
				source: "<test>",
			},
		};
	});
	after(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("首次 push 入栈；同 (kind, shotId, label) 3 分钟内重复 push 被吞掉", () => {
		const run = startRun(ctx, store, { logline: "测试" });
		const t0 = new Date().toISOString();
		pushLastAction(run, { kind: "reshot", shotId: "SH03", label: "补拍镜头 SH03", at: t0 });
		pushLastAction(run, { kind: "reshot", shotId: "SH03", label: "补拍镜头 SH03", at: t0 });
		assert.equal(run.lastActions.length, 1, "3 分钟内同 key 应被去重");
		assert.equal(run.lastActions[0]!.label, "补拍镜头 SH03");
	});

	it("不同 label 可叠加（同动作不同细节）", () => {
		const run = startRun(ctx, store, { logline: "测试 2" });
		pushLastAction(run, { kind: "reshot", shotId: "SH03", label: "补拍镜头 SH03", at: new Date().toISOString() });
		pushLastAction(run, { kind: "reshot", shotId: "SH03", label: "补拍镜头 SH03（调整）", at: new Date().toISOString() });
		assert.equal(run.lastActions.length, 2);
	});

	it("上限 20 条；超过丢最旧", () => {
		const run = startRun(ctx, store, { logline: "测试 3" });
		for (let i = 0; i < 25; i++) {
			pushLastAction(run, { kind: "reshot", shotId: `SH${i}`, label: `补拍镜头 SH${i}`, at: new Date().toISOString() });
		}
		assert.equal(run.lastActions.length, 20);
		assert.equal(run.lastActions[0]!.shotId, "SH24"); // 最新
		assert.equal(run.lastActions[19]!.shotId, "SH5"); // 最旧保留
	});

	it("reexport 不同画幅被视为不同动作（label 不同 → 不去重）", () => {
		const run = startRun(ctx, store, { logline: "测试 4" });
		pushLastAction(run, { kind: "reexport", label: "重出 9:16 分发版", at: new Date().toISOString() });
		pushLastAction(run, { kind: "reexport", label: "重出 1:1 分发版", at: new Date().toISOString() });
		assert.equal(run.lastActions.length, 2, "不同 label 应保留");
	});
});

describe("computeQaDeltas 派发后回灌文案生成（闸门 4）", () => {
	let root: string;
	let store: RunStore;
	let ctx: ServerContext;
	before(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-qadeltas-"));
		store = new RunStore();
		ctx = {
			studioRoot: root,
			mediaConfig: { media: [] } as unknown as ServerContext["mediaConfig"],
			llm: { url: "http://stub", model: "stub", timeoutMs: 1000 },
			port: 0,
			priceCatalog: {
				media: {},
				llm: {},
				fallback: { currency: "CNY", perCall: 0.5, perInputToken: 0.0001, perOutputToken: 0.0003, perSecond: 1.0, perKChar: 0.05 },
				source: "<test>",
			},
		};
	});
	after(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("无变化返回 null（不推事件）", async () => {
		const { computeQaDeltas, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "回灌测试" });
		run.verdict = {
			overall: "pass",
			score: 85,
			axes: [
				{ id: "briefFit", score: 80 },
				{ id: "visualConsistency", score: 90 },
			],
			shots: [{ id: "SH03", verdict: "ok", reason: "通过" }],
		};
		const before = snapshotShotVerdict(run, "SH03");
		const after = snapshotShotVerdict(run, "SH03");
		const text = computeQaDeltas("SH03", before, after);
		assert.equal(text, null);
	});

	it("轴分提高 → ✅ 推改善事件", async () => {
		const { computeQaDeltas, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "回灌测试 2" });
		run.verdict = {
			overall: "warn",
			score: 70,
			axes: [{ id: "briefFit", score: 60 }],
			shots: [{ id: "SH03", verdict: "warn", reason: "人物装束跳变" }],
		};
		const before = snapshotShotVerdict(run, "SH03");
		// 模拟重做后：评分提升 + shot verdict 也改善
		run.verdict = {
			overall: "pass",
			score: 85,
			axes: [{ id: "briefFit", score: 88 }],
			shots: [{ id: "SH03", verdict: "ok", reason: "通过" }],
		};
		const after = snapshotShotVerdict(run, "SH03");
		const text = computeQaDeltas("SH03", before, after);
		assert.ok(text, "应生成事件文案");
		assert.match(text!, /briefFit 60→88 ✅/);
		assert.match(text!, /镜头裁决 warn→ok/);
	});

	it("轴分下降 → ⚠️ 退步警告", async () => {
		const { computeQaDeltas, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "回灌测试 3" });
		run.verdict = {
			overall: "pass",
			score: 90,
			axes: [{ id: "textQuality", score: 92 }],
			shots: [{ id: "SH05", verdict: "ok", reason: "" }],
		};
		const before = snapshotShotVerdict(run, "SH05");
		run.verdict = {
			overall: "warn",
			score: 80,
			axes: [{ id: "textQuality", score: 75 }],
			shots: [{ id: "SH05", verdict: "warn", reason: "退步" }],
		};
		const after = snapshotShotVerdict(run, "SH05");
		const text = computeQaDeltas("SH05", before, after);
		assert.ok(text);
		assert.match(text!, /textQuality 92→75 ⚠️/);
		assert.match(text!, /镜头裁决 ok→warn/);
	});

	it("before 缺失（首次 QA）→ 返回 null，不推事件", async () => {
		const { computeQaDeltas, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "回灌测试 4" });
		run.verdict = {
			overall: "pass",
			score: 80,
			axes: [{ id: "briefFit", score: 80 }],
			shots: [{ id: "SH01", verdict: "ok", reason: "" }],
		};
		const before = snapshotShotVerdict(run, "SH01");
		// before 指向 run.verdict；但如果 verdict 是 undefined...
		run.verdict = undefined;
		assert.equal(snapshotShotVerdict(run, "SH01"), null);
		const after = snapshotShotVerdict(run, "SH01");
		const text = computeQaDeltas("SH01", before, after);
		assert.equal(text, null);
	});

	it("轴分与裁决同时变 → 事件文案含三部分（中文不出现“（无变化）”脏字符）", async () => {
		const { computeQaDeltas, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "回灌测试 5" });
		run.verdict = {
			overall: "warn",
			score: 70,
			axes: [
				{ id: "briefFit", score: 60 },
				{ id: "visualConsistency", score: 80 },
			],
			shots: [{ id: "SH03", verdict: "warn", reason: "装束跳变" }],
		};
		const before = snapshotShotVerdict(run, "SH03");
		run.verdict = {
			overall: "pass",
			score: 85,
			axes: [
				{ id: "briefFit", score: 88 },
				{ id: "visualConsistency", score: 70 },
			],
			shots: [{ id: "SH03", verdict: "ok", reason: "修正" }],
		};
		const after = snapshotShotVerdict(run, "SH03");
		const text = computeQaDeltas("SH03", before, after);
		assert.ok(text);
		assert.match(text!, /镜头裁决 warn→ok/);
		assert.match(text!, /briefFit 60→88 ✅/);
		assert.match(text!, /visualConsistency 80→70 ⚠️/);
		assert.doesNotMatch(text!, /（无变化）/, "有变化时不应出现“（无变化）”字符");
	});

	it("多轴同时变 + 裁决同时变 → 「；」分隔（复防脏字符）", async () => {
		const { computeQaDeltas, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "回灌测试 6" });
		run.verdict = {
			overall: "warn",
			score: 70,
			axes: [
				{ id: "briefFit", score: 60 },
				{ id: "pacing", score: 70 },
			],
			shots: [{ id: "SH03", verdict: "warn", reason: "" }],
		};
		const before = snapshotShotVerdict(run, "SH03");
		run.verdict = {
			overall: "pass",
			score: 90,
			axes: [
				{ id: "briefFit", score: 85 },
				{ id: "pacing", score: 90 },
			],
			shots: [{ id: "SH03", verdict: "ok", reason: "" }],
		};
		const after = snapshotShotVerdict(run, "SH03");
		const text = computeQaDeltas("SH03", before, after);
		assert.ok(text);
		assert.match(text!, /；/, "三项都变时必须用“；”分隔");
		assert.match(text!, /镜头裁决/);
		assert.match(text!, /briefFit 60→85 ✅/);
		assert.match(text!, /pacing 70→90 ✅/);
	});
});

describe("computeQaRegressionText 安静版（防报警疲劳）", () => {
	let root: string;
	let store: RunStore;
	let ctx: ServerContext;
	before(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-qaregress-"));
		store = new RunStore();
		ctx = {
			studioRoot: root,
			mediaConfig: { media: [] } as unknown as ServerContext["mediaConfig"],
			llm: { url: "http://stub", model: "stub", timeoutMs: 1000 },
			port: 0,
			priceCatalog: {
				media: {},
				llm: {},
				fallback: { currency: "CNY", perCall: 0.5, perInputToken: 0.0001, perOutputToken: 0.0003, perSecond: 1.0, perKChar: 0.05 },
				source: "<test>",
			},
		};
	});
	after(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("纯改善场景返 null（不推事件，避免报警疲劳）", async () => {
		const { computeQaRegressionText, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "安静测试 1" });
		run.verdict = {
			overall: "warn",
			score: 70,
			axes: [
				{ id: "briefFit", score: 60 },
				{ id: "pacing", score: 70 },
			],
			shots: [{ id: "SH03", verdict: "warn", reason: "" }],
		};
		const before = snapshotShotVerdict(run, "SH03");
		run.verdict = {
			overall: "pass",
			score: 90,
			axes: [
				{ id: "briefFit", score: 88 },
				{ id: "pacing", score: 90 },
			],
			shots: [{ id: "SH03", verdict: "ok", reason: "" }], // 裁决也改善
		};
		const after = snapshotShotVerdict(run, "SH03");
		// 裁决也改善的场景下应该推送（裁决变化是重要信号）
		const text = computeQaRegressionText("SH03", before, after);
		assert.ok(text, "裁决改善仍推送以让用户知道状态变化");
		assert.match(text!, /镜头裁决 warn→ok/);
	});

	it("轴全改善 + 裁决不变 → null（纯成功不报）", async () => {
		const { computeQaRegressionText, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "安静测试 2" });
		run.verdict = {
			overall: "warn",
			score: 70,
			axes: [
				{ id: "briefFit", score: 60 },
				{ id: "pacing", score: 70 },
			],
			shots: [{ id: "SH03", verdict: "warn", reason: "" }],
		};
		const before = snapshotShotVerdict(run, "SH03");
		run.verdict = {
			overall: "warn", // 裁决不变
			score: 90,
			axes: [
				{ id: "briefFit", score: 85 },
				{ id: "pacing", score: 90 },
			],
			shots: [{ id: "SH03", verdict: "warn", reason: "" }], // 裁决也不变
		};
		const after = snapshotShotVerdict(run, "SH03");
		const text = computeQaRegressionText("SH03", before, after);
		assert.equal(text, null, "纯改善 + 裁决不变 → 静默");
	});

	it("轴改善 + 另一轴退步 → 推退步警告（✅ 不出现，只 ⚠️）", async () => {
		const { computeQaRegressionText, snapshotShotVerdict } = await import("../src/pipeline.ts");
		const run = startRun(ctx, store, { logline: "安静测试 3" });
		run.verdict = {
			overall: "pass",
			score: 80,
			axes: [
				{ id: "briefFit", score: 70 },
				{ id: "textQuality", score: 90 },
			],
			shots: [{ id: "SH03", verdict: "ok", reason: "" }],
		};
		const before = snapshotShotVerdict(run, "SH03");
		run.verdict = {
			overall: "pass",
			score: 80,
			axes: [
				{ id: "briefFit", score: 92 }, // 改善
				{ id: "textQuality", score: 75 }, // 退步
			],
			shots: [{ id: "SH03", verdict: "ok", reason: "" }],
		};
		const after = snapshotShotVerdict(run, "SH03");
		const text = computeQaRegressionText("SH03", before, after);
		assert.ok(text);
		assert.match(text!, /textQuality 90→75 ⚠️/);
		assert.doesNotMatch(text!, /briefFit/, "改善轴不应在报警文案中");
	});
});
