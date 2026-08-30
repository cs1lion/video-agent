/**
 * 流水线实况：后端 7 阶段横向 DAG（编剧 → 美术 → 分镜 → 关键帧 → 片段 → 声音 → 剪辑）。
 * - 传 stages：实时模式（工作台 / 有 run 的场景）
 * - demo：自循环演示动画（首页展示用），阶段依次点亮走一遍
 * 节点状态灯复用 StatusDot，连线复用 .flow-line 流动虚线。
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
	BookOpenText,
	Clapperboard,
	Film,
	Images,
	Palette,
	Video,
	Volume2,
} from "lucide-react";
import type { RunStage, StageId } from "@/api/client";
import { StatusDot } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export interface PipelineNode {
	id: StageId;
	label: string;
	role: string;
	icon: typeof Film;
}

export const PIPELINE_NODES: readonly PipelineNode[] = [
	{ id: "script", label: "剧本", role: "编剧", icon: BookOpenText },
	{ id: "visual", label: "美术设计", role: "美术指导", icon: Palette },
	{ id: "prompts", label: "分镜提示词", role: "分镜师", icon: Film },
	{ id: "keyframes", label: "分镜关键帧", role: "技术导演", icon: Images },
	{ id: "audio", label: "声音设计", role: "声音设计", icon: Volume2 },
	{ id: "clips", label: "片段生成", role: "技术导演", icon: Video },
	{ id: "export", label: "成片导出", role: "剪辑师", icon: Clapperboard },
] as const;

type NodeStatus = "pending" | "running" | "done" | "failed";

export function PipelineFlow({
	stages,
	demo = false,
	className,
	audioDrive,
}: {
	/** 实时阶段状态（RunView.stages）；缺省且 demo=false 时全部 pending */
	stages?: RunStage[];
	/** 演示模式：阶段循环点亮（首页展示用） */
	demo?: boolean;
	className?: string;
	/** 台词驱动模式——clips 节点标注「台词先录 · 口型后生成」（声音设计已前置于片段生成） */
	audioDrive?: "off" | "dialogue";
}) {
	// demo 游标：0..len 依次 running，len+1 时全部 done，随后归零重来
	const [cursor, setCursor] = useState(0);
	useEffect(() => {
		if (!demo) return;
		const timer = setInterval(() => {
			setCursor((c) => (c + 1) % (PIPELINE_NODES.length + 2));
		}, 1300);
		return () => clearInterval(timer);
	}, [demo]);

	const statusOf = (id: StageId, idx: number): NodeStatus => {
		if (demo) {
			if (idx < cursor) return "done";
			if (idx === cursor) return "running";
			return "pending";
		}
		return stages?.find((s) => s.id === id)?.status ?? "pending";
	};

	return (
		<div className={cn("overflow-x-auto pb-1", className)}>
			<div className="flex min-w-[760px] items-stretch">
				{PIPELINE_NODES.map((node, idx) => {
					const status = statusOf(node.id, idx);
					const running = status === "running";
					const done = status === "done";
					const failed = status === "failed";
					const Icon = node.icon;
					const upstreamDone = idx === 0 ? false : statusOf(PIPELINE_NODES[idx - 1].id, idx - 1) === "done";

					return (
						<div key={node.id} className="flex flex-1 items-center">
							{idx > 0 && (
								<div
									className={cn(
										"mx-2 h-px w-5 shrink-0",
										upstreamDone ? "flow-line" : "flow-line-dim",
									)}
								/>
							)}
							<motion.div
								initial={{ opacity: 0, y: 10 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-40px" }}
								transition={{ duration: 0.35, delay: idx * 0.05 }}
								className={cn(
									"relative flex-1 rounded-xl border px-3 py-2.5 transition-colors duration-300",
									running && "border-amber-300/50 bg-amber-400/10 shadow-[0_0_24px_rgba(251,191,36,0.18)]",
									done && "border-emerald-400/25 bg-emerald-400/[0.06]",
									failed && "border-rose-400/40 bg-rose-400/[0.07]",
									status === "pending" && "border-white/10 bg-white/[0.03]",
								)}
							>
								{running && (
									<span className="redo-bar absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/80 to-transparent" />
								)}
								<div className="flex items-center gap-2">
									<Icon
										className={cn(
											"size-3.5 shrink-0",
											running && "text-amber-300",
											done && "text-emerald-300",
											failed && "text-rose-300",
											status === "pending" && "text-zinc-500",
										)}
									/>
									<span
										className={cn(
											"flex-1 truncate text-xs font-medium",
											status === "pending" ? "text-zinc-500" : "text-zinc-100",
										)}
									>
										{node.label}
									</span>
									{running ? (
										<StatusDot tone="redo" />
									) : done ? (
										<StatusDot tone="done" />
									) : failed ? (
										<StatusDot tone="error" />
									) : (
										<StatusDot tone="pending" />
									)}
								</div>
								<div className="mt-0.5 pl-[22px] text-[10px] text-zinc-500">
									{audioDrive === "dialogue" && node.id === "clips" ? (
										<span className="text-amber-300/80">台词先录 · 口型后生成</span>
									) : (
										node.role
									)}
								</div>
							</motion.div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
