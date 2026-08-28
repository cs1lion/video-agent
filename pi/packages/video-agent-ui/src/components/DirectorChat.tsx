/**
 * 右侧指挥台（360px，可折叠为 48px 图钉条；<xl 时为悬浮按钮 + 抽屉）：双标签。
 *  · 导演对话 —— 与真实 LLM 导演对话（POST /chat，事件流回显；
 *    导演可识别调整/重做意图并直接安排：补拍镜头 / 重录旁白 / 重新导出）
 *  · 团队频道 —— 全部 TeamEvent 实时滚动（交接 / 状态 / 质检 / 重做），支持类型筛选
 * 事件量超过窗口阈值时只渲染最近一批，顶部「载入更早」按需回放（轻量虚拟化）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
	ArrowRight,
	ChevronsUp,
	Clapperboard,
	ExternalLink,
	History,
	LoaderCircle,
	MessageSquareText,
	Mic,
	PanelRightClose,
	Radio,
	RotateCcw,
	Scissors,
	Send,
	ShieldCheck,
	User,
	Users,
	Video,
} from "lucide-react";
import type { RoleId, RunView, TeamEvent } from "@/api/client";
import { useStudio } from "@/store/store";
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
	handoff: { icon: ArrowRight, cls: "text-amber-200", label: "交接" },
	status: { icon: Radio, cls: "text-zinc-400", label: "状态" },
	qa: { icon: ShieldCheck, cls: "text-emerald-300", label: "质检" },
	user: { icon: User, cls: "text-zinc-200", label: "客户" },
	director: { icon: Clapperboard, cls: "text-amber-300", label: "导演" },
	redo: { icon: RotateCcw, cls: "text-amber-300", label: "重做" },
} as const;

/** 事件卡片左侧的强调色（redo 琥珀扫光 / qa 绿 / 交接浅金） */
const KIND_ACCENT: Record<TeamEvent["kind"], string> = {
	handoff: "before:bg-amber-200/60",
	status: "before:bg-zinc-500/70",
	qa: "before:bg-emerald-400/70",
	user: "before:bg-zinc-300/60",
	director: "before:bg-amber-400/70",
	redo: "before:bg-amber-300 before:shadow-[0_0_8px_rgba(251,191,36,0.9)]",
};

/** 最近动作账本（run.lastActions）的四类重做；后端 pushLastAction 写入，此前前端零消费 */
type LastAction = NonNullable<RunView["lastActions"]>[number];

const ACTION_META = {
	reshot: { icon: RotateCcw, cls: "text-amber-300", label: "补拍镜头" },
	retts: { icon: Mic, cls: "text-sky-300", label: "重录旁白" },
	reexport: { icon: Video, cls: "text-violet-300", label: "重新导出" },
	compose: { icon: Scissors, cls: "text-emerald-300", label: "混剪合成" },
} as const;

type TeamFilter = "all" | "redo" | "qa" | "handoff" | "status";

const FILTERS: { id: TeamFilter; label: string }[] = [
	{ id: "all", label: "全部" },
	{ id: "redo", label: "重做" },
	{ id: "qa", label: "质检" },
	{ id: "handoff", label: "交接" },
	{ id: "status", label: "状态" },
];

/** 频道渲染窗口：默认只渲染最近 80 条，顶部按需回放 */
const EVENT_WINDOW = 80;

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
					className="mt-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md border border-amber-300/30 bg-amber-400/[0.08] px-2 py-0.5 text-[10px] text-amber-200 transition-colors hover:border-amber-300/60 hover:bg-amber-400/15"
				>
					<ExternalLink className="size-2.5" />
					{event.link.label ?? "查看生成物"}
				</button>
			)}
		</motion.div>
	);
}

const DIRECTOR_HINTS = ["SH03 旁白语气再兴奋一点", "第二镜画面推近产品，重拍", "换个 9:16 竖版重新导出"];

