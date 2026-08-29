/**
 * SCRIPT 阶段：剧本产物 —— 标题 / 故事线 / 逐镜旁白与画面描述。
 * 支持微调（stageId=script，重跑后停在下一次确认）。
 */

import type { ScriptDoc, StageId } from "@/api/client";
import { cn } from "@/lib/utils";
import { EmptyState, RefineAction, StageShell } from "./shared";

export function ScriptStage({
	script,
	onRefine,
}: {
	script: ScriptDoc | null;
	onRefine?: (stageId: StageId) => void;
}) {
	return (
		<StageShell
			kicker="STAGE 01 · SCRIPT"
			title={`剧本${script?.title ? ` · ${script.title}` : ""}`}
			action={<RefineAction stageId="script" onRefine={onRefine} />}
		>
			{!script ? (
				<EmptyState text="编剧还在打磨剧本，稍候片刻…" />
			) : (
				<div className="space-y-4">
					<p className="text-sm leading-relaxed text-zinc-300">{script.logline}</p>
					<div className="space-y-3">
						{script.shots.map((shot, i) => {
							const mode = shot.audioMode ?? "narration";
							const d = shot.dialogue;
							return (
								<div key={shot.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
									<div className="mb-2 flex items-center gap-3">
										<span className="font-mono text-sm font-semibold text-cyan-300">{shot.id}</span>
										<span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-zinc-500">
											{shot.durationSec}s
										</span>
										{/* A7：声音模式三态徽标 */}
										<span
											className={cn(
												"rounded-full border px-2 py-0.5 text-[10px]",
												mode === "dialogue" && "border-violet-300/40 bg-violet-400/10 text-violet-200",
												mode === "narration" && "border-white/10 text-zinc-500",
												mode === "silent" && "border-zinc-700 text-zinc-600",
											)}
										>
											{mode === "dialogue" ? `台词 · ${d?.characterId ?? "角色"}` : mode === "silent" ? "无声画面" : "旁白"}
										</span>
										<span className="ml-auto font-mono text-[10px] text-zinc-700">SHOT {String(i + 1).padStart(2, "0")}</span>
									</div>
									{/* A7：台词镜子结构（台词/情绪/停顿/表演指导） */}
									{mode === "dialogue" && d && (
										<div className="mb-3 rounded-lg border border-violet-300/20 bg-violet-400/[0.05] px-3 py-2.5">
											<div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px]">
												{d.emotion && <span className="rounded-full border border-violet-300/30 px-2 py-px text-violet-200">情绪 · {d.emotion}</span>}
												{d.pausesSec && d.pausesSec.length > 0 && (
													<span className="rounded-full border border-white/10 px-2 py-px text-zinc-400">
														停顿 · {d.pausesSec.map((p) => `${p}s`).join(" / ")}
													</span>
												)}
												{shot.ttsDirection && <span className="text-zinc-600">指导 · {shot.ttsDirection}</span>}
											</div>
											<p className="text-sm leading-relaxed text-zinc-100">
												<span className="mr-1.5 text-violet-300">{d.characterId}：</span>
												{d.lines.zh}
											</p>
											<p className="mt-0.5 text-xs leading-relaxed text-zinc-500 italic">{d.lines.en}</p>
										</div>
									)}
									<p className="text-sm leading-relaxed text-zinc-100">{shot.narrationZh}</p>
									<p className="mt-1 text-xs leading-relaxed text-zinc-500 italic">{shot.narrationEn}</p>
									<div className="mt-3 rounded-lg bg-black/30 px-3 py-2">
										<div className="mb-1 font-mono text-[10px] tracking-widest text-violet-300/80">VISUAL</div>
										<p className="font-mono text-xs leading-relaxed text-zinc-400">{shot.visual}</p>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</StageShell>
	);
}
