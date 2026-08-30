/**
 * 团队在场条：9 个角色的实时工作状态（工作台顶部）。
 * 活跃判定：
 * - 管线角色（编剧/美术/分镜/技术/声音/剪辑）→ 对应后端阶段 running / done
 * - 导演 → 正在回复你（chatBusy）或 run 等待你确认（awaiting）
 * - 审片员 → 重做进行中，或已有质检结论（verdict）算完成
 * - 制片主任 → 接调度活动（B2 厨房汇总）：有未反馈建议=工作中、最近执行已采纳=已交付
 * 图标-only + 状态灯，tooltip 展示职责；名册与首页 TeamGrid 共用 ROLES。
 */

import type { KitchenSummary, RoleId, RunView, StageId } from "@/api/client";
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

function presenceOf(role: RoleId, run: RunView, chatBusy: boolean, kitchen: KitchenSummary | null): Presence {
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
	// 制片主任：接调度活动——有未反馈建议=「有话要说」（呼吸），最近执行已采纳=交付
	if (role === "producer") {
		if (kitchen) {
			const hasUnanswered = kitchen.observations.some((o) =>
				o.suggestions.some((s) => !(o.feedback ?? []).some((f) => f.id === s.id)),
			);
			if (hasUnanswered) return "working";
			const executions = kitchen.observations.flatMap((o) => o.executions ?? []);
			const last = [...executions].sort((a, b) => b.at.localeCompare(a.at))[0];
			if (last?.status === "applied") return "done";
		}
		return "standby";
	}
	return "standby";
}

const PRESENCE_LABEL: Record<Presence, string> = {
	working: "工作中",
	done: "已交付",
	standby: "待命",
};

/** working 的琥珀只留给「需要你」的角色（导演等你确认、制片主任有话要说）；其余进行中=中性+动效 */
const ATTENTION_ROLES: ReadonlySet<RoleId> = new Set(["director", "producer"]);

export function TeamPresence({ run, chatBusy, kitchen }: { run: RunView; chatBusy: boolean; kitchen: KitchenSummary | null }) {
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			{ROLES.map((role) => {
				const presence = presenceOf(role.id, run, chatBusy, kitchen);
				const attention = presence === "working" && ATTENTION_ROLES.has(role.id);
				const Icon = role.icon;
				return (
					<div
						key={role.id}
						title={`${role.label} · ${PRESENCE_LABEL[presence]}\n${role.duty}`}
						className={cn(
							"relative flex size-8 items-center justify-center rounded-lg border transition-colors duration-300",
							attention && "border-amber-300/50 bg-amber-400/10 shadow-[0_0_14px_rgba(251,191,36,0.2)]",
							presence === "working" && !attention && "border-zinc-300/40 bg-white/[0.06] shadow-[0_0_14px_rgba(244,244,245,0.12)]",
							presence === "done" && "border-emerald-400/20 bg-emerald-400/[0.05]",
							presence === "standby" && "border-white/[0.08] bg-white/[0.02]",
						)}
					>
						<Icon
							className={cn(
								"size-3.5",
								attention && "text-amber-300",
								presence === "working" && !attention && "text-zinc-200",
								presence === "done" && "text-emerald-300/80",
								presence === "standby" && "text-zinc-500",
							)}
						/>
						<span className="absolute -bottom-0.5 -right-0.5">
							{presence === "working" ? (
								<StatusDot tone={attention ? "redo" : "active"} />
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
