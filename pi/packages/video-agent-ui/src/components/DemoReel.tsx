/**
 * 作品墙：拉取最近 run，挑出有成片（videoUrl）的做视频卡。
 * hover 播放、点击进对应工作台；一条成片都没有时整块隐藏（不摆空展位）。
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowUpRight, Play } from "lucide-react";
import { api, type RunSummary } from "@/api/client";

export function DemoReel() {
	const navigate = useNavigate();
	const [runs, setRuns] = useState<RunSummary[] | null>(null);

	useEffect(() => {
		let alive = true;
		api
			.listRuns(12)
			.then((list) => {
				if (!alive) return;
				setRuns(list.filter((r) => r.videoUrl).slice(0, 4));
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
					<div className="shiny-text mb-1 font-mono text-[10px] tracking-[0.35em]">SHOWREEL</div>
					<h2 className="text-lg font-semibold text-zinc-100">最近出炉的成片</h2>
				</div>
				<span className="font-mono text-xs text-zinc-500">{runs.length} 部作品</span>
			</div>
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{runs.map((run, idx) => (
					<motion.button
						key={run.id}
						type="button"
						initial={{ opacity: 0, y: 14 }}
						whileInView={{ opacity: 1, y: 0 }}
						viewport={{ once: true, margin: "-40px" }}
						transition={{ duration: 0.4, delay: idx * 0.06 }}
						onClick={() => navigate(`/studio/${encodeURIComponent(run.id)}`)}
						className="group relative cursor-pointer overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] text-left transition-colors hover:border-amber-300/40"
					>
						<div className="relative aspect-video overflow-hidden">
							<video
								src={api.videoUrl(run.id)}
								muted
								loop
								playsInline
								preload="metadata"
								className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
								onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
								onMouseLeave={(e) => {
									e.currentTarget.pause();
									e.currentTarget.currentTime = 0;
								}}
							/>
							<div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
							<div className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full border border-white/20 bg-black/40 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
								<Play className="size-3.5 text-amber-200" />
							</div>
							<div className="absolute inset-x-0 bottom-0 p-3">
								<p className="line-clamp-2 text-xs leading-relaxed text-zinc-100">{run.logline}</p>
								<div className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-200/90 opacity-0 transition-opacity group-hover:opacity-100">
									查看工作台
									<ArrowUpRight className="size-3" />
								</div>
							</div>
						</div>
					</motion.button>
				))}
			</div>
		</section>
	);
}
