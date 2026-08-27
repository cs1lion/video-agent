/**
 * Studio board — the /studio panel.
 *
 * Renders the production board: project header, per-stage tasks with status
 * icons, artifacts with review status, and the latest role messages.
 * Live-updates while open by subscribing to the StudioContext.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { StudioContext } from "../core/studio-context.ts";
import {
	ARTIFACT_KIND_LABELS,
	ARTIFACT_STATUS_ICONS,
	PIPELINE_STAGES,
	STAGE_LABELS,
	TASK_STATUS_ICONS,
} from "../core/types.ts";

export class StudioBoardComponent {
	private readonly context: StudioContext;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private unsubscribe?: () => void;

	constructor(context: StudioContext, theme: Theme, onClose: () => void) {
		this.context = context;
		this.theme = theme;
		this.onClose = onClose;
		this.unsubscribe = context.onChange(() => this.invalidate());
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.destroy();
			this.onClose();
		}
	}

	destroy(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " 视频工作室任务板 ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 12)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const project = this.context.getProject();
		lines.push(truncateToWidth(`  ${th.fg("toolTitle", th.bold(project.title))}`, width));
		lines.push(truncateToWidth(`  ${th.fg("dim", `状态：${project.status}`)}`, width));
		if (project.brief) {
			lines.push(truncateToWidth(`  ${th.fg("dim", project.brief.slice(0, 100))}`, width));
		}
		lines.push("");

		const tasks = this.context.getTasks();
		for (const stage of PIPELINE_STAGES) {
			const stageTasks = tasks.filter((t) => t.stage === stage);
			if (stageTasks.length === 0) continue;
			const done = stageTasks.filter((t) => t.status === "completed").length;
			lines.push(
				truncateToWidth(
					`  ${th.fg("accent", STAGE_LABELS[stage])} ${th.fg("muted", `${done}/${stageTasks.length}`)}`,
					width,
				),
			);
			for (const task of stageTasks) {
				const icon = TASK_STATUS_ICONS[task.status];
				const feedback = task.reviewFeedback.length > 0 ? th.fg("warning", ` ↻×${task.reviewFeedback.length}`) : "";
				lines.push(
					truncateToWidth(
						`    ${icon} ${th.fg("muted", task.id)} ${
							task.status === "completed" ? th.fg("dim", task.title) : task.title
						}${th.fg("dim", ` → ${task.role}`)}${feedback}`,
						width,
					),
				);
			}
			lines.push("");
		}

		const artifacts = this.context.getArtifacts();
		if (artifacts.length > 0) {
			lines.push(truncateToWidth(`  ${th.fg("accent", "产物")}`, width));
			for (const artifact of artifacts.slice(-12)) {
				const icon = ARTIFACT_STATUS_ICONS[artifact.status];
				const label = `${icon} ${artifact.id} ${ARTIFACT_KIND_LABELS[artifact.kind]}《${artifact.name}》`;
				lines.push(truncateToWidth(`    ${th.fg("muted", label)}${th.fg("dim", ` by ${artifact.role}`)}`, width));
			}
			lines.push("");
		}

		const messages = this.context.getMessages(5);
		if (messages.length > 0) {
			lines.push(truncateToWidth(`  ${th.fg("accent", "最新消息")}`, width));
			for (const message of messages) {
				const preview = message.content.replace(/\n/g, " ").slice(0, 60);
				lines.push(
					truncateToWidth(
						`    ${th.fg("muted", `${message.from}→${message.to}`)} ${th.fg("dim", preview)}`,
						width,
					),
				);
			}
			lines.push("");
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", "按 Escape 关闭")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
