/**
 * ReshotModal：镜头级重做弹窗。
 * 展示该镜 QA 标注理由（自动回灌进重生成提示词）+ 可选客户指令 + 剩余次数护栏。
 */

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, LoaderCircle, X } from "lucide-react";
import { MAX_RESHOT_PER_SHOT, type QaShotVerdict } from "@/api/client";
import { GlowButton } from "@/components/ui/primitives";

const VERDICT_CLS: Record<QaShotVerdict["verdict"], string> = {
	ok: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
	warn: "border-amber-400/40 bg-amber-400/10 text-amber-200",
	fail: "border-rose-400/40 bg-rose-400/10 text-rose-200",
};

const VERDICT_LABEL: Record<QaShotVerdict["verdict"], string> = {
	ok: "可用",
	warn: "勉强",
	fail: "不合格",
};

export function ReshotModal({
	shot,
	/** 打开时预填的重做指令（如一致性预检的跳变描述） */
	initialInstruction,
	attempts,
	busy,
	onClose,
	onSubmit,
}: {
	shot: { id: string; verdict?: QaShotVerdict } | null;
	initialInstruction?: string;
	attempts: number;
	busy: boolean;
	onClose: () => void;
	onSubmit: (shotId: string, instruction: string) => void;
}) {
	const [instruction, setInstruction] = useState("");
	const [lastShot, setLastShot] = useState<string | null>(null);
	const currentShot = shot?.id ?? null;
	if (currentShot !== lastShot) {
		setLastShot(currentShot);
		setInstruction(initialInstruction ?? "");
	}

	const remaining = MAX_RESHOT_PER_SHOT - attempts;

	return (
		<AnimatePresence>
			{shot && (
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
								<div className="font-mono text-[10px] tracking-[0.3em] text-cyan-300/80">RESHOT</div>
								<h3 className="mt-1 text-lg font-semibold text-zinc-100">
									重做镜头 {shot.id}
									{attempts > 0 && (
										<span className="ml-2 text-xs font-normal text-zinc-500">
											已重做 {attempts}/{MAX_RESHOT_PER_SHOT} 次
										</span>
									)}
								</h3>
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

						{shot.verdict && shot.verdict.verdict !== "ok" && (
							<div className={`mt-3 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${VERDICT_CLS[shot.verdict.verdict]}`}>
								<span className="font-medium">审片员标注（{VERDICT_LABEL[shot.verdict.verdict]}）：</span>
								{shot.verdict.reason}
								<span className="mt-1 block text-[10px] opacity-70">该问题会自动写进重生成的提示词。</span>
							</div>
						)}

						<p className="mt-3 text-xs leading-relaxed text-zinc-500">
							只重新生成这一镜（其余镜头与配音不动）：旧片段备份为历史版本，新片段就位后自动重装时间线并重新质检。
						</p>

						<textarea
							autoFocus
							value={instruction}
							rows={3}
							maxLength={500}
							placeholder="补充指令（可选）：例：镜头推近产品，背景更干净"
							className="field-input mt-4 resize-y"
							onChange={(e) => setInstruction(e.target.value)}
						/>

						{remaining <= 0 ? (
							<p className="mt-3 text-xs text-rose-300">
								该镜头已达重做上限。可在「分镜提示词」阶段微调后整体重跑，或接受当前版本。
							</p>
						) : (
							<p className="mt-3 text-xs text-zinc-600">剩余重做次数：{remaining} 次</p>
						)}

						<div className="mt-5 flex items-center justify-end gap-3">
							<GlowButton variant="ghost" onClick={onClose} disabled={busy}>
								取消
							</GlowButton>
							<GlowButton
								disabled={remaining <= 0 || busy}
								onClick={() => onSubmit(shot.id, instruction.trim())}
							>
								{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
								发起补拍
							</GlowButton>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
