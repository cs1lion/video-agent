/**
 * 左侧阶段导航（64px 纯图标条）：9 个 UI 阶段 ↔ 后端 7 管线阶段映射。
 * 锁定规则：产物未生成的阶段不可进入（brief 恒开）。
 * 阶段名/状态说明进 tooltip；激活态为琥珀描边（冷灰工业：单 accent）。
 */

import { motion } from "framer-motion";
import {
	BookOpenText,
	Clapperboard,
	FileVideo,
	Film,
	Images,
	Lock,
	Palette,
	ShieldCheck,
	Video,
	Volume2,
} from "lucide-react";
import type { RunStage, RunView, StageId } from "@/api/client";
import { StatusDot } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export type UiStageId =
	| "brief"
	| "script"
	| "bible"
	| "storyboard"
	| "keyframes"
	| "generate"
	| "review"
	| "post"
	| "export";

export interface UiStage {
	id: UiStageId;
	label: string;
	icon: typeof Film;
	/** 对应的后端管线阶段（决定解锁） */
	backend: StageId | null;
	/** 产物 JSON 是否已就绪（对文本阶段：读到 artifacts；对媒体阶段：存在资产/verdict/videoUrl） */
	unlocked(run: RunView, artifactsReady: boolean, hasAssets: boolean, hasKeyframes: boolean): boolean;
}

export const UI_STAGES: readonly UiStage[] = [
	{
		id: "brief",
		label: "需求简报",
		icon: FileVideo,
		backend: null,
		unlocked: () => true,
	},
	{
		id: "script",
		label: "剧本",
		icon: BookOpenText,
		backend: "script",
		unlocked: (_run, artifactsReady) => artifactsReady,
	},
	{
		id: "bible",
		label: "美术设计",
		icon: Palette,
		backend: "visual",
		unlocked: (run, artifactsReady) => artifactsReady || stageOf(run, "visual") !== "pending",
	},
	{
		id: "storyboard",
		label: "分镜提示词",
		icon: Film,
		backend: "prompts",
		unlocked: (run, artifactsReady) => artifactsReady || stageOf(run, "prompts") !== "pending",
	},
	{
		id: "keyframes",
		label: "分镜关键帧",
		icon: Images,
		backend: null,
		unlocked: (run, _ar, _ha, hasKeyframes) =>
			hasKeyframes || stageOf(run, "prompts") === "done" || stageOf(run, "clips") !== "pending",
	},
	{
		id: "generate",
		label: "片段生成",
		icon: Video,
		backend: "clips",
		unlocked: (run, _ar, hasAssets) => hasAssets || stageOf(run, "clips") !== "pending",
	},
	{
		id: "post",
		label: "声音设计",
		icon: Volume2,
		backend: "audio",
		unlocked: (run, _ar, hasAssets) => hasAssets || stageOf(run, "audio") !== "pending",
	},
	{
		id: "review",
		label: "质量审读",
		icon: ShieldCheck,
		backend: "export",
		unlocked: (run) => Boolean(run.verdict) || stageOf(run, "export") !== "pending",
	},
	{
		id: "export",
		label: "成片交付",
		icon: Clapperboard,
		backend: "export",
		unlocked: (run) => Boolean(run.videoUrl),
	},
];

function stageOf(run: RunView, id: StageId): RunStage["status"] {
	return run.stages.find((s) => s.id === id)?.status ?? "pending";
}

/** 迷你进度环（进度只挂在当前 process 步骤上） */
function MiniProgressRing({ value, amber }: { value: number; amber: boolean }) {
	const r = 6;
	const c = 2 * Math.PI * r;
	const v = Math.max(0, Math.min(100, value));
	return (
		<svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90">
			<circle cx="8" cy="8" r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
			<circle
				cx="8"
				cy="8"
				r={r}
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				className={amber ? "stroke-amber-300" : "stroke-zinc-100"}
				strokeDasharray={c}
				strokeDashoffset={c * (1 - v / 100)}
				style={{ transition: "stroke-dashoffset 0.4s ease" }}
			/>
		</svg>
	);
}

