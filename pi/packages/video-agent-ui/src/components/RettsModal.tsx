/**
 * RettsModal：旁白重录弹窗（语音级重做）。
 * 可选客户指令（语气/口语化/增删语气词…）会先改写旁白文案（字幕同步），
 * 再重新合成该镜语音；新语音就位后该镜按新时长重排、重装时间线并重新混音复审。
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AudioLines, LoaderCircle, X } from "lucide-react";
import { MAX_RETTS_PER_SHOT, api } from "@/api/client";
import { GlowButton } from "@/components/ui/primitives";

const HINTS = ["语气更兴奋一些", "更口语化、亲切一点", "放慢节奏更沉稳", "换一种说法，意思不变"];

export function RettsModal({
	shot,
	/** 已用重录次数 */
	attempts,
	/** 当前旁白文案（改写预览基准；台词镜不传） */
	narration,
	/** A5/A7：台词镜信息——存在时走"重录台词（将重新生成该镜画面）"分支 */
	dialogue,
	/** 台词镜镜长（配额预估用：口型视频重生成 ≈ durationSec 秒视频 + 2 次 TTS） */
	durationSec,
	busy,
	onClose,
	onSubmit,
}: {
	shot: { id: string } | null;
	attempts: number;
	narration?: string;
	dialogue?: { characterId: string; lines: { zh: string; en: string } } | null;
	durationSec?: number;
	busy: boolean;
	onClose: () => void;
	onSubmit: (shotId: string, instruction: string, voice?: string) => void;
}) {
	const [instruction, setInstruction] = useState("");
	const [lastShot, setLastShot] = useState<string | null>(null);
	const [voices, setVoices] = useState<Record<string, string> | null>(null);
	const [voice, setVoice] = useState("");
	const currentShot = shot?.id ?? null;
	if (currentShot !== lastShot) {
		setLastShot(currentShot);
		setInstruction("");
	}

	useEffect(() => {
		api.fetchVoices().then(setVoices).catch(() => setVoices(null));
	}, []);

	const remaining = MAX_RETTS_PER_SHOT - attempts;
	const isDialogue = Boolean(dialogue);

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
								<div className="font-mono text-[10px] tracking-[0.3em] text-amber-300/80">RE-TTS</div>
								<h3 className="mt-1 text-lg font-semibold text-zinc-100">
									{isDialogue ? `重录镜头 ${shot.id} 台词` : `重录镜头 ${shot.id} 旁白`}
									{attempts > 0 && (
										<span className="ml-2 text-xs font-normal text-zinc-500">
											已重录 {attempts}/{MAX_RETTS_PER_SHOT} 次
										</span>
									)}
								</h3>
								{isDialogue && (
									<p className="mt-1 flex items-center gap-1.5 text-xs text-amber-200">
										<AudioLines className="size-3.5" />
										级联重做：将重新生成该镜画面
									</p>
								)}
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

						{isDialogue && dialogue ? (
							<div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-100/85">
								<span className="font-medium">当前台词（{dialogue.characterId}）：</span>
								{dialogue.lines.zh}
							</div>
						) : (
							narration && (
								<div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-100/85">
									<span className="font-medium">当前旁白：</span>
									{narration}
								</div>
							)
						)}

						{!isDialogue && voices && Object.keys(voices).length > 0 && (
							<div className="mt-3">
								<label htmlFor="retts-voice" className="mb-1.5 block text-xs font-medium text-zinc-400">
									音色（不选则沿用当前音色）
								</label>
								<select
									id="retts-voice"
									value={voice}
									onChange={(e) => setVoice(e.target.value)}
									className="field-input !py-2 !text-xs"
								>
									<option value="">沿用当前音色</option>
									{Object.entries(voices).map(([label, id]) => (
										<option key={id} value={id}>
											{label}
										</option>
									))}
								</select>
							</div>
						)}

						<p className="mt-3 text-xs leading-relaxed text-zinc-500">
							{isDialogue ? (
								<>
									重录台词是<span className="text-zinc-300">级联重做</span>
									：台词是口型的驱动源，新音频就位后会自动重新生成该镜口型画面（旧画面备份为历史版本），再按新时长重排、重新混音并复审。
									预计消耗：
									<span className="font-mono text-sm text-amber-200">
										{durationSec ?? 5}s 视频配额 + 2 次 TTS + 1 轮 LLM
									</span>
									。台词沿用剧本中的角色音色。
								</>
							) : (
								<>
									只重录这一镜的语音（画面与其余镜头不动）：旧录音自动备份为历史版本。调整指令分两种——
									<span className="text-zinc-300">表演指导</span>（语气 / 语速 / 情绪，例「兴奋点、语速加快」）会作为 TTS
									导演指令直接生效，文案逐字不变；
									<span className="text-zinc-300">文案修改</span>（换说法、加卖点）则先改写旁白（字幕同步更新）再录制。
									随后该镜按新语音时长重排、重新混音并复审。
								</>
							)}
						</p>

						<textarea
							autoFocus
							value={instruction}
							rows={3}
							maxLength={500}
							placeholder="调整指令（可选，不填 = 原文重录）：例：兴奋一点、语速加快，『清爽』二字加重音"
							className="field-input mt-4 resize-y"
							onChange={(e) => setInstruction(e.target.value)}
						/>

						<div className="mt-2 flex flex-wrap gap-1.5">
							{HINTS.map((h) => (
								<button
									key={h}
									type="button"
									onClick={() => setInstruction(h)}
									className="cursor-pointer rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-zinc-400 transition-colors hover:border-amber-300/40 hover:text-amber-200"
								>
									{h}
								</button>
							))}
						</div>

						{remaining <= 0 ? (
							<p className="mt-3 text-xs text-rose-300">
								该镜头已达重录上限。可在「剧本」阶段微调文案后整体重跑，或接受当前版本。
							</p>
						) : (
							<p className="mt-3 text-xs text-zinc-500">剩余重录次数：{remaining} 次</p>
						)}

						<div className="mt-5 flex items-center justify-end gap-3">
							<GlowButton variant="ghost" onClick={onClose} disabled={busy}>
								取消
							</GlowButton>
							<GlowButton
								variant="amber"
								disabled={remaining <= 0 || busy}
								onClick={() => onSubmit(shot.id, instruction.trim(), voice || undefined)}
							>
								{busy ? <LoaderCircle className="size-4 animate-spin" /> : <AudioLines className="size-4" />}
								发起重录
							</GlowButton>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
