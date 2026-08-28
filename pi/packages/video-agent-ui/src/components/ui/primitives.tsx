import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function GlassPanel({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return <div className={cn("glass beam-border rounded-2xl", className)}>{children}</div>;
}

export function SectionTitle({
	kicker,
	title,
	right,
}: {
	kicker?: string;
	title: string;
	right?: ReactNode;
}) {
	return (
		<div className="mb-4 flex items-end justify-between gap-4">
			<div>
			{kicker && (
				<div className="shiny-text mb-1 font-mono text-[10px] tracking-[0.35em]">{kicker}</div>
			)}
				<h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
			</div>
			{right}
		</div>
	);
}

type ButtonVariant = "primary" | "ghost" | "outline" | "danger" | "amber";

export function GlowButton({
	children,
	onClick,
	variant = "primary",
	className,
	disabled,
}: {
	children: ReactNode;
	onClick?: () => void;
	variant?: ButtonVariant;
	className?: string;
	disabled?: boolean;
}) {
	const styles: Record<ButtonVariant, string> = {
		primary: "btn-primary",
		ghost: "bg-white/5 text-zinc-200 hover:bg-white/10 border border-white/10 transition-colors",
		outline: "border border-amber-400/45 text-amber-200 hover:bg-amber-400/10 transition-colors",
		danger: "border border-rose-400/40 text-rose-200 hover:bg-rose-400/10 transition-colors",
		amber: "btn-amber",
	};
	return (
		<motion.button
			whileHover={disabled ? undefined : { y: -1 }}
			whileTap={disabled ? undefined : { scale: 0.97 }}
			onClick={onClick}
			disabled={disabled}
		className={cn(
			"glare-hover inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium select-none disabled:cursor-not-allowed disabled:opacity-40",
			styles[variant],
			className,
		)}
		>
			{children}
		</motion.button>
	);
}

export function Chip({
	children,
	active,
	onClick,
}: {
	children: ReactNode;
	active?: boolean;
	onClick?: () => void;
}) {
	return (
		<button
			onClick={onClick}
			className={cn(
				"cursor-pointer rounded-full px-3 py-1.5 text-xs transition-all duration-200",
				active
					? "border border-cyan-300/50 bg-cyan-400/15 text-cyan-100 shadow-[0_0_16px_rgba(34,211,238,0.25)]"
					: "border border-white/10 bg-white/[0.04] text-zinc-400 hover:border-white/25 hover:text-zinc-200",
			)}
		>
			{children}
		</button>
	);
}

export function StatusDot({ tone }: { tone: "done" | "active" | "pending" | "error" | "redo" }) {
	const map = {
		done: "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]",
		active: "bg-zinc-100 shadow-[0_0_12px_rgba(244,244,245,0.9)] pulse-dot",
		pending: "bg-zinc-600",
		error: "bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.8)]",
		redo: "bg-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.95)] pulse-dot",
	};
	return <span className={cn("inline-block size-2 rounded-full", map[tone])} />;
}

export function ProgressBar({ value, hue }: { value: number; hue?: number }) {
	return (
		<div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
			<motion.div
				className="absolute inset-y-0 left-0 rounded-full"
				style={{
					background: `linear-gradient(90deg, hsl(${hue ?? 40} 90% 55%), #f59e0b)`,
				}}
				animate={{ width: `${Math.min(100, value)}%` }}
				transition={{ ease: "easeOut", duration: 0.3 }}
			/>
			<div className="shimmer absolute inset-0 overflow-hidden" />
		</div>
	);
}

export function ProgressRing({
	value,
	size = 64,
	stroke = 5,
	label,
}: {
	value: number;
	size?: number;
	stroke?: number;
	label?: ReactNode;
}) {
	const r = (size - stroke) / 2;
	const c = 2 * Math.PI * r;
	return (
		<div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
			<svg width={size} height={size} className="-rotate-90">
				<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
				<motion.circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="url(#ringGrad)"
					strokeLinecap="round"
					strokeWidth={stroke}
					strokeDasharray={c}
					animate={{ strokeDashoffset: c * (1 - Math.min(100, value) / 100) }}
					transition={{ ease: "easeOut", duration: 0.6 }}
				/>
				<defs>
					<linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
						<stop offset="0%" stopColor="#fcd34d" />
						<stop offset="100%" stopColor="#d97706" />
					</linearGradient>
				</defs>
			</svg>
			<div className="absolute inset-0 flex items-center justify-center text-xs font-semibold">
				{label ?? `${Math.round(value)}%`}
			</div>
		</div>
	);
}

/** 分段选择器（横排单选，替代原 .seg 手写样式） */
export function Segmented<T extends string | number>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (v: T) => void;
}) {
	return (
		<div className="inline-flex flex-wrap gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
			{options.map((o) => (
				<button
					key={String(o.value)}
					type="button"
					onClick={() => onChange(o.value)}
					className={cn(
						"cursor-pointer rounded-lg px-3 py-1.5 text-xs transition-all duration-200",
						o.value === value
							? "bg-gradient-to-r from-cyan-500/30 to-violet-500/30 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.15)]"
							: "text-zinc-400 hover:text-zinc-200",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
