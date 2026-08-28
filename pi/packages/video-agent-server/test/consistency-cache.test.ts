/**
 * 一致性预检指纹缓存的行为测试（2026-08-28 优化 ④）。
 *
 * 缓存类 bug 是最典型的**静默故障**，两类都要有回归锁：
 *   - 永不失效 → 用户一直看过期结论（该重算却吃到旧缓存）；
 *   - 永不命中 → 优化等于没做（每次照样烧 15-40s + token）。
 *
 * 为什么不端到端测 checkConsistency：它内部要调 ffmpeg 把关键帧压成 640px JPEG，
 * 依赖真实二进制与真实图片，做集成测试重且易碎。而**缓存的命中/失效只由指纹决定**，
 * 所以这里直接测 framesFingerprint 的语义 + getConsistency 的往返，覆盖同样的风险面。
 */

import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { type ConsistencyDoc, framesFingerprint, getConsistency } from "../src/consistency.ts";

type Run = Parameters<typeof framesFingerprint>[0];

/** 指纹与缓存读取只依赖 run.dir */
function fakeRun(dir: string): Run {
	return { dir } as unknown as Run;
}

describe("一致性预检指纹缓存（命中/失效语义）", () => {
	const roots: string[] = [];

	async function freshDir(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-consistency-"));
		await mkdir(path.join(dir, "assets"), { recursive: true });
		roots.push(dir);
		return dir;
	}

	/** 造两张关键帧（内容不同），返回 checkConsistency 传给指纹函数的形状 */
	async function writeFrames(dir: string): Promise<{ shotId: string; file: string }[]> {
		const files = ["assets/kf-SH01.png", "assets/kf-SH02.png"];
		await writeFile(path.join(dir, files[0]!), "PNG-BYTES-1");
		await writeFile(path.join(dir, files[1]!), "PNG-BYTES-2");
		return [
			{ shotId: "SH01", file: files[0]! },
			{ shotId: "SH02", file: files[1]! },
		];
	}

	after(async () => {
		await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }).catch(() => {})));
	});

	it("稳定性：帧文件没动 → 指纹不变（否则缓存永不命中，优化白做）", async () => {
		const dir = await freshDir();
		const frames = await writeFrames(dir);
		assert.equal(framesFingerprint(fakeRun(dir), frames), framesFingerprint(fakeRun(dir), frames));
		assert.match(framesFingerprint(fakeRun(dir), frames), /^[0-9a-f]{16}$/);
	});

	it("失效：关键帧内容变化（尺寸不同）→ 指纹必变", async () => {
		const dir = await freshDir();
		const frames = await writeFrames(dir);
		const before = framesFingerprint(fakeRun(dir), frames);
		await writeFile(path.join(dir, frames[0]!.file), "PNG-BYTES-1-REDRAWN-MUCH-LONGER");
		assert.notEqual(framesFingerprint(fakeRun(dir), frames), before);
	});

	it("失效：仅 mtime 变化、尺寸不变 → 指纹也要变（重绘同尺寸图不能吃旧缓存）", async () => {
		const dir = await freshDir();
		const frames = await writeFrames(dir);
		const before = framesFingerprint(fakeRun(dir), frames);
		const target = path.join(dir, frames[0]!.file);
		const sizeBefore = fsSync.statSync(target).size;

		// 只动 mtime，内容与尺寸保持完全一致（用 utimes 精确控制，避免依赖写入时序）
		fsSync.utimesSync(target, new Date(), new Date(Date.now() + 3000));
		assert.equal(fsSync.statSync(target).size, sizeBefore, "本用例前提：尺寸必须不变");

		assert.notEqual(framesFingerprint(fakeRun(dir), frames), before);
	});

	it("失效：帧集合变化（新增一帧）→ 指纹必变", async () => {
		const dir = await freshDir();
		const frames = await writeFrames(dir);
		const before = framesFingerprint(fakeRun(dir), frames);
		await writeFile(path.join(dir, "assets/kf-SH03.png"), "PNG-BYTES-3");
		const after = framesFingerprint(fakeRun(dir), [
			...frames,
			{ shotId: "SH03", file: "assets/kf-SH03.png" },
		]);
		assert.notEqual(after, before);
	});

	it("getConsistency 往返：带 fingerprint 的文档能读回（缓存可复用）", async () => {
		const dir = await freshDir();
		const doc: ConsistencyDoc = {
			checkedAt: "2026-08-28T00:00:00.000Z",
			model: "step-1.5v-mini",
			fingerprint: "abcdef0123456789",
			overall: "整体一致",
			shots: [{ shotId: "SH01", appearance: "灰绿色T恤", issues: [] }],
		};
		await writeFile(path.join(dir, "consistency.json"), JSON.stringify(doc), "utf-8");

		const read = await getConsistency(fakeRun(dir));
		assert.deepEqual(read, doc);
		assert.equal(read?.fingerprint, doc.fingerprint);
	});

	it("getConsistency 容错：文件缺失 / shots 非数组 → 返回 null（不阻塞管线）", async () => {
		const dir = await freshDir();
		assert.equal(await getConsistency(fakeRun(dir)), null);

		await writeFile(path.join(dir, "consistency.json"), '{"overall":"坏档"}', "utf-8");
		assert.equal(await getConsistency(fakeRun(dir)), null);
	});
});
