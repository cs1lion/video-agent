/**
 * reexportRun —— 重新导出成片（不重新生成镜头与配音，只重跑 export 阶段）。
 *
 * 关键设计：
 * 1. 同步占位 + bail：消除双提交竞态窗口
 * 2. aspectRatio 白名单：仅 16:9/9:16/1:1/4:3 可指定，否则报错
 * 3. 复用现有镜头/配音：仅重跑 stageExport（含转场决策 + 混音 + 烧字幕）
 * 4. 同步函数 + 异步 IIFE：调用方立即拿到 { ok: true }，实际导出在后台跑
 * 5. 不计入手动配额（export 不是模型生成）
 * 6. run.redoActive 在 finally 清理
 *
 * 调用方：POST /api/runs/:id/reexport
 * 依赖：pipeline.ts 的 stageXxx / executeStages + asset-version.ts
 */

import { type AspectRatio } from "../../../video-agent/src/index.ts";
import {
	type RunRecord,
	executeStages,
	optionsOf,
	persistRun,
	pushEvent,
	setStage,
	stage,
} from "../pipeline.ts";
import type { ServerContext } from "../config.ts";

/** 重新导出支持的画幅白名单 */
const REEXPORT_ASPECTS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3"];

/** 同步入口（实际导出在后台跑）。用于 HTTP 端点立即返回。 */
export function reexportRun(
	ctx: ServerContext,
	run: RunRecord,
	aspectRatio?: string,
): { ok: boolean; error?: string } {
	if (run.status === "running") return { ok: false, error: "管线运行中，请稍候" };
	const audioDone = stage(run, "audio").status === "done";
	const clipsDone = stage(run, "clips").status === "done";
	if (!clipsDone || !audioDone) return { ok: false, error: "镜头与配音尚未全部完成，无法重新导出" };

	let targetAspect: AspectRatio | undefined;
	if (aspectRatio !== undefined) {
		if (!REEXPORT_ASPECTS.includes(aspectRatio as AspectRatio)) {
			return {
				ok: false,
				error: `不支持的画幅 ${aspectRatio}（可选 ${REEXPORT_ASPECTS.join(" / ")}）`,
			};
		}
		targetAspect = aspectRatio as AspectRatio;
	}
	run.exportAspectRatio = targetAspect;

	const aspectNote =
		targetAspect && targetAspect !== optionsOf(run).aspectRatio
			? `（目标画幅 ${targetAspect}，多平台分发版）`
			: "";
	pushEvent(
		run,
		"producer",
		"editor",
		"redo",
		`收到重新导出请求：按现有镜头与配音重跑剪辑（转场决策 + 混音${run.status === "done" ? "（含最新 BGM）" : ""}）${aspectNote}。`,
	);
	setStage(run, "export", "pending", 0);
	run.verdict = undefined;
	run.videoUrl = undefined;
	run.status = "running";
	run.redoActive = {
		kind: "reexport",
		label: aspectNote ? `重出 ${targetAspect} 分发版` : "重新导出成片",
	};
	// 推一条最近动作账本（用于审议去重）
	persistRun(run);
	void executeStages(ctx, run, ["export"], { fromResume: true })
		.catch(() => {})
		.finally(() => {
			run.redoActive = null;
			persistRun(run);
		});
	return { ok: true };
}
