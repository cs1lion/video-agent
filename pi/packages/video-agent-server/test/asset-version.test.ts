/**
 * withVersionedAsset 行为测试（重做路径的公共抽象：reshot/retts/两处重绘/重导出全走它）。
 *
 * 背景：2026-08-28 评审发现该抽象此前只对「generate 返回 null」回滚，抛异常时主文件
 * 已 rename 进版本库却无人还原（主名悬空 = 用户旧素材丢失）。三条不变量必须有测试锁死：
 *   ① 先备份再生成；
 *   ② 失败（null 或异常）都要把主文件还原、并把刚 push 的备份项弹出；
 *   ③ 只 pop 自己 push 的那一项（并发安全）。
 *
 * 每个用例独立临时目录：回滚语义强依赖"主文件的初始内容"，用例间共享会互相污染。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { withVersionedAsset } from "../src/asset-version.ts";

const MAIN = "assets/clip-SH03.mp4";
const BACKUP = "assets/clip-SH03_v1.mp4";
const OLD_CONTENT = "old-clip-bytes";
const NEW_CONTENT = "new-clip-bytes";

describe("withVersionedAsset 备份→生成→回滚三段式", () => {
	const roots: string[] = [];

	/** 每个用例独立目录 + 预置旧主文件，避免用例间通过磁盘状态互相污染 */
	async function freshRoot(withMainFile: boolean): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-versioned-asset-"));
		roots.push(dir);
		await mkdir(path.join(dir, "assets"), { recursive: true });
		if (withMainFile) await writeFile(path.join(dir, MAIN), OLD_CONTENT, "utf-8");
		return dir;
	}

	it("generate 成功：旧文件入版本库，返回新主名", async () => {
		const dir = await freshRoot(true);
		const versions: string[] = [];
		const { file } = await withVersionedAsset({
			run: { dir },
			mainRelPath: MAIN,
			versions,
			backupRelPath: BACKUP,
			generate: async () => {
				await writeFile(path.join(dir, MAIN), NEW_CONTENT, "utf-8");
				return MAIN;
			},
		});
		assert.equal(file, MAIN);
		assert.deepEqual(versions, [BACKUP]);
		assert.equal(await readFile(path.join(dir, MAIN), "utf-8"), NEW_CONTENT);
		assert.equal(await readFile(path.join(dir, BACKUP), "utf-8"), OLD_CONTENT);
	});

	it("generate 返回 null：主文件还原，版本项弹出", async () => {
		const dir = await freshRoot(true);
		const versions: string[] = [];
		const { file } = await withVersionedAsset({
			run: { dir },
			mainRelPath: MAIN,
			versions,
			backupRelPath: BACKUP,
			generate: async () => {
				// 模拟生成器写坏主文件后报告失败
				await writeFile(path.join(dir, MAIN), "corrupted", "utf-8");
				return null;
			},
		});
		assert.equal(file, null);
		assert.deepEqual(versions, []);
		assert.equal(await readFile(path.join(dir, MAIN), "utf-8"), OLD_CONTENT);
	});

	it("generate 抛异常：主文件还原，版本项弹出，异常重新上抛", async () => {
		const dir = await freshRoot(true);
		const versions: string[] = [];
		await assert.rejects(
			withVersionedAsset({
				run: { dir },
				mainRelPath: MAIN,
				versions,
				backupRelPath: BACKUP,
				generate: async () => {
					throw new Error("queue exploded");
				},
			}),
			/queue exploded/,
		);
		assert.deepEqual(versions, []);
		assert.equal(await readFile(path.join(dir, MAIN), "utf-8"), OLD_CONTENT);
		// 备份文件已还原回主名，版本库不留孤儿
		await assert.rejects(readFile(path.join(dir, BACKUP), "utf-8"), /ENOENT/);
	});

	it("主文件不存在（首次生成）：不备份，直接生成", async () => {
		const dir = await freshRoot(false);
		const freshMain = "assets/clip-SH09.mp4";
		const versions: string[] = [];
		const { file } = await withVersionedAsset({
			run: { dir },
			mainRelPath: freshMain,
			versions,
			backupRelPath: "assets/clip-SH09_v1.mp4",
			generate: async () => {
				await writeFile(path.join(dir, freshMain), NEW_CONTENT, "utf-8");
				return freshMain;
			},
		});
		assert.equal(file, freshMain);
		assert.deepEqual(versions, []);
		assert.equal(await readFile(path.join(dir, freshMain), "utf-8"), NEW_CONTENT);
	});

	it("并发安全：回滚只 pop 自己刚 push 的项，不碰他人的备份记录", async () => {
		const dir = await freshRoot(true);
		// 列表里已有并发方更早 push 的备份（真实时序：数组尾部是自己刚 push 的项）
		const versions = ["assets/clip-SH04_v1.mp4"];
		await assert.rejects(
			withVersionedAsset({
				run: { dir },
				mainRelPath: MAIN,
				versions,
				backupRelPath: BACKUP,
				generate: async () => {
					// 并发方在此期间 push 了新的备份项，排在自己之前
					versions.unshift("assets/clip-SH04_v2.mp4");
					throw new Error("boom");
				},
			}),
			/boom/,
		);
		// 自己的备份项被弹出，并发方的两条记录原样保留
		assert.deepEqual(versions, ["assets/clip-SH04_v2.mp4", "assets/clip-SH04_v1.mp4"]);
		assert.equal(await readFile(path.join(dir, MAIN), "utf-8"), OLD_CONTENT);
	});

	it("边界：失败时备份项已被并发方顶出末尾 → 保守不动（不误 pop、不误还原）", async () => {
		const dir = await freshRoot(true);
		const versions: string[] = [];
		await assert.rejects(
			withVersionedAsset({
				run: { dir },
				mainRelPath: MAIN,
				versions,
				backupRelPath: BACKUP,
				generate: async () => {
					versions.push("assets/clip-SH04_v2.mp4"); // 并发方在生成期间插队到末尾
					throw new Error("boom");
				},
			}),
			/boom/,
		);
		// 末尾不是自己的备份 → 列表原样保留（宁可不弹，不误弹）
		assert.deepEqual(versions, [BACKUP, "assets/clip-SH04_v2.mp4"]);
	});

	after(async () => {
		for (const dir of roots) await rm(dir, { recursive: true, force: true }).catch(() => {});
	});
});
