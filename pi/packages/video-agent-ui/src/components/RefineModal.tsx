/**
 * RefineModal：对文本阶段产物（剧本 / 美术设计 / 分镜提示词）下达微调指令。
 * 两种显式模式：
 * - 重塑此产物：只重跑该文本阶段，完成后暂停等确认（安全，默认）；
 * - 调整并直接重做：带着指令一路重跑到成片（会重新消耗媒体生成额度）。
 */

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FastForward, LoaderCircle, Sparkles, WandSparkles, X } from "lucide-react";
import type { StageId } from "@/api/client";
import { GlowButton } from "@/components/ui/primitives";

const STAGE_LABEL: Record<string, string> = {
	script: "剧本",
	visual: "美术设计",
	prompts: "分镜提示词",
};

const HINTS: Record<string, string[]> = {
	script: ["更短的旁白句", "结尾加品牌口号镜头", "情绪更轻快"],
	visual: ["色板更暖", "参考图的产品色", "光线更柔和"],
	prompts: ["镜头推近产品", "减少环境元素", "背景更干净"],
};

export function RefineModal({
	stageId,
	busy,
	onClose,
	onSubmit,
}: {
	stageId: StageId | null;
	busy: boolean;
	onClose: () => void;
	onSubmit: (instruction: string, autoResume: boolean) => void;
}) {
	const [instruction, setInstruction] = useState("");

	// 打开新阶段时重置输入
	const [lastStage, setLastStage] = useState<StageId | null>(null);
	if (stageId !== lastStage) {
		setLastStage(stageId);
		setInstruction("");
	}

	return (
		<AnimatePresence>
			{stageId && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
					onClick={busy ? undefined : onClose}
				>
					<motion.div
						initial={{ opacity: 0, scale: 0.94, y: 16 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.94, y: 16 }}
						transition={{ type: "spring", stiffness: 380, damping: 30 }}
						className="glass-strong mx-4 w-full max-w-lg rounded-2xl p-6"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="mb-1 flex items-start justify-between">
							<div>
								<div className="font-mono text-[10px] tracking-[0.3em] text-amber-300/80">REFINE</div>
								<h3 className="mt-1 text-lg font-semibold text-zinc-100">调整「{STAGE_LABEL[stageId] ?? stageId}」</h3>
							</div>
							<button
								type="button"
								onClick={onClose}
								className="cursor-pointer rounded-lg p-1.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
								aria-label="关闭"
							>
								<X className="size-4" />
							</button>
						</div>

						<p className="mt-2 text-xs leading-relaxed text-zinc-500">
							你的指令会写入该阶段的创意约束并触发重做（参考图、访谈答案仍然生效）。选一种执行方式：
						</p>

						<textarea
							autoFocus
							value={instruction}
							rows={4}
							maxLength={500}
							placeholder="例：旁白再口语化一点；结尾镜头聚焦产品特写"
							className="field-input mt-4 resize-y"
							onChange={(e) => setInstruction(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && instruction.trim() && !busy) {
									onSubmit(instruction.trim(), false);
								}
							}}
						/>

						<div className="mt-2.5 flex flex-wrap gap-1.5">
							{(HINTS[stageId] ?? []).map((h) => (
								<button
									key={h}
									type="button"
									onClick={() => setInstruction((v) => (v ? `${v}；${h}` : h))}
									className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:border-amber-300/40 hover:text-amber-200"
								>
									+ {h}
								</button>
							))}
						</div>

						<div className="mt-5 space-y-2.5">
							<button
								type="button"
								disabled={!instruction.trim() || busy}
								onClick={() => onSubmit(instruction.trim(), true)}
								className="group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-amber-300/40 bg-gradient-to-r from-amber-400/[0.12] to-orange-400/[0.06] px-4 py-3 text-left transition-all hover:border-amber-300/70 disabled:cursor-not-allowed disabled:opacity-40"
							>
								<FastForward className="mt-0.5 size-4 shrink-0 text-amber-300" />
								<span>
									<span className="block text-sm font-medium text-amber-100">调整并直接重做成片</span>
									<span className="mt-0.5 block text-xs leading-relaxed text-amber-100/60">
										该阶段及下游（生成 / 配音 / 剪辑）自动一路重跑，直接出新一版成片；媒体额度会重新消耗。
									</span>
								</span>
							</button>
							<GlowButton variant="ghost" className="w-full justify-start" onClick={() => onSubmit(instruction.trim(), false)} disabled={!instruction.trim() || busy}>
								{busy ? <LoaderCircle className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
								<span className="text-left">
									<span className="block">重塑此产物（先看效果）</span>
									<span className="mt-0.5 block text-xs font-normal text-zinc-500">
										只重做这一阶段的文案产物，完成后暂停，你确认满意再推进下游，不浪费生成额度。
									</span>
								</span>
								<Sparkles className="ml-auto size-3.5 shrink-0 text-amber-300 opacity-60" />
							</GlowButton>
						</div>

						<div className="mt-3 flex items-center justify-end">
							<button
								type="button"
								onClick={onClose}
								disabled={busy}
								className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 disabled:opacity-40"
							>
								取消
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
