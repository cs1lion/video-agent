/**
 * ShotPriorityControl —— B4 导演契约（方向 1）：镜头优先级段控（设计方案 §4-E）。
 * P0/P1/P2 点击即提交（乐观更新、失败回滚 + 行内错因）；
 * qualityBar 一档映射，不让用户面对两层概念。
 */

import { useState } from "react";
import type { PriorityInstruction } from "@/api/client";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

type Priority = PriorityInstruction["priority"];

const QUALITY_BAR: Record<Priority, PriorityInstruction["qualityBar"]> = {
	P0: "must_keep",
	P1: "nice_to_have",
	P2: "sacrificable",
};

const PRIORITY_TITLE: Record<Priority, string> = {
	P0: "P0 必保——导演契约生效，制片主任调度时优先保这镜",
	P1: "P1 尽量保",
	P2: "P2 可牺牲——配额吃紧时可被裁剪",
};

const OPTIONS: Priority[] = ["P0", "P1", "P2"];

export function ShotPriorityControl({
	runId,
	shotId,
	value,
	onChange,
	interactive = true,
}: {
	runId: string;
	shotId: string;
	value: Priority | undefined;
	onChange: (p: Priority | undefined) => void;
	/** run 运行中才有排队任务可改优先级；否则只读展示 */
	interactive?: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (p: Priority) => {
		if (busy || p === value || !interactive) return;
		const prev = value;
		onChange(p);
		setBusy(true);
		setError(null);
		try {
			const r = await api.submitPriorityInstruction(runId, { shotId, priority: p, qualityBar: QUALITY_BAR[p] });
			if (!r.ok) throw new Error(r.detail || "提交被拒");
		} catch (e) {
			onChange(prev);
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			window.setTimeout(() => setError(null), 4000);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={cn("flex flex-col items-end gap-0.5", !interactive && "opacity-45")}>
			<div
				className={cn(
					"flex items-center overflow-hidden rounded-md border transition-opacity",
					value ? "border-white/15 opacity-100" : "border-transparent opacity-40 hover:opacity-100",
					!interactive && "hover:opacity-45",
				)}
			>
				{OPTIONS.map((p) => {
					const active = value === p;
					return (
						<button
							key={p}
							type="button"
							disabled={busy || !interactive}
							title={interactive ? PRIORITY_TITLE[p] : "run 运行中才能调整优先级（当前只读）"}
							onClick={() => void submit(p)}
							className={cn(
								"cursor-pointer px-1.5 py-px font-mono text-[9px] transition-colors disabled:cursor-not-allowed",
								p === "P0" && (active ? "bg-amber-400/90 text-zinc-950" : "text-zinc-500 hover:text-amber-200"),
								p === "P1" &&
									(active ? "bg-amber-400/10 text-amber-200 shadow-[inset_0_0_0_1px] shadow-amber-300/50" : "text-zinc-500 hover:text-amber-200"),
								p === "P2" && (active ? "bg-zinc-600/60 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"),
							)}
						>
							{p}
						</button>
					);
				})}
			</div>
			{error && (
				<span className="max-w-32 truncate text-[8px] text-rose-300" title={error}>
					{error}
				</span>
			)}
		</div>
	);
}
