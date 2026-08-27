/**
 * 阶段面板共享件：统一外壳（玻璃卡 + 标题 + 右上角动作位）与空态。
 */

import type { ReactNode } from "react";
import { Film, WandSparkles } from "lucide-react";
import { GlassPanel, SectionTitle } from "@/components/ui/primitives";
import type { StageId } from "@/api/client";

export function StageShell({
	kicker,
	title,
	action,
	children,
}: {
	kicker: string;
	title: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<GlassPanel className="p-6">
			<SectionTitle kicker={kicker} title={title} right={action} />
			{children}
		</GlassPanel>
	);
}

export function EmptyState({ text }: { text: string }) {
	return (
		<div className="flex h-44 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02]">
			<Film className="size-6 text-zinc-600" />
			<p className="text-sm text-zinc-500">{text}</p>
		</div>
	);
}

export function RefineAction({
	stageId,
	onRefine,
	label = "微调此产物",
}: {
	stageId: StageId;
	onRefine?: (stageId: StageId) => void;
	label?: string;
}) {
	if (!onRefine) return null;
	return (
		<button
			type="button"
			onClick={() => onRefine(stageId)}
			className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-violet-400/40 px-3 py-1.5 text-xs text-violet-200 transition-colors hover:bg-violet-400/10"
		>
			<WandSparkles className="size-3.5" />
			{label}
		</button>
	);
}
