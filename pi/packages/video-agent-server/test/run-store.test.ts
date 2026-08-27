/**
 * RunStore 磁盘恢复语义（node:test，经 tsx 运行，零新增依赖）：
 * - running（重启时管线中断）→ failed + 明确错误；
 * - awaiting（确认闸门/refine 停机）→ 原样保留 status 与 gate，可继续确认推进；
 * - done → 原样保留；
 * - 损坏状态文件跳过不致崩溃；run id 序号同步到 counter。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { EnrichedBrief } from "../../video-agent/src/index.ts";
import { type RunStatus, RunStore, runSummary, runView, type StageId } from "../src/pipeline.ts";

const STAGES = ["script", "visual", "prompts", "keyframes", "clips", "audio", "export"] as const;

interface FixtureOverrides {
	status?: RunStatus;
	gate?: "design" | "keyframes";
	id?: string;
}

async function writeRunFixture(root: string, overrides: FixtureOverrides = {}): Promise<void> {
	const id = overrides.id ?? `run-fixture-${Math.random().toString(36).slice(2, 8)}`;
	const dir = path.join(root, id);
	await mkdir(dir, { recursive: true });
	const state = {
		id,
		dir,
		brief: { creative: { logline: "30 秒气泡水广告", keyMessage: "FIZZ" } },
		status: overrides.status ?? ("done" satisfies RunStatus),
		stages: STAGES.map((sid) => ({
			id: sid as StageId,
			status: sid === "script" ? "done" : "pending",
			progress: sid === "script" ? 100 : 0,
		})),
		metrics: { llmCalls: 0, mediaCalls: 0, retries: 0, perAdapter: {} },
		error: undefined,
		images: [],
		events: [],
		shotAttempts: {},
		shotVersions: {},
		ttsAttempts: {},
		ttsVersions: {},
		...(overrides.gate ? { gate: overrides.gate } : {}),
	};
	await writeFile(path.join(dir, "run-state.json"), JSON.stringify(state), "utf-8");
}

describe("RunStore.loadAll 重启恢复语义", () => {
	let root: string;

	it("前置：准备临时 runs 根目录并写入状态文件", async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-video-runs-"));
		await writeRunFixture(root, { id: "run-a-running-1", status: "running" });
		await writeRunFixture(root, { id: "run-b-awaiting-2", status: "awaiting", gate: "design" });
		await writeRunFixture(root, { id: "run-c-done-3", status: "done" });
		await mkdir(path.join(root, "run-d-corrupt-4"), { recursive: true });
		await writeFile(path.join(root, "run-d-corrupt-4", "run-state.json"), "{broken json", "utf-8");
	});

	it("running→failed；awaiting 原样保留（含 gate）；done 保留；损坏文件跳过", () => {
		const store = new RunStore();
		const loaded = store.loadAll(root);
		assert.equal(loaded, 3);

		const crashed = store.get("run-a-running-1")!;
		assert.equal(crashed.status, "failed");
		assert.match(crashed.error ?? "", /服务重启/);

		const awaiting = store.get("run-b-awaiting-2")!;
		assert.equal(awaiting.status, "awaiting"); // 确认态不被重启清掉
		assert.equal(awaiting.gate, "design");
		const view = runView(awaiting);
		assert.equal(view.awaitingResume, true);
		assert.equal(view.gate, "design");
		// 旧 6 阶段状态恢复时自动迁移出独立关键帧阶段（无 keyframes.json = pending）
		assert.equal(awaiting.stages.find((s) => s.id === "keyframes")?.status, "pending");

		const done = store.get("run-c-done-3")!;
		assert.equal(done.status, "done");
		assert.equal(store.get("run-d-corrupt-4"), undefined);

		// 项目列表 API 的数据底座：轻量 summary 不把 events/images 拖进首页历史卡
		assert.deepEqual(
			store.list().map((r) => r.id),
			["run-a-running-1", "run-b-awaiting-2", "run-c-done-3"],
		);
		const summary = runSummary(awaiting, "2026-08-27T00:00:00.000Z");
		assert.equal(summary.gate, "design");
		assert.equal(summary.logline, "30 秒气泡水广告");
		assert.equal(summary.doneStages, 1);
		assert.equal(summary.totalStages, 7);
		assert.equal(summary.updatedAt, "2026-08-27T00:00:00.000Z");
		assert.equal(summary.videoUrl, undefined);
	});

	it("counter 与已恢复的最大序号对齐，新 run 不撞 id 且预挂美术设计闸门", () => {
		const fresh = new RunStore();
		fresh.loadAll(root);
		const record = fresh.create({ creative: { logline: "另一次" } } as EnrichedBrief, root);
		assert.ok(record.id.startsWith("run-"));
		assert.notEqual(record.id, "run-b-awaiting-2");
		assert.equal(record.gate, "design");
		assert.ok(record.dir.includes(".pi-studio"));
	});

	after(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});
});
