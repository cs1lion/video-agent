/**
 * 事件流 ndjson 落盘行为测试（2026-08-28 优化 ③ 引入的路径）。
 *
 * 背景：团队事件此前内嵌在 run-state.json 这个大 JSON 里，每次 pushEvent 都要把最多
 * 400 条事件重新序列化并整体重写文件（第 401 条进来要重写 401 条）。ndjson 化后改为
 * 逐条 append（O(1)，不碰旧数据）。这是一次持久化路径重构，必须有测试锁死语义：
 *   ① append-only：N 次 pushEvent → 文件恰好 N 行、顺序一致；
 *   ② 往返一致：readEventsNdjson 能读回 pushEvent 写下的事件；
 *   ③ 半行损坏 / 缺字段只丢那一行（append 中途崩溃的兜底）；
 *   ④ 文件缺失返回 null（旧 run 走 run-state.json 迁移路径）；
 *   ⑤ 超过 EVENT_CAP(400) 时只保留最近 400 条。
 *
 * 每个用例独立临时目录：与 withVersionedAsset 测试同理，共享目录会互相污染。
 */

import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pushEvent, readEventsNdjson, type TeamEvent } from "../src/pipeline.ts";

/** pushEvent 只消费 run 的 id / dir / events 三个字段，其余与事件落盘无关 */
function fakeRun(dir: string): Parameters<typeof pushEvent>[0] {
	return {
		id: "run-ndjson-test",
		dir,
		events: [] as TeamEvent[],
	} as unknown as Parameters<typeof pushEvent>[0];
}

function eventsFile(dir: string): string {
	return path.join(dir, "events.ndjson");
}

async function appendRaw(dir: string, raw: string): Promise<void> {
	await appendFile(eventsFile(dir), `${raw}\n`, "utf-8");
}

describe("事件流 ndjson 落盘（append-only）", () => {
	const roots: string[] = [];

	async function freshDir(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-events-ndjson-"));
		roots.push(dir);
		return dir;
	}

	after(async () => {
		await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }).catch(() => {})));
	});

	it("N 次 pushEvent → 文件恰好 N 行且顺序一致（不重写旧数据）", async () => {
		const dir = await freshDir();
		const run = fakeRun(dir);
		pushEvent(run, "producer", "client", "user", "第一条");
		pushEvent(run, "producer", "all", "status", "第二条");
		pushEvent(run, "tech", "client", "redo", "第三条");

		const lines = (await readFile(eventsFile(dir), "utf-8"))
			.split("\n")
			.filter((l) => l.trim().length > 0);
		assert.equal(lines.length, 3);
		assert.deepEqual(
			lines.map((l) => (JSON.parse(l) as TeamEvent).text),
			["第一条", "第二条", "第三条"],
		);
	});

	it("往返一致：readEventsNdjson 能读回 pushEvent 写下的事件", async () => {
		const dir = await freshDir();
		const run = fakeRun(dir);
		pushEvent(run, "producer", "client", "user", "A");
		pushEvent(run, "producer", "client", "user", "B");

		const events = readEventsNdjson(dir);
		assert.ok(events, "events.ndjson 存在时应返回事件数组");
		assert.deepEqual(
			events.map((e) => e.text),
			["A", "B"],
		);
		// id 必须对得上：前端按 id 去重合并增量通道与快照通道
		assert.equal(events[0]!.id, run.events[0]!.id);
		assert.equal(events[1]!.id, run.events[1]!.id);
	});

	it("半行损坏 / 缺字段只丢那一行（append 中途崩溃兜底）", async () => {
		const dir = await freshDir();
		const run = fakeRun(dir);
		pushEvent(run, "producer", "client", "user", "A");
		pushEvent(run, "producer", "client", "user", "B");
		// 追加到一半进程被杀：尾部残缺
		await appendRaw(dir, '{"id":"ev-broken","at":"2026-01-01T00:00:00.000Z","fro');
		// 合法 JSON 但缺 text 字段：同样应被跳过
		await appendRaw(dir, '{"id":"ev-nofield"}');

		const events = readEventsNdjson(dir);
		assert.ok(events);
		assert.deepEqual(
			events.map((e) => e.text),
			["A", "B"],
		);
	});

	it("文件缺失返回 null（旧 run 走 run-state.json 迁移路径）", () => {
		assert.equal(readEventsNdjson(path.join(tmpdir(), "pi-events-ndjson-missing-xyz")), null);
	});

	it("超过 EVENT_CAP(400) 时只保留最近 400 条", async () => {
		const dir = await freshDir();
		const lines = Array.from({ length: 430 }, (_, i) =>
			JSON.stringify({
				id: `ev-id-${i}`,
				at: "2026-01-01T00:00:00.000Z",
				from: "producer",
				to: "client",
				kind: "status",
				text: `ev-${i}`,
			}),
		);
		await writeFile(eventsFile(dir), `${lines.join("\n")}\n`, "utf-8");

		const events = readEventsNdjson(dir);
		assert.ok(events);
		assert.equal(events.length, 400);
		assert.equal(events.at(-1)!.text, "ev-429");
		assert.equal(events[0]!.text, "ev-30");
	});
});
