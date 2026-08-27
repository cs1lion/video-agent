/**
 * 继续制作：轻量展示最近 run（运行中 / 等待确认 / 已完成均可恢复）。
 * 与 Showreel 分开：Showreel 只展示成品；这里保证未完成项目始终有回工作台的入口。
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowUpRight, History } from "lucide-react";
import { api, type RunSummary } from "@/api/client";

const STATUS_LABEL: Record<RunSummary["status"], { label: string; tone: string }> = {
	running: { label: "制作中", tone: "border-cyan-300/40 bg-cyan-400/10 text-cyan-200" },
	awaiting: { label: "待确认", tone: "border-amber-300/45 bg-amber-400/10 text-amber-200" },
	done: { label: "已完成", tone: "border-emerald-300/45 bg-emerald-400/10 text-emerald-200" },
	failed: { label: "已中断", tone: "border-rose-300/45 bg-rose-400/10 text-rose-200" },
	cancelled: { label: "已取消", tone: "border-white/15 bg-white/5 text-zinc-400" },
};

function gateLabel(run: RunSummary): string | null {
	if (run.status !== "awaiting" || !run.gate) return null;
	return run.gate === "design" ? "美术设计" : "关键帧";
}

export function RecentProjects() {
	const navigate = useNavigate();
	const [runs, setRuns] = useState<RunSummary[] | null>(null);

	useEffect(() => {
		let alive = true;
		api
			.listRuns(6)
			.then((list) => {
				if (alive) setRuns(list);
			})
			.catch(() => {
				if (alive) setRuns([]);
			});
		return () => {
			alive = false;
		};
	}, []);

	if (!runs || runs.length === 0) return null;

	return (
		<section>
			<div className="mb-4 flex items-end justify-between gap-4">
				<div>
					<div className="shiny-text mb-1 font-mono text-[10px] tracking-[0.35em]">CONTINUE</div>
					<h2 className="text-lg font-semibold text-zinc-100">继续制作</h2>
				</div>
				<span className="hidden items-center gap-1 font-mono text-xs text-zinc-500 sm:flex">
					<History className="size-3.5" />
					{runs.length} 个项目
				</span>
			</div>
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{runs.map((run, idx) => {
					const status = STATUS_LABEL[run.status];
					const gate = gateLabel(run);
					return (
						<motion.button
							key={run.id}
							type="button"
							initial={{ opacity: 0, y: 12 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-30px" }}
							transition={{ duration: 0.32, delay: idx * 0.04 }}
							onClick={() => navigate(`/studio/${encodeURIComponent(run.id)}`)}
							className="group flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-amber-300/40 hover:bg-white/[0.06]"
						>
							<div className="flex items-center gap-2">
								<span className={`rounded-full border px-2 py-0.5 text-[10px] ${status.tone}`}>
									{gate ? `${status.label}${gate}` : status.label}
								</span>
								<span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
									{run.doneStages}/{run.totalStages}
								</span>
								<ArrowUpRight className="size-3.5 shrink-0 text-zinc-600 transition-colors group-hover:text-amber-200" />
							</div>
							<p className="line-clamp-2 text-sm leading-relaxed text-zinc-200">{run.logline}</p>
						</motion.button>
					);
				})}
			</div>
		</section>
	);
}
