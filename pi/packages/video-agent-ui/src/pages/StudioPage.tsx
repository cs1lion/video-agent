/**
 * 工作台：左阶段导航 / 中产物面板 / 右指挥台。
 * 头部：返回 + runId + 全局进度环 + 状态 pill；awaiting 时顶部出现「继续推进」条。
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
	AlertTriangle,
	ArrowLeft,
	AudioLines,
	Camera,
	Clapperboard,
	LoaderCircle,
	PlayCircle,
	WandSparkles,
	XCircle,
} from "lucide-react";
import { useStudio } from "@/store/store";
import { Backdrop } from "@/components/fx/Backdrop";
import { StageRail, UI_STAGES, type UiStageId } from "@/components/StageRail";
import { DirectorChat } from "@/components/DirectorChat";
import { PipelineFlow } from "@/components/PipelineFlow";
import { TeamPresence } from "@/components/TeamPresence";
import { TimelineBar } from "@/components/TimelineBar";
import { CommandPalette } from "@/components/CommandPalette";
import { RefineModal } from "@/components/RefineModal";
import { ReshotModal } from "@/components/ReshotModal";
import { GlowButton, ProgressRing } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { StageId } from "@/api/client";
import { BriefStage } from "./stages/BriefStage";
import { ScriptStage } from "./stages/ScriptStage";
import { BibleStage } from "./stages/BibleStage";
import { StoryboardStage } from "./stages/StoryboardStage";
import { KeyframeStage } from "./stages/KeyframeStage";
import { GenerateStage } from "./stages/GenerateStage";
import { ReviewStage } from "./stages/ReviewStage";
import { PostStage } from "./stages/PostStage";
import { ExportStage } from "./stages/ExportStage";

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
	running: {
		label: "制作中",
		cls: "pill-running border-white/25 bg-white/[0.07] text-zinc-100 shadow-[0_0_18px_rgba(244,244,245,0.15)]",
	},
	awaiting: {
		label: "等待确认",
		cls: "pill-awaiting border-amber-400/40 bg-amber-400/10 text-amber-200 shadow-[0_0_16px_rgba(251,191,36,0.2)]",
	},
	done: {
		label: "已完成",
		cls: "pill-done border-emerald-400/50 bg-emerald-400/10 text-emerald-100 shadow-[0_0_20px_rgba(52,211,153,0.3)]",
	},
	failed: { label: "失败", cls: "border-rose-400/40 bg-rose-400/10 text-rose-200" },
	cancelled: { label: "已取消", cls: "border-white/15 bg-white/5 text-zinc-400" },
};

const REDO_PILL: Record<string, { label: string; icon: typeof Camera }> = {
	reshot: { label: "镜头补拍中", icon: Camera },
	retts: { label: "旁白重录中", icon: AudioLines },
	reexport: { label: "重新导出中", icon: Clapperboard },
};

const STAGE_LABEL: Record<StageId, string> = {
	script: "剧本",
	visual: "美术设计",
	prompts: "分镜提示词",
	keyframes: "分镜关键帧",
	clips: "片段生成",
	audio: "声音设计",
	export: "成片导出",
};

function overallProgress(done: number, total: number, runningIdx: number, runningProgress: number): number {
	if (total === 0) return 0;
	const base = (done / total) * 100;
	if (runningIdx >= 0) return Math.min(99, base + (runningProgress / total) / 100 * 100 * 0.9);
	return done === total ? 100 : base;
}

export function StudioPage() {
	const navigate = useNavigate();
	const runId = useParams<{ id: string }>().id ?? "";
	const {
		run,
		artifacts,
		error,
		chatBusy,
		refining,
		lastRefine,
		transport,
		bind,
		unbind,
		refresh,
		sendChat,
		submitRefine,
		reshot,
		retts,
		designAdjust,
		keyframeAdjust,
		resume,
		cancel,
	} =
		useStudio();
	// 深链：#/studio/:id?stage=keyframes&focus=SH01 → 初始阶段 + 卡片滚动定位
	const deepLink = (() => {
		const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
		return { stage: q.get("stage"), focus: q.get("focus") };
	})();
	const [stage, setStage] = useState<UiStageId>(
		UI_STAGES.some((s) => s.id === deepLink.stage) ? (deepLink.stage as UiStageId) : "brief",
	);
	const [focusArt, setFocusArt] = useState<string | null>(deepLink.focus);
	const [refineTarget, setRefineTarget] = useState<StageId | null>(null);
	const [reshotTarget, setReshotTarget] = useState<{ shotId: string; instruction?: string } | null>(null);
	const [selectedKeyframes, setSelectedKeyframes] = useState<string[]>([]);

	useEffect(() => {
		if (runId) bind(runId);
		return () => unbind();
	}, [runId, bind, unbind]);

	// 首次拿到产物时跳到最新可用阶段
	const [jumped, setJumped] = useState(false);
	useEffect(() => {
		if (!run || jumped) return;
		setJumped(true);
		if (deepLink.stage) return; // 深链指定了目标阶段时不做自动跳转
		const hasKf = (artifacts?.keyframes?.frames ?? []).some((f) => f.status === "done" && f.url);
		const ready = [...UI_STAGES].reverse().find((s) =>
			s.unlocked(
				run,
				Boolean(artifacts?.script ?? artifacts?.bible ?? artifacts?.prompts),
				(artifacts?.assets.length ?? 0) > 0,
				hasKf,
			),
		);
		if (ready && ready.id !== "brief") setStage(ready.id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [run, artifacts, jumped]);

	// 焦点定位：目标卡片渲染出来后滚动居中（产物未就绪时随轮询重试）
	useEffect(() => {
		if (!focusArt || !run) return;
		const el = document.getElementById(`art-${focusArt}`);
		if (!el) return;
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		setFocusArt(null);
	}, [stage, focusArt, run, artifacts]);

	/** 团队频道事件链接 → 切换阶段并定位生成物卡片 */
	const jumpToArtifact = (targetStage: string, focus?: string): void => {
		if (UI_STAGES.some((s) => s.id === targetStage)) setStage(targetStage as UiStageId);
		if (focus) setFocusArt(focus);
	};

	const scriptShotIds = artifacts?.script?.shots.map((shot) => shot.id) ?? [];
	const frameOfKeyframe = (id: string) => artifacts?.keyframes?.frames.find((frame) => frame.shotId === id);
	// 美术设计是关键帧的决定性原料：落后于设计更新的画面不允许直接进入视频，必须先重绘同步。
	const confirmableShotIds = scriptShotIds.filter(
		(id) => frameOfKeyframe(id)?.status === "done" && (frameOfKeyframe(id)?.staleRefs ?? []).length === 0,
	);
	const keyframeRevision = scriptShotIds.map((id) => {
		const frame = frameOfKeyframe(id);
		return [frame?.status, frame?.attempts ?? -1, (frame?.staleRefs ?? []).length].join("-");
	});
	const keyframeSelectionKey = [
		runId,
		run?.gate,
		scriptShotIds.join("|"),
		confirmableShotIds.join("|"),
		keyframeRevision.join("|"),
		artifacts?.keyframes?.confirmedShotIds?.join("|") ?? "none",
	].join(":");

	useEffect(() => {
		if (!run || run.gate !== "keyframes") {
			setSelectedKeyframes([]);
			return;
		}
		const recorded = artifacts?.keyframes?.confirmedShotIds;
		if (Array.isArray(recorded) && recorded.length === 0) {
			// 分镜/画面重塑后旧确认作废；新帧渲染出来时默认重新全选，用户可再取消
			setSelectedKeyframes(confirmableShotIds);
			return;
		}
		setSelectedKeyframes((previous) => {
			const preserved = previous.filter((id) => confirmableShotIds.includes(id));
			if (preserved.length > 0) return preserved;
			return Array.isArray(recorded)
				? confirmableShotIds.filter((id) => recorded.includes(id))
				: confirmableShotIds;
		});
		// 签名包含 run/run 数据身份：产物经 SSE/轮询更新时可安全重建选择集
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [keyframeSelectionKey]);

	if (!run) {
		return (
			<div className="relative flex min-h-dvh items-center justify-center text-zinc-300">
				<Backdrop />
				<div className="relative z-10 flex flex-col items-center gap-3">
					{error ? (
						<>
							<XCircle className="size-6 text-rose-300" />
							<p className="text-sm">{error}</p>
							<GlowButton variant="ghost" onClick={() => navigate("/")}>
								返回首页
							</GlowButton>
						</>
					) : (
						<>
							<LoaderCircle className="size-6 animate-spin text-cyan-300" />
							<p className="text-sm text-zinc-500">正在接入制作现场…</p>
						</>
					)}
				</div>
			</div>
		);
	}

	const stages = run.stages;
	const doneCount = stages.filter((s) => s.status === "done").length;
	const runningIdx = stages.findIndex((s) => s.status === "running");
	const runningProgress = runningIdx >= 0 ? stages[runningIdx].progress : 0;
	const progress = overallProgress(doneCount, stages.length, runningIdx, runningProgress);
	const artifactsReady = Boolean(artifacts?.script ?? artifacts?.bible ?? artifacts?.prompts);
	const hasAssets = (artifacts?.assets.length ?? 0) > 0;
	const hasKeyframes = (artifacts?.keyframes?.frames ?? []).some((f) => f.status === "done" && f.url);
	const staleKeyframes = (artifacts?.keyframes?.frames ?? []).filter((f) => (f.staleRefs ?? []).length > 0).length;
	const confirmedForResume = scriptShotIds.filter((id) => selectedKeyframes.includes(id));
	const productionShots = (artifacts?.script?.shots ?? []).filter(
		(shot) => run.gate === "keyframes" && confirmedForResume.includes(shot.id),
	);
	const estimatedVideoSeconds = productionShots.reduce((total, shot) => total + shot.durationSec, 0);
	const isPartialKeyframeConfirm =
		run.gate === "keyframes" && confirmedForResume.length < scriptShotIds.length;
	const pill = STATUS_PILL[run.status] ?? STATUS_PILL.cancelled;
	const redo = run.redoActive;
	const redoPill = redo ? REDO_PILL[redo.kind] : undefined;
	// 微调重塑横幅：发出过微调且管线正在运行（30 分钟内有效，避免旧指令常驻）
	const showRefineBanner = Boolean(
		lastRefine && run.status === "running" && !run.awaitingResume && Date.now() - lastRefine.at < 30 * 60_000,
	);

	const onRefine = (id: StageId) => setRefineTarget(id);

	return (
		<div className="relative flex h-dvh flex-col overflow-hidden text-zinc-200">
			<Backdrop />

			{/* 顶部错误横幅 */}
			{error && (
				<div className="relative z-30 flex items-center gap-2 border-b border-rose-400/20 bg-rose-400/10 px-5 py-2 text-xs text-rose-200">
					<AlertTriangle className="size-3.5 shrink-0" />
					<span className="flex-1 truncate">{error}</span>
					<button type="button" onClick={() => void refresh()} className="cursor-pointer underline">
						重试
					</button>
				</div>
			)}

			{/* 头部 */}
			<header className="relative z-10 flex shrink-0 items-center gap-4 border-b border-white/[0.07] px-5 py-3">
				<button
					type="button"
					onClick={() => navigate("/")}
					className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
				>
					<ArrowLeft className="size-3.5" />
					新项目
				</button>
				<div className="h-5 w-px bg-white/10" />
				<span className="font-mono text-xs text-zinc-500">{run.id}</span>
				<span
					className={`hidden rounded-full border px-2 py-0.5 font-mono text-[10px] sm:inline ${
						transport === "live"
							? "border-emerald-300/40 bg-emerald-400/10 text-emerald-200"
							: transport === "polling"
								? "border-amber-300/40 bg-amber-400/10 text-amber-200"
								: "border-white/15 bg-white/5 text-zinc-400"
					}`}
					title={transport === "live" ? "SSE 实时更新已连接" : transport === "polling" ? "实时流暂不可用，正在轮询兜底" : "正在接入实时更新"}
				>
					{transport === "live" ? "LIVE" : transport === "polling" ? "POLL" : "SYNC"}
				</span>
				{redoPill && redo ? (
					<span
						className="pill-redo inline-flex items-center gap-1.5 rounded-full border border-amber-300/60 bg-amber-400/15 px-2.5 py-0.5 text-[11px] text-amber-100 shadow-[0_0_22px_rgba(251,191,36,0.35)]"
						title={redo.label}
					>
						<redoPill.icon className="size-3" />
						{redoPill.label}
						{redo.shotId ? <span className="font-mono">{redo.shotId}</span> : null}
					</span>
				) : (
					<span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${pill.cls}`}>{pill.label}</span>
				)}

			<div className="ml-auto flex items-center gap-4">
				{/* P2：成本 pill（预估 + 累计，悬停查看阶段明细） */}
					{run.costEstimate && (
						<div
							className="hidden flex-col items-end text-right sm:flex"
							title={`预估 ¥${run.costEstimate.total.toFixed(2)}（pre-flight）\n${run.costEstimate.lines.map((l) => `${l.label}: ¥${l.amount.toFixed(2)}`).join("\n")}`}
						>
							<span className="font-mono text-[10px] text-zinc-500">
								预估 / 已花
							</span>
							<span className="font-mono text-xs">
								<span className="text-amber-200">
									{run.costEstimate.currency === "CNY" ? "¥" : "$"}
									{run.costEstimate.total.toFixed(2)}
								</span>
								<span className="text-zinc-500"> / </span>
								<span className="text-cyan-200">
									¥{(run.metrics?.cost?.spent ?? 0).toFixed(2)}
								</span>
							</span>
						</div>
					)}
					<ProgressRing value={progress} size={40} stroke={3.5} label={<span className="text-[9px]">{Math.round(progress)}%</span>} />
					{run.status === "running" && (
						<GlowButton variant="danger" onClick={() => void cancel()}>
							取消
						</GlowButton>
					)}
				</div>
		</header>

		{/* 流水线实况 + 团队在场：DAG 节点即阶段状态，右侧角色灯随阶段/chat 联动 */}
		<div className="relative z-10 flex shrink-0 items-center gap-4 border-b border-white/[0.07] px-5 py-2">
			<PipelineFlow stages={run.stages} className="min-w-0 flex-1 pb-0" />
			<div className="h-8 w-px shrink-0 bg-white/10" />
			<TeamPresence run={run} chatBusy={chatBusy} />
		</div>

		{/* awaiting 确认条：闸门 / refine 重塑共用 */}
			<AnimatePresence>
				{run.awaitingResume && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						className="relative z-20 shrink-0 overflow-hidden border-b border-amber-400/20 bg-amber-400/10"
					>
						<div className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-xs text-amber-100">
							<PlayCircle className="size-4 shrink-0" />
							<span className="flex-1">
								{run.gate === "design"
									? "美术设计已就绪：请确认人物形象与场景设定，或对单张设计图提意见重绘；确认后才开始绘制关键帧。"
									: run.gate === "keyframes"
										? `关键帧已就绪：请勾选要进入成片的 ${confirmedForResume.length}/${scriptShotIds.length} 镜。预计消耗 ${confirmedForResume.length} 段视频（约 ${estimatedVideoSeconds}s）和 ${confirmedForResume.length} 条配音${isPartialKeyframeConfirm ? `；未勾选的 ${scriptShotIds.length - confirmedForResume.length} 镜不会提交、不会消耗额度` : ""}。${staleKeyframes > 0 ? `其中 ${staleKeyframes} 镜已落后美术设计，须重绘后才能进入成片。` : ""}`
										: "产物已按你的意见重塑，确认无误后继续推进下游阶段。"}
							</span>
							{run.gate === "design" && (
								<GlowButton variant="ghost" onClick={() => setStage("bible")}>
									查看美术设计
								</GlowButton>
							)}
							{run.gate === "keyframes" && (
								<GlowButton variant="ghost" onClick={() => setStage("keyframes")}>
									查看关键帧
								</GlowButton>
							)}
							<GlowButton
								disabled={run.gate === "keyframes" && confirmedForResume.length === 0}
								onClick={() =>
									void resume(run.gate === "keyframes" ? scriptShotIds.filter((id) => selectedKeyframes.includes(id)) : undefined)
								}
							>
								{run.gate === "keyframes"
									? `${confirmedForResume.length}/${scriptShotIds.length} 确认并继续`
									: run.gate
										? "确认并继续"
										: "继续推进"}
							</GlowButton>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{/* failed 恢复条：可恢复失败一律给「从失败处继续」入口，成功后自动回到正常流程 */}
			<AnimatePresence>
				{run.status === "failed" && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						className="relative z-20 shrink-0 overflow-hidden border-b border-rose-400/20 bg-rose-400/10"
					>
						<div className="flex flex-wrap items-center gap-3 px-5 py-2.5">
							<AlertTriangle className="size-4 shrink-0 text-rose-300" />
							<span className="min-w-0 flex-1 text-xs text-rose-100">
								管线受阻：{run.error ?? "未知错误"}——已完成的阶段不会重跑，点击继续从受阻处恢复。
							</span>
							<GlowButton variant="outline" onClick={() => void resume()}>
								从失败处继续
							</GlowButton>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{/* 重做进度条（镜头补拍 / 旁白重录 / 重新导出进行中） */}
			<AnimatePresence>
				{redo && run.status === "running" && redoPill && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						className="relative z-20 shrink-0 overflow-hidden border-b border-amber-300/25 bg-gradient-to-r from-amber-400/[0.12] via-amber-400/[0.06] to-violet-400/[0.08]"
					>
						<span className="redo-scan absolute inset-x-0 top-0 h-px" />
						<div className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-xs text-amber-100">
							<span className="relative flex size-4 items-center justify-center">
								<span className="absolute inset-0 animate-ping rounded-full bg-amber-400/40" />
								<redoPill.icon className="relative size-3.5 text-amber-200" />
							</span>
							<span className="font-medium">{redo.label} · 重做中</span>
							<span className="min-w-0 flex-1 truncate text-amber-100/70">
								{redo.kind === "reshot" && "旧片段已备份，按质检反馈与你的指令重新生成该镜，随后重装时间线并复审。"}
								{redo.kind === "retts" && "旧录音已备份，新语音就位后该镜按新时长重排、重新混音并复审。"}
								{redo.kind === "reexport" && "复用现有镜头与配音，重跑转场决策、混音与质检。"}
							</span>
							<span className="rounded-full border border-amber-300/30 px-2 py-0.5 font-mono text-[10px] text-amber-200/80">
								REDO IN PROGRESS
							</span>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{/* 微调重塑横幅：你的指令正在被执行 */}
			<AnimatePresence>
				{showRefineBanner && lastRefine && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						className="relative z-20 shrink-0 overflow-hidden border-b border-amber-300/25 bg-gradient-to-r from-amber-400/[0.12] via-orange-400/[0.07] to-transparent"
					>
						<span className="redo-scan absolute inset-x-0 top-0 h-px" />
						<div className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-xs text-amber-100">
							<span className="relative flex size-4 items-center justify-center">
								<span className="absolute inset-0 animate-ping rounded-full bg-amber-400/40" />
								<WandSparkles className="relative size-3.5 text-amber-200" />
							</span>
							<span className="font-medium">按你的意见重塑「{STAGE_LABEL[lastRefine.stageId]}」中</span>
							<span className="min-w-0 flex-1 truncate text-amber-100/70">指令：{lastRefine.instruction}</span>
							<span className="rounded-full border border-amber-300/30 px-2 py-0.5 font-mono text-[10px] text-amber-200/80">
								REFINE IN PROGRESS
							</span>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

		{/* 主体三栏 */}
			<div className="relative z-10 flex min-h-0 flex-1">
				<div className="h-full overflow-y-auto border-r border-white/[0.07]">
					<StageRail
						run={run}
						artifactsReady={artifactsReady}
						hasAssets={hasAssets}
						hasKeyframes={hasKeyframes}
						active={stage}
						onSelect={setStage}
					/>
				</div>

				<main className={cn("min-w-0 flex-1 overflow-y-auto p-6", run.awaitingResume && "awaiting-edge")}>
					<div className="mx-auto max-w-4xl">
						<AnimatePresence mode="wait">
							<motion.div
								key={stage}
								initial={{ opacity: 0, y: 14 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -10 }}
								transition={{ duration: 0.22 }}
							>
								{stage === "brief" && <BriefStage run={run} />}
								{stage === "script" && <ScriptStage script={artifacts?.script ?? null} onRefine={onRefine} />}
								{stage === "bible" && (
									<BibleStage
										bible={artifacts?.bible ?? null}
										design={artifacts?.design}
										onRefine={onRefine}
										onDesignAdjust={(entityId, instruction) => void designAdjust(entityId, instruction)}
										designBusy={refining}
									/>
								)}
								{stage === "storyboard" && (
									<StoryboardStage
										prompts={artifacts?.prompts ?? null}
										script={artifacts?.script ?? null}
										onRefine={onRefine}
									/>
								)}
								{stage === "keyframes" && (
									<KeyframeStage
										keyframes={artifacts?.keyframes ?? null}
										script={artifacts?.script ?? null}
										prompts={artifacts?.prompts ?? null}
										design={artifacts?.design}
										selectedShotIds={selectedKeyframes}
										onToggle={(shotId, selected) =>
											setSelectedKeyframes((prev) =>
												selected
													? prev.includes(shotId)
														? prev
														: [...prev, shotId]
													: prev.filter((id) => id !== shotId),
											)
										}
										busy={refining}
										onAdjust={(shotId, instruction) => void keyframeAdjust(shotId, instruction)}
									/>
								)}
								{stage === "generate" && (
									<GenerateStage
										assets={artifacts?.assets ?? []}
										script={artifacts?.script ?? null}
										shotCount={run.options.shotCount}
										progress={run.stages.find((s) => s.id === "clips")?.progress}
										shotVersions={run.shotVersions}
									/>
								)}
								{stage === "post" && (
									<PostStage
										run={run}
										assets={artifacts?.assets ?? []}
										script={artifacts?.script ?? null}
										onRetts={(shotId, instruction) => void retts(shotId, instruction)}
										rettsBusy={refining}
									/>
								)}
								{stage === "review" && (
									<ReviewStage
										runId={run.id}
										verdict={run.verdict}
										assets={artifacts?.assets ?? []}
										shotAttempts={run.shotAttempts}
										runStatus={run.status}
										onReshot={(shotId, instruction) => setReshotTarget({ shotId, instruction })}
									/>
								)}
								{stage === "export" && (
									<ExportStage run={run} assets={artifacts?.assets ?? []} cuts={artifacts?.cuts} />
								)}
							</motion.div>
						</AnimatePresence>
					</div>
				</main>

			<DirectorChat events={run.events} busy={chatBusy} onSend={(text) => void sendChat(text)} onJump={jumpToArtifact} />
		</div>

		{/* 底部时间线：镜头按时长比例排列，点击定位 */}
		{(artifacts?.script?.shots.length ?? 0) > 0 && (
			<TimelineBar
				shots={artifacts!.script!.shots}
				frames={artifacts?.keyframes?.frames}
				assets={artifacts?.assets ?? []}
				onJump={(targetStage, focus) => jumpToArtifact(targetStage, focus)}
			/>
		)}

			{/* Cmd/Ctrl+K 指令条 */}
		<CommandPalette
			stages={UI_STAGES.map((s) => ({
				id: s.id,
				label: s.label,
				open: s.unlocked(run, artifactsReady, hasAssets, hasKeyframes),
			}))}
			onSelectStage={setStage}
			onSendDirector={(text) => void sendChat(text)}
			actions={[
				...(run.awaitingResume
					? [
							{
								id: "resume",
								label: run.gate === "keyframes" ? "确认关键帧并继续" : run.gate ? "确认并继续" : "继续推进",
								hint: "闸门",
								run: () =>
									void resume(run.gate === "keyframes" ? scriptShotIds.filter((id) => selectedKeyframes.includes(id)) : undefined),
							},
						]
					: []),
				...(run.status === "failed"
					? [{ id: "resume-failed", label: "从失败处继续", hint: "恢复", run: () => void resume() }]
					: []),
				...(run.status === "running"
					? [{ id: "cancel", label: "取消制作", hint: "危险", run: () => void cancel() }]
					: []),
			]}
		/>

		{/* 微调弹窗 */}
			<RefineModal
				stageId={refineTarget}
				busy={refining}
				onClose={() => setRefineTarget(null)}
				onSubmit={(instruction, autoResume) => {
					const target = refineTarget;
					if (!target) return;
					setRefineTarget(null);
					void submitRefine(target, instruction, autoResume);
				}}
			/>

			{/* 镜头级重做弹窗 */}
			<ReshotModal
				shot={
					reshotTarget
						? {
								id: reshotTarget.shotId,
								verdict: run.verdict?.shots?.find((s) => s.id === reshotTarget.shotId),
							}
						: null
				}
				initialInstruction={reshotTarget?.instruction}
				attempts={reshotTarget ? (run.shotAttempts[reshotTarget.shotId] ?? 0) : 0}
				busy={refining}
				onClose={() => setReshotTarget(null)}
				onSubmit={(shotId, instruction) => {
					setReshotTarget(null);
					void reshot(shotId, instruction);
				}}
			/>
		</div>
	);
}
