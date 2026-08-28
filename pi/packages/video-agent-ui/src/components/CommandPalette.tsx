/**
 * Cmd/Ctrl+K 指令条（工作台）：
 *  · 跳转任意已解锁阶段
 *  · 上下文动作（确认并继续 / 取消制作 / 从失败处继续，由调用方注入）
 *  · 输入不匹配任何命令时，可直接「发送给导演」
 * 键盘：↑↓ 选择 · Enter 执行 · Esc 关闭。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, MessageSquareText, Search, Zap } from "lucide-react";
import type { UiStageId } from "@/components/StageRail";
import { cn } from "@/lib/utils";

export interface PaletteStage {
	id: UiStageId;
	label: string;
	open: boolean;
}

export interface PaletteAction {
	id: string;
	label: string;
	hint?: string;
	run: () => void;
}

interface Item {
	key: string;
	label: string;
	hint?: string;
	disabled?: boolean;
	run: () => void;
}

export function CommandPalette({
	stages,
	onSelectStage,
	onSendDirector,
	actions = [],
}: {
	stages: PaletteStage[];
	onSelectStage: (id: UiStageId) => void;
	onSendDirector: (text: string) => void;
	/** 上下文动作（按 run 状态注入，如「确认并继续」「取消制作」） */
	actions?: PaletteAction[];
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen((v) => !v);
				setQuery("");
				setCursor(0);
			} else if (e.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const items = useMemo<Item[]>(() => {
		const q = query.trim().toLowerCase();
		const stageItems: Item[] = stages.map((s) => ({
			key: `stage-${s.id}`,
			label: `跳到${s.label}`,
			hint: s.open ? "阶段" : "未解锁",
			disabled: !s.open,
			run: () => onSelectStage(s.id),
		}));
		const actionItems: Item[] = actions.map((a) => ({
			key: `action-${a.id}`,
			label: a.label,
			hint: a.hint ?? "动作",
			run: a.run,
		}));
		const all = [...actionItems, ...stageItems];
		const matched = q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all;
		// 输入不像命令时，给「发送给导演」兜底
		if (q && matched.filter((i) => !i.disabled).length === 0) {
			return [
				{
					key: "director",
					label: `发送给导演：${query.trim()}`,
					hint: "对话",
					run: () => onSendDirector(query.trim()),
				},
			];
		}
		return matched;
	}, [query, stages, actions, onSelectStage, onSendDirector]);

	const enabled = items.filter((i) => !i.disabled);

	function execute(item: Item): void {
		if (item.disabled) return;
		setOpen(false);
		setQuery("");
		item.run();
	}

	return (
		<AnimatePresence>
			{open && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
					onClick={() => setOpen(false)}
				>
					<motion.div
						initial={{ opacity: 0, y: -12, scale: 0.98 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: -8, scale: 0.98 }}
						transition={{ duration: 0.18 }}
						className="glass-strong mx-auto mt-[16vh] w-[min(560px,92vw)] overflow-hidden rounded-2xl"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center gap-2 border-b border-white/[0.08] px-4">
							<Search className="size-4 shrink-0 text-zinc-500" />
							<input
								ref={inputRef}
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									setCursor(0);
								}}
								onKeyDown={(e) => {
									if (e.key === "ArrowDown") {
										e.preventDefault();
										setCursor((c) => Math.min(c + 1, enabled.length - 1));
									} else if (e.key === "ArrowUp") {
										e.preventDefault();
										setCursor((c) => Math.max(c - 1, 0));
									} else if (e.key === "Enter") {
										e.preventDefault();
										const target = enabled[cursor] ?? enabled[0];
										if (target) execute(target);
									}
								}}
								placeholder="跳阶段、跑动作，或直接对导演说点什么…"
								className="h-12 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
							/>
							<kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">ESC</kbd>
						</div>
						<div className="max-h-[46vh] overflow-y-auto p-1.5">
							{items.length === 0 && (
								<p className="px-3 py-6 text-center text-xs text-zinc-600">没有匹配的命令</p>
							)}
							{items.map((item) => {
								const enabledIdx = item.disabled ? -1 : enabled.indexOf(item);
								const highlighted = enabledIdx >= 0 && enabledIdx === cursor;
								return (
									<button
										key={item.key}
										type="button"
										disabled={item.disabled}
										onClick={() => execute(item)}
										onMouseEnter={() => enabledIdx >= 0 && setCursor(enabledIdx)}
										className={cn(
											"flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
											highlighted ? "bg-amber-400/10 text-amber-100" : "text-zinc-300",
										)}
									>
										{item.key === "director" ? (
											<MessageSquareText className="size-3.5 shrink-0 text-amber-300" />
										) : item.key.startsWith("action-") ? (
											<Zap className="size-3.5 shrink-0 text-amber-300" />
										) : (
											<CornerDownLeft className="size-3.5 shrink-0 text-zinc-500" />
										)}
										<span className="min-w-0 flex-1 truncate">{item.label}</span>
										{item.hint && <span className="shrink-0 font-mono text-[10px] text-zinc-600">{item.hint}</span>}
									</button>
								);
							})}
						</div>
						<div className="flex items-center gap-3 border-t border-white/[0.07] px-4 py-2 font-mono text-[9px] text-zinc-600">
							<span>↑↓ 移动</span>
							<span>Enter 执行</span>
							<span>Esc 关闭</span>
							<span className="ml-auto">⌘K / Ctrl+K</span>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