/** 单条「最近动作」：类型图标 + 镜头号 + 一句做了什么 + 时间 */
function ActionItem({ action }: { action: LastAction }) {
	const meta = ACTION_META[action.kind];
	const Icon = meta.icon;
	return (
		<div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
			<Icon className={cn("mt-0.5 size-3.5 shrink-0", meta.cls)} />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className={cn("text-[11px] font-medium", meta.cls)}>{meta.label}</span>
					{action.shotId && (
						<span className="rounded border border-white/10 bg-white/5 px-1 py-px font-mono text-[9px] text-zinc-400">
							{action.shotId}
						</span>
					)}
					<span className="ml-auto shrink-0 font-mono text-[9px] text-zinc-600">{timeOf(action.at)}</span>
				</div>
				<p className="mt-0.5 break-words text-[11px] leading-relaxed text-zinc-400">{action.label}</p>
			</div>
		</div>
	);
}

/**
 * 自行订阅 store，不再由 StudioPage 透传 run.events ——
 * 团队事件是最高频的状态变更，走 props 会让父组件每次重建事件数组并牵动整页重渲染。
 * 订阅独立的 events 字段后，新事件只重渲染指挥台本身（StudioPage 的 run 引用不动）。
 */
export function DirectorChat({
	onJump,
}: {
	/** 点击事件里的生成物链接：切换阶段并定位卡片 */
	onJump?: (stage: string, focus?: string) => void;
}) {
	// 逐个字段订阅：动作函数与标量引用稳定，只有真正变化时才重渲染
	const events = useStudio((s) => s.events);
	const lastActions = useStudio((s) => s.run?.lastActions);
	const busy = useStudio((s) => s.chatBusy);
	const sendChat = useStudio((s) => s.sendChat);
	const [tab, setTab] = useState<"director" | "team" | "actions">("team");
	const [draft, setDraft] = useState("");
	const [filter, setFilter] = useState<TeamFilter>("all");
	/** 展开/折叠：桌面折叠为图钉条，移动端折叠为悬浮按钮 */
	const [open, setOpen] = useState(true);
	/** 频道渲染窗口（轻量虚拟化：默认最近 EVENT_WINDOW 条） */
	const [windowSize, setWindowSize] = useState(EVENT_WINDOW);
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
	const visibleEvents = useMemo(() => teamEvents.slice(-windowSize), [teamEvents, windowSize]);
	const hiddenCount = teamEvents.length - visibleEvents.length;
	const redoCount = useMemo(() => events.filter((e) => e.kind === "redo").length, [events]);
	/** 最近动作账本：后端 unshift 写入（最新在前、上限 20）；未透出时退化为空数组避免到处判空 */
	const actions = lastActions ?? [];

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		// 对话/频道最新在后 → 滚到底；最近动作最新在前 → 滚到顶
		el.scrollTop = tab === "actions" ? 0 : el.scrollHeight;
	}, [tab, events.length, open, actions.length]);

	function submit(): void {
		const text = draft.trim();
		if (!text || busy) return;
		void sendChat(text.slice(0, 500));
		setDraft("");
	}

	// ---- 折叠态 ----
	if (!open) {
		return (
			<>
				{/* 桌面：48px 图钉条 */}
				<button
					type="button"
					onClick={() => setOpen(true)}
					title="展开指挥台"
					className="hidden h-full w-12 shrink-0 cursor-pointer flex-col items-center justify-center gap-3 border-l border-white/[0.07] text-zinc-500 transition-colors hover:text-amber-200 xl:flex"
				>
					<MessageSquareText className="size-4" />
					{redoCount > 0 && (
						<span className="rounded-full border border-amber-300/40 bg-amber-400/15 px-1.5 py-px font-mono text-[9px] text-amber-200">
							{redoCount}
						</span>
					)}
					<span className="text-[10px] [writing-mode:vertical-lr]">指挥台</span>
				</button>
				{/* 移动/窄屏：悬浮按钮 */}
				<button
					type="button"
					onClick={() => setOpen(true)}
					title="打开指挥台"
					className="fixed bottom-5 right-5 z-40 flex size-11 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-[#1a1a1d] text-zinc-300 shadow-xl transition-colors hover:text-amber-200 xl:hidden"
				>
					<MessageSquareText className="size-4.5" />
					{redoCount > 0 && (
						<span className="absolute -right-1 -top-1 rounded-full border border-amber-300/50 bg-amber-400/90 px-1.5 py-px font-mono text-[9px] font-semibold text-amber-950">
							{redoCount}
						</span>
					)}
				</button>
			</>
		);
	}

	// ---- 展开态 ----
	return (
		<aside
			className={cn(
				"flex h-full w-[360px] shrink-0 flex-col border-l border-white/[0.07]",
				// 窄屏抽屉化：覆盖在画面之上，带实体底色与阴影
				"max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-40 max-xl:w-[min(360px,92vw)] max-xl:border-white/10 max-xl:bg-[#141416] max-xl:shadow-2xl",
			)}
		>
			{/* 标签栏 */}
			<div className="flex shrink-0 gap-1 border-b border-white/[0.07] p-2">
				{(
					[
						{ id: "team", label: "团队频道", icon: Users },
						{ id: "director", label: "导演对话", icon: Clapperboard },
						{ id: "actions", label: "最近动作", icon: History },
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
					{t.id === "actions" && actions.length > 0 && (
						<span className="relative z-10 rounded-full border border-white/10 bg-white/5 px-1.5 py-px font-mono text-[9px] text-zinc-400">
							{actions.length}
						</span>
					)}
					</button>
				))}
				<button
					type="button"
					onClick={() => setOpen(false)}
					title="收起指挥台"
					className="cursor-pointer rounded-lg px-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
				>
					<PanelRightClose className="size-3.5" />
				</button>
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
										? "border-amber-300/50 bg-amber-400/10 text-amber-200"
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
							<>
								{hiddenCount > 0 && (
									<button
										type="button"
										onClick={() => setWindowSize((n) => n + EVENT_WINDOW)}
										className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] py-1.5 text-[10px] text-zinc-500 transition-colors hover:border-white/15 hover:text-zinc-300"
									>
										<ChevronsUp className="size-3" />
										载入更早 {Math.min(hiddenCount, EVENT_WINDOW)} 条（还有 {hiddenCount} 条）
									</button>
								)}
								{visibleEvents.map((e) => (
									<EventItem key={e.id} event={e} onJump={onJump} />
								))}
							</>
						)}
					</AnimatePresence>
				) : tab === "actions" ? (
					actions.length === 0 ? (
						<div className="space-y-2 pt-8 text-center">
							<History className="mx-auto size-5 text-zinc-700" />
							<p className="text-xs leading-relaxed text-zinc-600">
								还没有执行过重做
								<br />
								补拍镜头 / 重录旁白 / 重新导出后会在此留痕
							</p>
						</div>
					) : (
						<div className="space-y-1.5">
							<p className="px-0.5 pb-0.5 text-[10px] text-zinc-600">
								最近 {actions.length} 条 · 最新在前
							</p>
							{actions.map((a) => (
								<ActionItem key={`${a.kind}-${a.shotId ?? "-"}-${a.at}`} action={a} />
							))}
						</div>
					)
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
											className="cursor-pointer rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-zinc-400 transition-colors hover:border-amber-300/40 hover:text-amber-200"
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
									<div className="max-w-[85%] rounded-xl rounded-br-sm border border-white/15 bg-white/[0.08] px-3 py-2 text-xs leading-relaxed text-zinc-100">
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

		{/* 输入区（最近动作是只读账本，不展示输入框） */}
		<div
			className={cn(
				"shrink-0 border-t border-white/[0.07] p-3",
				tab === "actions" && "hidden",
			)}
		>
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
