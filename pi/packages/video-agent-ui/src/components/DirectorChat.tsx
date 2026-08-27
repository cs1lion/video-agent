/**
 * 右侧指挥台（360px）：双标签。
 *  · 导演对话 —— 与真实 LLM 导演对话（POST /chat，事件流回显；
 *    导演可识别调整/重做意图并直接安排：补拍镜头 / 重录旁白 / 重新导出）
 *  · 团队频道 —— 全部 TeamEvent 实时滚动（交接 / 状态 / 质检 / 重做），支持类型筛选
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
	ArrowRight,
	Clapperboard,
	ExternalLink,
	LoaderCircle,
	Radio,
	RotateCcw,
	Send,
	ShieldCheck,
	User,
	Users,
} from "lucide-react";
import type { RoleId, TeamEvent } from "@/api/client";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<RoleId, string> = {
	producer: "制片人",
	writer: "编剧",
	art: "美术指导",
	storyboard: "分镜师",
	tech: "技术导演",
	sound: "声音设计",
	editor: "剪辑师",
	reviewer: "审片员",
	director: "导演",
};

const KIND_META = {
	handoff: { icon: ArrowRight, cls: "text-cyan-300", label: "交接" },
	status: { icon: Radio, cls: "text-zinc-400", label: "状态" },
	qa: { icon: ShieldCheck, cls: "text-emerald-300", label: "质检" },
	user: { icon: User, cls: "text-violet-300", label: "客户" },
	director: { icon: Clapperboard, cls: "text-amber-300", label: "导演" },
	redo: { icon: RotateCcw, cls: "text-amber-300", label: "重做" },
} as const;

/** 事件卡片左侧的强调色（redo 琥珀扫光 / qa 绿 / 交接青） */
const KIND_ACCENT: Record<TeamEvent["kind"], string> = {
	handoff: "before:bg-cyan-400/70",
	status: "before:bg-zinc-500/70",
	qa: "before:bg-emerald-400/70",
	user: "before:bg-violet-400/70",
	director: "before:bg-amber-400/70",
	redo: "before:bg-amber-300 before:shadow-[0_0_8px_rgba(251,191,36,0.9)]",
};

type TeamFilter = "all" | "redo" | "qa" | "handoff" | "status";

const FILTERS: { id: TeamFilter; label: string }[] = [
	{ id: "all", label: "全部" },
	{ id: "redo", label: "重做" },
	{ id: "qa", label: "质检" },
	{ id: "handoff", label: "交接" },
	{ id: "status", label: "状态" },
];

function toLabel(target: TeamEvent["to"]): string {
	return target === "client" ? "客户" : target === "all" ? "全组" : ROLE_LABEL[target];
}

