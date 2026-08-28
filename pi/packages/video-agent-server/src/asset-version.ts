/**
 * 出图/视频/音频资产版本化：所有"重做"路径（reshot/retts/redesignEntity/
 * redesignKeyframe/重导成片）的"备份→生成→回滚"公共模式。
 *
 * 重要不变量：必须**先备份再生成**。顺序反了会把新图误挪进版本库、令主名悬空
 * （原代码注释里反复强调"先备份后生成"——这段模式被复制 4 次后这一点容易被忘记，
 * 抽到 helper 后这一点难再被破坏）。
 *
 * 另一个关键：失败时**只回滚本次刚 push 的 backupRelPath**（不弹别人 push 的项），
 * 多 agent 并发推同一份 versions 列表时不会误 pop。
 *
 * 用法：
 * ```ts
 * const { file } = await withVersionedAsset({
 *   run,
 *   mainRelPath: "assets/clip-SH03.mp4",
 *   versions: run.shotVersions[shotId],
 *   backupRelPath: `assets/clip-SH03_v${versions.length + 1}.mp4`,
 *   generate: () => submitAndAwait(queue, ...),
 * });
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** run.dir 下的主文件路径 */
type MainRelPath = string;
/** run.dir 下的备份文件路径 */
type BackupRelPath = string;

/** withVersionedAsset 需要的最小 RunRecord 形状（避免循环依赖） */
interface RunDir {
	readonly dir: string;
}

export interface WithVersionedAssetArgs {
	run: RunDir;
	/** 主文件相对路径，如 "assets/clip-SH03.mp4" 或 "design-CH01.png" */
	mainRelPath: MainRelPath;
	/** 调用者拥有的版本列表（本函数会 PUSH/POP 原子交互） */
	versions: string[];
	/** 备份的相对路径，如 "assets/design-CH01_v1.png"。需包含完整子路径 */
	backupRelPath: BackupRelPath;
	/** 实际生成调用；返主名（相对 run.dir）或 null */
	generate: () => Promise<string | null>;
}

export interface WithVersionedAssetResult {
	/** 生成成功时为新主名（相对 run.dir），失败/空路径时为 null */
	file: string | null;
}

/**
 * 备份→生成→回滚三段式封装。失败时把刚备份的文件还原为主名，从 versions 弹出。
 * 主文件不存在时不备份直接调用 generate（支持 brand new 镜首次出图）。
 */
export async function withVersionedAsset(args: WithVersionedAssetArgs): Promise<WithVersionedAssetResult> {
	const { run, mainRelPath, versions, backupRelPath, generate } = args;
	if (!mainRelPath) {
		// 主路径为空（brand new 出图、没历史主名）：直接调 generate，不做备份/回滚。
		return { file: await generate() };
	}
	const mainAbs = path.join(run.dir, mainRelPath);
	const backupAbs = path.join(run.dir, backupRelPath);
	let backedUp = false;
	if (fs.existsSync(mainAbs)) {
		await fs.promises.rename(mainAbs, backupAbs).catch(() => {});
		versions.push(backupRelPath);
		backedUp = true;
	}
	const file = await generate();
	if (!file) {
		// 失败还原：仅当 versions 末尾仍是本次刚 push 的 backupRelPath 时才弹出（并发安全）。
		if (backedUp && versions.length > 0) {
			const prev = versions[versions.length - 1]!;
			if (prev === backupRelPath) {
				await fs.promises.rename(backupAbs, mainAbs).catch(() => {});
				versions.pop();
			}
		}
		return { file: null };
	}
	return { file };
}
