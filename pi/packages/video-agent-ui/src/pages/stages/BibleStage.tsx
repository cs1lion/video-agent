/**
 * VISUAL 阶段：美术设计 —— 风格关键词 / 色板 / 光线 / 调色，
 * 以及设计图板块：人物形象 / 实物道具 / 场景设计图（逐张调整重绘）。
 * 支持微调（stageId=visual）。
 */

import { useState } from "react";
import { LoaderCircle, Package, RefreshCw, ScrollText, UserRound } from "lucide-react";
import type { DesignBibleDoc, DesignEntity, StageId, VisualBible } from "@/api/client";
import { Chip } from "@/components/ui/primitives";
import { EmptyState, RefineAction, StageShell } from "./shared";

function DesignCard({
	entity,
	busy,
	onAdjust,
}: {
	entity: DesignEntity;
	busy: boolean;
	onAdjust: (entityId: string, instruction: string) => void;
}) {
	const [instruction, setInstruction] = useState("");
	return (
		<div id={`art-${entity.id}`} className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
			<div className="relative">
				{entity.url && entity.status === "done" ? (
					<img src={entity.url} alt={entity.name} className="aspect-square w-full object-cover" loading="lazy" />
				) : (
					<div className="flex aspect-square w-full flex-col items-center justify-center gap-2 bg-black/40">
						{entity.status === "failed" ? (
							<>
								<span className="px-4 text-center text-[11px] text-rose-200/80">{entity.error ?? "生成失败"}</span>
								{!busy && (
									<button
										type="button"
										onClick={() => onAdjust(entity.id, "")}
										className="cursor-pointer rounded-lg border border-amber-400/45 px-2.5 py-1 text-[11px] text-amber-200 transition-colors hover:bg-amber-400/10"
									>
										<RefreshCw className="mr-1 inline size-3" />
										重试生成
									</button>
								)}
							</>
						) : (
							<LoaderCircle className="size-5 animate-spin text-cyan-300/80" />
						)}
					</div>
				)}
				{busy && (
					<div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
						<LoaderCircle className="size-6 animate-spin text-amber-300" />
					</div>
				)}
				<div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8">
					<span className="font-mono text-[10px] text-cyan-300">{entity.id}</span>
					<span className="truncate text-xs font-medium text-zinc-100">{entity.name}</span>
				</div>
			</div>
			<div className="space-y-2 px-3 py-2.5">
				<p className="line-clamp-3 text-[11px] leading-relaxed text-zinc-500">{entity.design}</p>
				<div className="flex items-center gap-1.5">
					<input
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && instruction.trim() && !busy) {
								onAdjust(entity.id, instruction.trim());
								setInstruction("");
							}
						}}
						placeholder="调整这张设计，例：更年轻、金属质感"
						maxLength={120}
						className="field-input !px-2.5 !py-1.5 !text-xs"
					/>
					<button
						type="button"
						disabled={!instruction.trim() || busy}
						onClick={() => {
							onAdjust(entity.id, instruction.trim());
							setInstruction("");
						}}
						className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-violet-400/40 px-2.5 py-1.5 text-xs text-violet-200 transition-colors hover:bg-violet-400/10 disabled:cursor-not-allowed disabled:opacity-40"
					>
						<RefreshCw className="size-3.5" />
						重绘
					</button>
				</div>
			</div>
		</div>
	);
}

const DESIGN_GROUPS: {
	key: keyof Pick<DesignBibleDoc, "characters" | "props" | "scenes">;
	title: string;
	icon: typeof UserRound;
	note: string;
}[] = [
	{ key: "characters", title: "人物形象设计", icon: UserRound, note: "角色 / 拟人形象的定妆参考" },
	{ key: "props", title: "实物道具设计", icon: Package, note: "产品与关键物件的质感基准" },
	{ key: "scenes", title: "场景设计", icon: ScrollText, note: "核心场景的空间与氛围基调" },
];

export function BibleStage({
	bible,
	design,
	onRefine,
	onDesignAdjust,
	designBusy = false,
}: {
	bible: VisualBible | null;
	design?: DesignBibleDoc;
	onRefine?: (stageId: StageId) => void;
	onDesignAdjust?: (entityId: string, instruction: string) => void;
	designBusy?: boolean;
}) {
	const hasAnyDesign =
		design && (design.characters.length > 0 || design.props.length > 0 || design.scenes.length > 0);
	return (
		<StageShell
			kicker="STAGE 02 · ART DESIGN"
			title="美术设计"
			action={<RefineAction stageId="visual" onRefine={onRefine} />}
		>
			{!bible ? (
				<EmptyState text="美术指导正在确立全片视觉基调…" />
			) : (
				<div className="space-y-7">
					<div className="space-y-6">
						<div>
							<div className="mb-2.5 text-xs tracking-wide text-zinc-500">风格关键词</div>
							<div className="flex flex-wrap gap-2">
								{bible.styleKeywords.map((k) => (
									<Chip key={k} active>
										{k}
									</Chip>
								))}
							</div>
						</div>

						<div>
							<div className="mb-2.5 text-xs tracking-wide text-zinc-500">色彩基调</div>
							<div className="flex flex-wrap gap-3">
								{bible.palette.map((color) => (
									<div key={color} className="w-20">
										<div
											className="h-14 w-full rounded-xl border border-white/15 shadow-inner"
											style={{ backgroundColor: color }}
										/>
										<div className="mt-1.5 text-center font-mono text-[10px] text-zinc-500">{color}</div>
									</div>
								))}
							</div>
						</div>

						<div className="grid gap-4 sm:grid-cols-2">
							<div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
								<div className="mb-1.5 font-mono text-[10px] tracking-widest text-cyan-300/80">LIGHTING</div>
								<p className="text-sm leading-relaxed text-zinc-200">{bible.lighting}</p>
							</div>
							<div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
								<div className="mb-1.5 font-mono text-[10px] tracking-widest text-violet-300/80">COLOR GRADE</div>
								<p className="text-sm leading-relaxed text-zinc-200">{bible.grade}</p>
							</div>
						</div>
					</div>

					{/* 美术设计：概念设计图板 */}
					{onDesignAdjust &&
						DESIGN_GROUPS.map(({ key, title, icon: Icon, note }) => {
							const entities = design?.[key] ?? [];
							if (!hasAnyDesign && entities.length === 0) return null;
							return (
								<section key={key} className="rounded-2xl border border-white/10 bg-black/20 p-4">
									<div className="mb-3 flex items-baseline gap-2.5">
										<Icon className="size-4 translate-y-0.5 text-cyan-300/80" />
										<h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
										<span className="text-[11px] text-zinc-600">{note}</span>
									</div>
									{entities.length === 0 ? (
										<p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-zinc-600">
										美术设计定稿后自动推导并绘制…
										</p>
									) : (
										<div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
											{entities.map((entity) => (
												<DesignCard key={entity.id} entity={entity} busy={designBusy} onAdjust={onDesignAdjust} />
											))}
										</div>
									)}
								</section>
							);
						})}
				</div>
			)}
		</StageShell>
	);
}
