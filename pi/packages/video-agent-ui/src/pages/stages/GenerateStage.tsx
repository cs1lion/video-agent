/**
 * CLIPS 阶段：逐镜片段墙 —— 每镜独立播放器 + 补拍历史版本切换。
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { AssetFile, PriorityInstruction, ScriptDoc } from "@/api/client";
import { api } from "@/api/client";
import { ShotPriorityControl } from "@/components/ShotPriorityControl";
import { cn } from "@/lib/utils";
import { EmptyState, StageShell } from "./shared";

const clipName = (s: string) => `clip-${s}.mp4`;

export function GenerateStage({
	runId,
	runStatus,
	assets,
	script,
	shotCount,
	progress,
	shotVersions,
}: {
	runId: string;
	runStatus: string;
	assets: AssetFile[];
	script: ScriptDoc | null;
	shotCount: number;
	/** 0-100，clips 阶段内进度（运行中展示） */
	progress?: number;
	/** 每镜历史版本文件名（补拍备份） */
	shotVersions: Record<string, string[]>;
}) {
	const [view, setView] = useState<Record<string, string>>({});
	const [priorities, setPriorities] = useState<Record<string, PriorityInstruction["priority"]>>({});
	useEffect(() => {
		let alive = true;
		api
			.fetchPriorityInstructions(runId)
			.then((list) => {
				if (!alive) return;
				setPriorities(Object.fromEntries(list.map((i) => [i.shotId, i.priority])));
			})
			.catch(() => {
				// 老 run 无指令文件：空态合法
			});
		return () => {
			alive = false;
		};
	}, [runId]);
	const setPriorityOf = (shotId: string, p: PriorityInstruction["priority"] | undefined) => {
		setPriorities((m) => {
			const next = { ...m };
			if (p) next[shotId] = p;
			else delete next[shotId];
			return next;
		});
	};
	const clips = assets.filter((a) => a.type === "video" && a.name.startsWith("clip-"));
	const shots = assets.filter((a) => a.type === "video" && a.name.startsWith("shot-"));
	const shotIds =
		script?.shots.map((s) => s.id) ??
		Array.from({ length: shotCount }, (_, i) => `SH${String(i + 1).padStart(2, "0")}`);
	/** 优先展示归一化后的片段（与成片一致），无则回退模型原始输出 */
	const clipOf = (id: string) => shots.find((c) => c.name === `shot-${id}.mp4`) ?? clips.find((c) => c.name === clipName(id));

	return (
		<StageShell kicker="STAGE 04 · GENERATION" title="片段生成">
			{clips.length === 0 && shots.length === 0 && (progress === undefined || progress < 100) ? (
				<EmptyState text="技术导演正在逐镜生成视频片段…" />
			) : (
				<div className="grid gap-4 sm:grid-cols-2">
					{shotIds.map((id, idx) => {
						const clip = clipOf(id);
						const versions = (shotVersions[id] ?? []).filter((v) =>
							assets.some((a) => a.name === v),
						);
						const selected = view[id] ?? clip?.name;
						const playing = selected ? assets.find((a) => a.name === selected) ?? clip : clip;

						return (
							<motion.div
								key={id}
								id={`art-${id}`}
								initial={{ opacity: 0, y: 12 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ delay: idx * 0.05 }}
								className="overflow-hidden rounded-xl border border-white/10 bg-black/40"
							>
								{playing ? (
									<div className="relative">
										<video key={playing.url} src={playing.url} controls preload="metadata" className="aspect-video w-full" />
										{/* 监看角标：镜头号 + 暗角，监视器墙观感 */}
										<span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
											{id}
										</span>
										<span className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_62%,rgba(0,0,0,0.42)_100%)]" />
									</div>
								) : (
									<div className="skeleton relative flex aspect-video w-full items-center justify-center">
										<span className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
											<span className="inline-block size-1.5 animate-pulse rounded-full bg-rose-400" />
											REC {id}
										</span>
										<span className="font-mono text-xs text-zinc-500">生成中…</span>
									</div>
								)}
								<div className="space-y-1.5 px-3 py-2">
									<div className="flex items-center gap-2">
										<span className="font-mono text-xs text-zinc-300">{id}</span>
										<span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500">
											{script?.shots.find((s) => s.id === id)?.narrationZh ?? ""}
										</span>
										<ShotPriorityControl
											runId={runId}
											shotId={id}
											value={priorities[id]}
											onChange={(p) => setPriorityOf(id, p)}
											interactive={runStatus === "running"}
										/>
									</div>
									{versions.length > 0 && (
										<div className="flex flex-wrap items-center gap-1">
											<span className="text-[10px] text-zinc-500">版本</span>
											<button
												type="button"
												onClick={() => setView((v) => ({ ...v, [id]: clipName(id) }))}
												className={cn(
													"cursor-pointer rounded-md border px-1.5 py-px font-mono text-[10px] transition-colors",
													selected === clipName(id)
														? "border-zinc-100/40 bg-white/[0.08] text-zinc-100"
														: "border-white/10 text-zinc-500 hover:text-zinc-300",
												)}
											>
												当前
											</button>
											{versions.map((v) => (
												<button
													key={v}
													type="button"
													onClick={() => setView((pv) => ({ ...pv, [id]: v }))}
													className={cn(
														"cursor-pointer rounded-md border px-1.5 py-px font-mono text-[10px] transition-colors",
														selected === v
															? "border-amber-300/50 bg-amber-400/10 text-amber-200"
															: "border-white/10 text-zinc-500 hover:text-zinc-300",
													)}
												>
													{v.replace(/^clip-|\.mp4$/g, "").replace(`${id}_`, "")}
												</button>
											))}
										</div>
									)}
								</div>
							</motion.div>
						);
					})}
				</div>
			)}
		</StageShell>
	);
}