function timeOf(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? "--:--"
		: d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function EventItem({
	event,
	onJump,
}: {
	event: TeamEvent;
	onJump?: (stage: string, focus?: string) => void;
}) {
	const meta = KIND_META[event.kind];
	const Icon = meta.icon;
	return (
		<motion.div
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			className={cn(
				"relative rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pl-4 pr-3 before:absolute before:inset-y-1.5 before:left-1.5 before:w-0.5 before:rounded-full",
				KIND_ACCENT[event.kind],
				event.kind === "redo" && "border-amber-300/20 bg-amber-400/[0.05]",
			)}
		>
			<div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
				<Icon className={cn("size-3", meta.cls, event.kind === "redo" && "animate-[spin_3s_linear_infinite]")} />
				<span className={cn("font-medium", meta.cls)}>{ROLE_LABEL[event.from]}</span>
				<ArrowRight className="size-2.5 text-zinc-600" />
				<span>{toLabel(event.to)}</span>
				{event.kind !== "status" && (
					<span className={cn("rounded-full border border-white/10 px-1.5 py-px text-[9px]", meta.cls)}>
						{meta.label}
					</span>
				)}
				<span className="ml-auto font-mono">{timeOf(event.at)}</span>
			</div>
			<p className="mt-1 text-xs leading-relaxed break-words text-zinc-300">{event.text}</p>
			{event.link && (
				<button
					type="button"
					onClick={() => onJump?.(event.link!.stage, event.link!.focus)}
					className="mt-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md border border-cyan-300/30 bg-cyan-400/[0.08] px-2 py-0.5 text-[10px] text-cyan-200 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15"
				>
					<ExternalLink className="size-2.5" />
					{event.link.label ?? "查看生成物"}
				</button>
			)}
		</motion.div>
	);
}

const DIRECTOR_HINTS = ["SH03 旁白语气再兴奋一点", "第二镜画面推近产品，重拍", "换个 9:16 竖版重新导出"];

export function DirectorChat({
	events,
	busy,
	onSend,
	onJump,
}: {
	events: TeamEvent[];
	/** 对话请求进行中 */
	busy: boolean;
	onSend: (text: string) => void;
	/** 点击事件里的生成物链接：切换阶段并定位卡片 */
	onJump?: (stage: string, focus?: string) => void;
}) {
	const [tab, setTab] = useState<"director" | "team">("team");
	const [draft, setDraft] = useState("");
	const [filter, setFilter] = useState<TeamFilter>("all");
	const scrollRef = useRef<HTMLDivElement>(null);

	const dialog = useMemo(() => events.filter((e) => e.kind === "user" || e.kind === "director"), [events]);
	const teamEvents = useMemo(
		() =>
			filter === "all"
				? events
				: events.filter((e) =>
						filter === "status" ? e.kind === "status" || e.kind === "director" : e.kind === filter,
					),
		[events, filter],
	);
	const redoCount = useMemo(() => events.filter((e) => e.kind === "redo").length, [events]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [tab, events.length]);

	function submit(): void {
		const text = draft.trim();
		if (!text || busy) return;
		onSend(text.slice(0, 500));
		setDraft("");
	}

	return (
		<aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-white/[0.07]">
			{/* 标签栏 */}
			<div className="flex shrink-0 gap-1 border-b border-white/[0.07] p-2">
				{(
					[
						{ id: "team", label: "团队频道", icon: Users },
						{ id: "director", label: "导演对话", icon: Clapperboard },
					] as const
				).map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setTab(t.id)}
						className={cn(
							"relative flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors",
							tab === t.id ? "text-zinc-50" : "text-zinc-500 hover:text-zinc-300",
						)}
					>
						{tab === t.id && (
							<motion.span
								layoutId="chat-tab"
								className="absolute inset-0 rounded-lg bg-white/[0.07]"
								transition={{ type: "spring", stiffness: 400, damping: 32 }}
							/>
						)}
						<t.icon className="relative z-10 size-3.5" />
						<span className="relative z-10">{t.label}</span>
						{t.id === "team" && redoCount > 0 && (
							<span className="relative z-10 rounded-full border border-amber-300/40 bg-amber-400/15 px-1.5 py-px font-mono text-[9px] text-amber-200">
								{redoCount}
							</span>
						)}
					</button>
				))}
			</div>

			{/* 团队频道筛选条 */}
			{tab === "team" && events.length > 0 && (
				<div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-3 py-2">
					{FILTERS.map((f) => {
						const count =
							f.id === "all"
								? events.length
								: f.id === "status"
									? events.filter((e) => e.kind === "status" || e.kind === "director").length
									: events.filter((e) => e.kind === f.id).length;
						return (
							<button
								key={f.id}
								type="button"
								onClick={() => setFilter(f.id)}
								className={cn(
									"cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
									filter === f.id
										? "border-cyan-300/50 bg-cyan-400/10 text-cyan-200"
										: "border-white/10 text-zinc-500 hover:border-white/25 hover:text-zinc-300",
									f.id === "redo" && filter !== f.id && count > 0 && "border-amber-300/30 text-amber-200/80",
								)}
							>
								{f.label}
								{count > 0 && <span className="ml-1 font-mono text-[9px] opacity-70">{count}</span>}
							</button>
						);
					})}
				</div>
			)}

			{/* 内容区 */}
			<div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
				{tab === "team" ? (
					<AnimatePresence initial={false}>
						{events.length === 0 ? (
							<p className="pt-8 text-center text-xs text-zinc-600">团队尚未开工</p>
						) : teamEvents.length === 0 ? (
							<p className="pt-8 text-center text-xs text-zinc-600">该类型暂无事件</p>
						) : (
							teamEvents.map((e) => <EventItem key={e.id} event={e} onJump={onJump} />)
						)}
					</AnimatePresence>
				) : (
					<div className="space-y-3">
						{dialog.length === 0 && (
							<div className="space-y-3 pt-6">
								<p className="text-center text-xs leading-relaxed text-zinc-600">
									直接提调整诉求，导演会识别并安排对应重做：
									<br />
									补拍镜头 / 重录旁白 / 重新导出成片
								</p>
								<div className="flex flex-wrap justify-center gap-1.5">
									{DIRECTOR_HINTS.map((h) => (
										<button
											key={h}
											type="button"
											onClick={() => setDraft(h)}
											className="cursor-pointer rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-zinc-400 transition-colors hover:border-cyan-300/40 hover:text-cyan-200"
										>
											{h}
										</button>
									))}
								</div>
							</div>
						)}
						{dialog.map((e) =>
							e.kind === "user" ? (
								<div key={e.id} className="flex justify-end">
									<div className="max-w-[85%] rounded-xl rounded-br-sm border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-xs leading-relaxed text-violet-100">
										{e.text}
									</div>
								</div>
							) : (
								<div key={e.id} className="flex justify-start">
									<div className="max-w-[85%] rounded-xl rounded-bl-sm border border-amber-300/20 bg-amber-400/[0.06] px-3 py-2 text-xs leading-relaxed text-zinc-200">
										{e.text}
									</div>
								</div>
							),
						)}
						{busy && (
							<div className="flex items-center gap-2 px-1 text-xs text-zinc-500">
								<LoaderCircle className="size-3 animate-spin" /> 导演正在理解你的诉求…
							</div>
						)}
					</div>
				)}
			</div>

			{/* 输入区 */}
			<div className="shrink-0 border-t border-white/[0.07] p-3">
				<div className="flex items-end gap-2">
					<textarea
						value={draft}
						rows={2}
						placeholder={
							tab === "director"
								? "对导演说点什么（支持「重拍/重录/重导」等诉求）…"
								: "切到「导演对话」标签与导演交流"
						}
						disabled={tab !== "director"}
						className="field-input max-h-28 min-h-[44px] flex-1 resize-none text-xs"
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								submit();
							}
						}}
					/>
					<button
						type="button"
						disabled={tab !== "director" || !draft.trim() || busy}
						onClick={submit}
						className="btn-primary flex size-[44px] shrink-0 cursor-pointer items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-40"
						aria-label="发送"
					>
						{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
					</button>
				</div>
			</div>
		</aside>
	);
}
