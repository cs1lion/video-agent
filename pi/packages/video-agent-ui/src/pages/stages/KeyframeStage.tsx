/**
 * 关键帧阶段：分镜关键帧组图预览 —— 每镜一张首帧锚定图，
 * 视频按「关键帧 + 分镜提示词」生成；支持单镜输入指令重绘。
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { ImagePlus, LoaderCircle, RefreshCw } from "lucide-react";
import type { DesignBibleDoc, KeyframesDoc, ScriptDoc, ShotPromptDoc } from "@/api/client";
import { cn } from "@/lib/utils";
import { EmptyState, StageShell } from "./shared";

function KeyframeCard({
	shotId,
	narration,
	prompt,
	url,
	status,
	error,
	stale,
	dependency,
	staleDependency,
	selected,
	onToggle,
	busy,
	onAdjust,
	index,
}: {
	shotId: string;
	narration?: string;
	prompt?: string;
	url?: string;
	status: "pending" | "done" | "failed" | "missing";
	error?: string;
	stale?: boolean;
	dependency: string;
	staleDependency: string;
	selected: boolean;
	onToggle: (shotId: string, selected: boolean) => void;
	busy: boolean;
	onAdjust: (shotId: string, instruction: string) => void;
	index: number;
}) {
	const [instruction, setInstruction] = useState("");
	return (
		<motion.div
			id={`art-${shotId}`}
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ delay: index * 0.05 }}
			className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
		>
			<div className="relative">
				{url ? (
					<img src={url} alt={`关键帧 ${shotId}`} className="aspect-video w-full object-cover" loading="lazy" />
				) : (
					<div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-black/40">
						{status === "failed" ? (
							<>
								<ImagePlus className="size-5 text-rose-300/70" />
								<span className="px-4 text-center text-[11px] text-rose-200/80">{error ?? "生成失败"}</span>
								{!busy && (
									<button
										type="button"
										onClick={() => onAdjust(shotId, "")}
										className="cursor-pointer rounded-lg border border-amber-400/45 px-2.5 py-1 text-[11px] text-amber-200 transition-colors hover:bg-amber-400/10"
									>
										<RefreshCw className="mr-1 inline size-3" />
										重试生成
									</button>
								)}
							</>
						) : (
							<>
								<LoaderCircle className="size-5 animate-spin text-cyan-300/80" />
								<span className="text-[11px] text-zinc-500">片段生成阶段会自动逐镜产出…</span>
							</>
						)}
					</div>
				)}
				{busy && (
					<div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
						<LoaderCircle className="size-6 animate-spin text-amber-300" />
					</div>
				)}
				{stale && (
					<span className="absolute left-2 top-2 rounded-md border border-amber-300/50 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200 backdrop-blur-sm">
						设计已更新 · 须重绘
					</span>
				)}
				<label
					title={stale ? "画面已落后最新美术设计，重绘同步后才能进入成片" : undefined}
					className={cn(
						"absolute right-2 top-2 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium backdrop-blur-sm transition",
						stale
							? "cursor-not-allowed border-white/15 bg-black/65 text-zinc-500 opacity-60"
							: selected
								? "border-emerald-300/60 bg-emerald-500/25 text-emerald-100"
								: "border-white/20 bg-black/55 text-zinc-300 hover:border-emerald-300/50 hover:text-emerald-200",
					)}
				>
					<input
						type="checkbox"
						checked={selected}
						disabled={stale}
						onChange={(event) => onToggle(shotId, event.target.checked)}
						className="size-3 accent-emerald-400"
					/>
					进入成片
				</label>
			</div>
			<div className="space-y-2 px-3 py-2.5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-xs text-cyan-300">{shotId}</span>
					{narration && <span className="truncate text-[11px] text-zinc-500">{narration}</span>}
				</div>
				{dependency && (
					<div className="flex items-center gap-1 text-[10px] text-zinc-500" title={`参考板依赖：${staleDependency || dependency}`}>
						<span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-px">
							锚定 {dependency}
						</span>
						{staleDependency && <span className="text-amber-300/90">{staleDependency} 已更新</span>}
					</div>
				)}
				{prompt && <p className="line-clamp-2 font-mono text-[10px] leading-relaxed text-zinc-600">{prompt}</p>}
				<div className="flex items-center gap-1.5">
					<input
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && instruction.trim() && !busy) {
								onAdjust(shotId, instruction.trim());
								setInstruction("");
							}
						}}
						placeholder="调整这张关键帧，例：更暖的光、主角再靠近产品"
						maxLength={120}
						className="field-input !px-2.5 !py-1.5 !text-xs"
					/>
					<button
						type="button"
						disabled={!instruction.trim() || busy}
						onClick={() => {
							onAdjust(shotId, instruction.trim());
							setInstruction("");
						}}
						className={cn(
							"inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
							"border-violet-400/40 text-violet-200 hover:bg-violet-400/10 disabled:cursor-not-allowed disabled:opacity-40",
						)}
					>
						<RefreshCw className="size-3.5" />
						重绘
					</button>
				</div>
			</div>
		</motion.div>
	);
}

export function KeyframeStage({
	keyframes,
	script,
	prompts,
	design,
	selectedShotIds,
	onToggle,
	busy,
	onAdjust,
}: {
	keyframes: KeyframesDoc | null;
	script: ScriptDoc | null;
	prompts: ShotPromptDoc | null;
	design?: DesignBibleDoc;
	selectedShotIds: string[];
	onToggle: (shotId: string, selected: boolean) => void;
	busy: boolean;
	onAdjust: (shotId: string, instruction: string) => void;
}) {
	const shotIds = script?.shots.map((s) => s.id) ?? prompts?.prompts.map((p) => p.shotId) ?? [];
	const frameOf = (id: string) => keyframes?.frames.find((f) => f.shotId === id);
	const readyCount = shotIds.filter((id) => frameOf(id)?.status === "done").length;
	const staleCount = (keyframes?.frames ?? []).filter((f) => (f.staleRefs ?? []).length > 0).length;
	const selectedShots = (script?.shots ?? []).filter((shot) => selectedShotIds.includes(shot.id));
	const selectedDurationSec = selectedShots.reduce((total, shot) => total + shot.durationSec, 0);
	const skippedCount = shotIds.length - selectedShotIds.length;
	const entityNameOf = (id: string): string =>
		[...(design?.characters ?? []), ...(design?.props ?? []), ...(design?.scenes ?? [])].find((e) => e.id === id)
			?.name ?? id;
	const dependencyLabel = (frame: KeyframesDoc["frames"][number]): string =>
		(frame.refs ?? []).map(entityNameOf).join(" / ");
	const staleLabel = (frame: KeyframesDoc["frames"][number]): string =>
		(frame.staleRefs ?? []).map(entityNameOf).join(" / ");

	return (
		<StageShell kicker="STAGE 03.5 · KEYFRAMES" title="分镜关键帧">
			{shotIds.length === 0 ? (
				<EmptyState text="分镜提示词就绪后，这里会出现每一镜的关键帧。" />
			) : (
				<div className="space-y-4">
					<p className="rounded-xl border border-cyan-300/25 bg-cyan-400/[0.06] px-4 py-2.5 text-xs leading-relaxed text-cyan-100/90">
						视频按「关键帧锚定 + 分镜提示词」生成：每镜先出一张首帧锚定图锁定构图与色调，再由视频模型延展成动态镜头。
									每张关键帧的服务端参考板会把命中的角色、场景与道具定稿合成为一张视觉锚定图，视频原料严格跟随美术设计。
									对某张不满意可直接改（例：更暖的光、主角靠近产品）；重绘后补拍该镜将以新关键帧为准。已就绪 {readyCount}/{shotIds.length}。
						勾选「进入成片」可选择 N/M 镜部分确认。本次预计消耗 {selectedShotIds.length} 段视频（约 {selectedDurationSec}s）和{" "}
						{selectedShotIds.length} 条配音；未勾选的 {skippedCount} 镜不会提交视频生成，也不会消耗额度。
						{staleCount > 0 && (
							<span className="font-medium text-amber-200">
								其中 {staleCount} 镜因美术设计更新已过期，须先重绘同步后才能进入成片。
							</span>
						)}
					</p>
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{shotIds.map((id, idx) => {
							const frame = frameOf(id);
							return (
								<KeyframeCard
									key={id}
									index={idx}
									shotId={id}
									narration={script?.shots.find((s) => s.id === id)?.narrationZh}
									prompt={prompts?.prompts.find((p) => p.shotId === id)?.prompt}
									url={frame?.url}
									status={frame?.status ?? "missing"}
									error={frame?.error}
									stale={(frame?.staleRefs ?? []).length > 0}
									dependency={frame ? dependencyLabel(frame) : ""}
									staleDependency={frame ? staleLabel(frame) : ""}
									selected={selectedShotIds.includes(id)}
									onToggle={onToggle}
									busy={busy && Boolean(frame?.attempts)}
									onAdjust={onAdjust}
								/>
							);
						})}
					</div>
				</div>
			)}
		</StageShell>
	);
}
