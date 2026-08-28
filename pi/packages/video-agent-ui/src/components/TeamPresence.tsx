/**
 * 团队在场条：9 个角色的实时工作状态（工作台顶部）。
 * 活跃判定：
 * - 管线角色（编剧/美术/分镜/技术/声音/剪辑）→ 对应后端阶段 running / done
 * - 导演 → 正在回复你（chatBusy）或 run 等待你确认（awaiting）
 * - 审片员 → 重做进行中，或已有质检结论（verdict）算完成
 * - 制片人 → 开跑初期（全部阶段 pending）筹备中；剧本落地后算完成
 * 图标-only + 状态灯，tooltip 展示职责；名册与首页 TeamGrid 共用 ROLES。
 */

import type { RoleId, RunView, StageId } from "@/api/client";
import { ROLES } from "@/components/TeamGrid";
import { StatusDot } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** 管线角色 → 负责的后端阶段（技术导演管关键帧 + 片段两个阶段） */
const ROLE_STAGES: Partial<Record<RoleId, StageId[]>> = {
	writer: ["script"],
	art: ["visual"],
	storyboard: ["prompts"],
	tech: ["keyframes", "clips"],
	sound: ["audio"],
	editor: ["export"],
};

type Presence = "working" | "done" | "standby";

function presenceOf(role: RoleId, run: RunView, chatBusy: boolean): Presence {
	const stageIds = ROLE_STAGES[role];
	if (stageIds) {
		const statuses = stageIds.map((id) => run.stages.find((s) => s.id === id)?.status ?? "pending");
		if (statuses.some((s) => s === "running")) return "working";
		if (statuses.every((s) => s === "done")) return "done";
		return "standby";
	}
	if (role === "director") {
		return chatBusy || run.status === "awaiting" ? "working" : run.status === "done" ? "done" : "standby";
	}
	if (role === "reviewer") {
		if (run.redoActive) return "working";
		return run.verdict ? "done" : "standby";
	}
	// producer：筹备期（全部 pending）工作；剧本出来后退居完成态
	if (role === "producer") {
		const allPending = run.stages.every((s) => s.status === "pending");
		if (allPending && run.status === "running") return "working";
		return run.stages.some((s) => s.status === "done" || s.status === "running") ? "done" : "standby";
	}
	return "standby";
}

const PRESENCE_LABEL: Record<Presence, string> = {
	working: "工作中",
	done: "已交付",
	standby: "待命",
};

export function TeamPresence({ run, chatBusy }: { run: RunView; chatBusy: boolean }) {
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			{ROLES.map((role) => {
				const presence = presenceOf(role.id, run, chatBusy);
				const Icon = role.icon;
				return (
					<div
						key={role.id}
						title={`${role.label} · ${PRESENCE_LABEL[presence]}\n${role.duty}`}
						className={cn(
							"relative flex size-8 items-center justify-center rounded-lg border transition-colors duration-300",
							presence === "working" && "border-amber-300/50 bg-amber-400/10 shadow-[0_0_14px_rgba(251,191,36,0.2)]",
							presence === "done" && "border-emerald-400/20 bg-emerald-400/[0.05]",
							presence === "standby" && "border-white/[0.08] bg-white/[0.02]",
						)}
					>
						<Icon
							className={cn(
								"size-3.5",
								presence === "working" && "text-amber-300",
								presence === "done" && "text-emerald-300/80",
								presence === "standby" && "text-zinc-600",
							)}
						/>
						<span className="absolute -bottom-0.5 -right-0.5">
							{presence === "working" ? (
								<StatusDot tone="redo" />
							) : presence === "done" ? (
								<StatusDot tone="done" />
							) : (
								<StatusDot tone="pending" />
							)}
						</span>
					</div>
				);
			})}
		</div>
	);
}
