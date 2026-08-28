/**
 * 底部时间线：镜头按实际时长（durationSec）比例排列，片场时间轴观感。
 * 每格 = 关键帧缩略图（无则占位）+ 镜头号 + 状态色条：
 *   emerald=片段已出 · amber=关键帧已出待生成 · zinc=待生产
 * 点击跳转到对应阶段并定位该镜卡片。
 */

import type { AssetFile, KeyframeEntry, ScriptShot } from "@/api/client";
import type { UiStageId } from "@/components/StageRail";
import { cn } from "@/lib/utils";

type ShotStatus = "clip" | "frame" | "pending";

const STATUS_LABEL: Record<ShotStatus, string> = {
	clip: "片段已生成",
	frame: "关键帧已出，待生成视频",
	pending: "待生产",
};

export function TimelineBar({
	shots,
	frames,
	assets,
	activeShot,
	onJump,
}: {
	shots: ScriptShot[];
	frames: KeyframeEntry[] | undefined;
	assets: AssetFile[];
	/** 当前定位的镜头（频道链接跳转后高亮） */
	activeShot?: string | null;
	onJump: (stage: UiStageId, focus: string) => void;
}) {
	const frameOf = (id: string) => frames?.find((f) => f.shotId === id);
	const clipOf = (id: string) =>
		assets.find((a) => a.type === "video" && a.name === `shot-${id}.mp4`) ??
		assets.find((a) => a.type === "video" && a.name === `clip-${id}.mp4`);
	const statusOf = (id: string): ShotStatus => {
		if (clipOf(id)) return "clip";
		const frame = frameOf(id);
		if (frame?.status === "done" && frame.url) return "frame";
		return "pending";
	};

	return (
		<div className="relative z-10 flex shrink-0 items-center gap-2 border-t border-white/[0.07] px-4 py-2">
			<span className="shrink-0 font-mono text-[9px] tracking-[0.25em] text-zinc-600">TIMELINE</span>
			<div className="flex min-w-0 flex-1 gap-[3px]">
				{shots.map((shot) => {
					const status = statusOf(shot.id);
					const frame = frameOf(shot.id);
					const thumb = status !== "pending" ? frame?.url : undefined;
					const target: UiStageId = status === "clip" ? "generate" : status === "frame" ? "keyframes" : "storyboard";
					return (
						<button
							key={shot.id}
							type="button"
							title={`${shot.id} · ${shot.durationSec}s · ${STATUS_LABEL[status]}\n${shot.narrationZh}`}
							onClick={() => onJump(target, shot.id)}
							style={{ flexGrow: Math.max(1, shot.durationSec), minWidth: 40 }}
							className={cn(
								"group relative h-11 min-w-0 cursor-pointer overflow-hidden rounded-md border text-left transition-all",
								activeShot === shot.id
									? "border-amber-300/70 shadow-[0_0_14px_rgba(251,191,36,0.3)]"
									: "border-white/[0.08] hover:border-white/25",
							)}
						>
							{thumb ? (
								<img src={thumb} alt={shot.id} className="h-full w-full object-cover" loading="lazy" />
							) : (
								<span className="block h-full w-full bg-white/[0.03]" />
							)}
							{/* 状态色条 */}
							<span
								className={cn(
									"absolute inset-y-0 left-0 w-0.5",
									status === "clip" && "bg-emerald-400/80",
									status === "frame" && "bg-amber-300/80",
									status === "pending" && "bg-zinc-600/60",
								)}
							/>
							{/* 镜头号 + 时长 */}
							<span className="absolute bottom-0.5 left-1 rounded bg-black/60 px-1 font-mono text-[9px] text-zinc-200">
								{shot.id}
							</span>
							<span className="absolute bottom-0.5 right-1 rounded bg-black/60 px-1 font-mono text-[9px] text-zinc-500 group-hover:text-zinc-300">
								{shot.durationSec}s
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
