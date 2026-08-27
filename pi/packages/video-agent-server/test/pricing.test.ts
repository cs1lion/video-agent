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
import { RunStore, startRun } from "../src/pipeline.ts";

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
				fallback: { currency: "CNY", perCall: 0.5, perInputToken: 0.0001, perOutputToken: 0.0003, perSecond: 0.8, perKChar: 0.05 },
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
		assert.equal(spent, round2(5 * 5 * 0.8)); // 5 次 × 5s × 0.8
	});
});