/** 重做波及的后端阶段（origin 在首位：补拍→镜头生成 / 重录→音频 / 重出→导出） */
function redoStagesOf(redo: RunView["redoActive"]): StageId[] {
	if (!redo) return [];
	if (redo.kind === "reshot") return ["clips", "export"];
	if (redo.kind === "retts") return ["audio", "export"];
	return ["export"];
}

export function StageRail({
	run,
	artifactsReady,
	hasAssets,
	hasKeyframes,
	active,
	onSelect,
}: {
	run: RunView;
	artifactsReady: boolean;
	hasAssets: boolean;
	hasKeyframes: boolean;
	active: UiStageId;
	onSelect: (id: UiStageId) => void;
}) {
	return (
		<nav className="flex h-full w-16 shrink-0 flex-col items-center gap-1.5 py-3">
			{UI_STAGES.map((stage) => {
				const open = stage.unlocked(run, artifactsReady, hasAssets, hasKeyframes);
				const isActive = stage.id === active;
				const backendStatus = stage.backend ? stageOf(run, stage.backend) : null;
				const Icon = stage.icon;
				const redo = run.redoActive;
				const redoStages = redoStagesOf(redo);
				// 重做态：该镜对应后端阶段（origin 首位）→ 琥珀呼吸；重做波及的下游 → 琥珀微光
				const isRedoOrigin = Boolean(redo && stage.backend && redoStages[0] === stage.backend);
				const isRedoAffected =
					Boolean(redo && stage.backend && redoStages.includes(stage.backend) && !isRedoOrigin) ||
					(Boolean(redo) && backendStatus === "running");
				const running = backendStatus === "running";

				const tip =
					`${stage.label}` +
					(!open ? "（未解锁）" : running ? "（进行中）" : backendStatus === "done" ? "（已完成）" : "");

				return (
					<button
						key={stage.id}
						type="button"
						title={tip}
						aria-label={tip}
						disabled={!open}
						onClick={() => onSelect(stage.id)}
						className={cn(
							"relative flex size-10 cursor-pointer items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed",
							isActive ? "text-zinc-50" : open ? "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200" : "text-zinc-700",
						)}
					>
						{isActive && (
							<motion.span
								layoutId="rail-active"
								className={cn(
									"absolute inset-0 rounded-xl border",
									isRedoOrigin || isRedoAffected
										? "rail-redo border-amber-300/50 bg-amber-400/10"
										: "border-amber-300/40 bg-amber-400/[0.08]",
								)}
								transition={{ type: "spring", stiffness: 400, damping: 32 }}
							/>
						)}
						{/* 重做 origin：琥珀呼吸光环 */}
						{isRedoOrigin && !isActive && (
							<span className="rail-redo absolute inset-0 rounded-xl border border-amber-300/40 bg-amber-400/[0.07]" />
						)}
						{/* 重做进行中的阶段：顶部扫光线 */}
						{(isRedoOrigin || isRedoAffected) && redo && (
							<span className="redo-bar absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/80 to-transparent" />
						)}
						<Icon
							className={cn(
								"relative z-10 size-4 shrink-0",
								(isRedoOrigin || isRedoAffected) && "text-amber-300",
								isActive && !isRedoOrigin && !isRedoAffected && "text-amber-200",
							)}
						/>
						{/* 右下角状态点：锁 / 进度环 / 完成 / 失败 */}
						<span className="absolute -bottom-0.5 -right-0.5 z-10">
							{!open ? (
								<Lock className="size-2.5 text-zinc-700" />
							) : running ? (
								<MiniProgressRing
									value={run.stages.find((s) => s.id === stage.backend)?.progress ?? 0}
									amber={Boolean(redo)}
								/>
							) : backendStatus === "done" ? (
								<StatusDot tone={isRedoAffected ? "redo" : "done"} />
							) : backendStatus === "failed" ? (
								<StatusDot tone="error" />
							) : null}
						</span>
					</button>
				);
			})}
		</nav>
	);
}
