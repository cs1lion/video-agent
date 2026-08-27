/**
 * 审议优化 · 对比工作台。
 *
 * 交互流（用户主动发起，替代旧的自动打分门控）：
 *   ① 选基准候选 A（默认主成片）→ ② 挑/生成对比候选 B → ③ 双栏对比 + 差异条
 *   → ④ 裁决（选 A / 选 B / 都不选）+ 预设标签 + 补充说明 → ⑤ 发起审议
 *   → ⑥ 导演归因提案卡片 → ⑦ 采纳执行（reedit 生成新变体 / reshot / retts）。
 */

import { useCallback, useEffect, useState } from "react";
import {
	BadgeCheck,
	Check,
	Clapperboard,
	Gauge,
	History,
	LoaderCircle,
	Scale,
	Swords,
	WandSparkles,
	X,
} from "lucide-react";
import type {
	CutVariant,
	CutVariantsView,
	DeliberationAction,
	DeliberationLayer,
	DeliberationProposal,
	DeliberationRound,
	RunView,
} from "@/api/client";
import {
	DELIBERATION_ACTION_LABEL,
	DELIBERATION_LAYER_LABEL,
	DELIBERATION_TAGS,
	api,
} from "@/api/client";
import { useStudio } from "@/store/store";
import { GlowButton, Segmented } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const VERDICT_LABEL = { base: "保留 A", challenger: "换成 B", neither: "都不选" } as const;

const LAYER_STYLE: Record<DeliberationLayer, string> = {
	edit: "border-cyan-300/40 bg-cyan-400/10 text-cyan-200",
	asset: "border-rose-300/40 bg-rose-400/10 text-rose-200",
	prompt: "border-violet-300/40 bg-violet-400/10 text-violet-200",
	audio: "border-emerald-300/40 bg-emerald-400/10 text-emerald-200",
};

const ACTION_STYLE: Record<DeliberationAction, string> = {
	reedit: "border-cyan-300/40 bg-cyan-400/10 text-cyan-200",
	reshot: "border-amber-300/40 bg-amber-400/10 text-amber-200",
	retts: "border-emerald-300/40 bg-emerald-400/10 text-emerald-200",
	rescript: "border-rose-300/40 bg-rose-400/10 text-rose-200",
};

function variantUrl(runId: string, file: string): string {
	return `/api/runs/${encodeURIComponent(runId)}/files/${file.split(/[\\/]/).join("/")}`;
}

/** 点状步骤指示（antd Steps progressDot 思路）：对比候选 → 反馈裁决 → 导演归因 */
function StepDots({ step }: { step: number }) {
	const steps = ["对比候选", "反馈裁决", "导演归因"];
	return (
		<div className="flex flex-wrap items-center gap-2">
			{steps.map((label, i) => (
				<span key={label} className="flex items-center gap-2">
					{i > 0 && <span className={cn("h-px w-6", i <= step ? "bg-violet-300/50" : "bg-white/10")} />}
					<span className="flex items-center gap-1.5">
						<span
							className={cn(
								"size-2 rounded-full transition-colors",
								i < step
									? "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.6)]"
									: i === step
										? "bg-violet-300 shadow-[0_0_10px_rgba(167,139,250,0.9)]"
										: "bg-zinc-600",
							)}
						/>
						<span className={cn("text-[10px]", i === step ? "text-violet-200" : "text-zinc-600")}>{label}</span>
					</span>
				</span>
			))}
		</div>
	);
}

/** 差异条：从 A/B 元数据推导的客观差异（层标签 + 内容） */
function DeltaStrip({ a, b }: { a: CutVariant; b: CutVariant }) {
	const deltas: { layer: DeliberationLayer; text: string }[] = [];
	const durDelta = b.durationSec - a.durationSec;
	if (Math.abs(durDelta) > 0.15) {
		deltas.push({
			layer: "edit",
			text: `时长 ${a.durationSec.toFixed(1)}s → ${b.durationSec.toFixed(1)}s（${durDelta > 0 ? "+" : ""}${durDelta.toFixed(1)}s）`,
		});
	}
	const speed = b.speed ?? 1;
	if (Math.abs(speed - 1) > 0.02) {
		deltas.push({ layer: "edit", text: `播放速度 ${speed.toFixed(2)}x（${speed > 1 ? "更紧凑" : "更舒缓"}）` });
	}
	if (b.baseId && b.baseId !== a.id) {
		deltas.push({ layer: "asset", text: "镜头素材相同，仅剪辑参数不同" });
	}
	if (deltas.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
			<span className="text-[10px] tracking-widest text-zinc-500">差异</span>
			{deltas.map((d, i) => (
				<span key={i} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300">
					<span className={cn("rounded border px-1 py-px text-[9px]", LAYER_STYLE[d.layer])}>
						{DELIBERATION_LAYER_LABEL[d.layer]}
					</span>
					{d.text}
				</span>
			))}
		</div>
	);
}

function ComparePlayer({
	side,
	variant,
	runId,
}: {
	side: "A" | "B";
	variant: CutVariant | null;
	runId: string;
}) {
	const accent = side === "A" ? "border-cyan-300/40" : "border-violet-300/40";
	return (
		<div className={cn("overflow-hidden rounded-xl border bg-black/60", accent)}>
			<div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
				<span
					className={cn(
						"rounded-md border px-1.5 py-px font-mono text-[10px]",
						side === "A" ? "border-cyan-300/50 bg-cyan-400/10 text-cyan-200" : "border-violet-300/50 bg-violet-400/10 text-violet-200",
					)}
				>
					候选 {side}
				</span>
				{variant ? (
					<>
						<span className="truncate text-[11px] text-zinc-300">{variant.label}</span>
						<span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">{variant.durationSec.toFixed(1)}s</span>
					</>
				) : (
					<span className="text-[11px] text-zinc-600">未选择</span>
				)}
			</div>
			{variant ? (
				<video src={variantUrl(runId, variant.file)} controls className="max-h-[38vh] w-full object-contain" />
			) : (
				<div className="flex h-40 items-center justify-center text-xs text-zinc-600">在上方选择对比候选</div>
			)}
		</div>
	);
}

/** 导演提案卡片：rootCause 横幅 + findings 证据链 + 可采纳的提案动作 */
function ProposalCard({ round, runId }: { round: DeliberationRound; runId: string }) {
	const { reshot, retts } = useStudio();
	const [adopted, setAdopted] = useState<string | null>(null);
	const [adoptError, setAdoptError] = useState<string | null>(null);

	const adopt = async (proposal: DeliberationProposal, index: number) => {
		setAdoptError(null);
		const key = `p${index}`;
		try {
			if (proposal.action === "reedit") {
				const variants = await api.fetchCutVariants(runId);
				const base = variants.variants.find((v) => v.id === round.baseVariantId);
				if (!base) throw new Error("基准候选不存在");
				await api.createPaceVariant(runId, base.id, proposal.speed ?? 1.1);
			} else if (proposal.action === "reshot" && proposal.shotId) {
				await reshot(proposal.shotId, proposal.reason.slice(0, 400));
			} else if (proposal.action === "retts" && proposal.shotId) {
				await retts(proposal.shotId, proposal.reason.slice(0, 400), proposal.voice);
			} else {
				setAdoptError("该动作需在剧本阶段微调后重新推进，暂不支持一键执行");
				return;
			}
			await api.markAdopted(runId, round.id, proposal.action, proposal.target);
			setAdopted(key);
		} catch (error) {
			setAdoptError(error instanceof Error ? error.message : String(error));
		}
	};

	const doc = round.doc;
	if (!doc) {
		return (
			<div className="rounded-xl border border-rose-300/20 bg-rose-400/[0.04] px-4 py-3 text-[11px] text-rose-200">
				本轮审议未产出结论{round.error ? `：${round.error}` : ""}。你的偏好已记录，可直接再次发起。
			</div>
		);
	}
	return (
		<div className="space-y-3 rounded-xl border border-violet-300/25 bg-violet-400/[0.05] p-4">
			<div className="flex items-center gap-2">
				<WandSparkles className="size-4 text-violet-300" />
				<span className="text-xs tracking-wide text-zinc-300">导演归因 · 第 {round.at.slice(11, 16)} 的审议</span>
				<span className="ml-auto rounded-full border border-violet-300/40 bg-violet-400/10 px-2 py-0.5 text-[10px] text-violet-200">
					{VERDICT_LABEL[round.verdict]} · {round.tags.join("、") || "无标签"}
				</span>
			</div>

			<div className="rounded-lg border border-violet-300/30 bg-gradient-to-r from-violet-500/15 to-cyan-500/10 px-3.5 py-2.5">
				<div className="text-[10px] tracking-widest text-violet-300/80">主因判断</div>
				<p className="mt-1 text-[13px] leading-relaxed text-zinc-100">{doc.rootCause}</p>
			</div>

			<div className="space-y-1.5">
				{doc.findings.map((f, i) => (
					<div key={i} className="rounded-lg bg-white/[0.03] px-3 py-2">
						<div className="flex items-start gap-2">
							<span className={cn("mt-0.5 shrink-0 rounded border px-1 py-px text-[9px]", LAYER_STYLE[f.layer])}>
								{DELIBERATION_LAYER_LABEL[f.layer]}
							</span>
							<div className="min-w-0">
								<p className="text-[12px] leading-snug text-zinc-200">{f.claim}</p>
								<p className="mt-0.5 break-words text-[10px] leading-snug text-zinc-500">证据: {f.evidence}</p>
							</div>
						</div>
					</div>
				))}
			</div>

			<div className="space-y-2">
				{doc.proposals.map((p, i) => {
					const key = `p${i}`;
					const executable =
						p.action === "reedit" || ((p.action === "reshot" || p.action === "retts") && Boolean(p.shotId));
					return (
						<div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
							<span className={cn("rounded border px-1.5 py-px text-[10px]", ACTION_STYLE[p.action])}>
								{DELIBERATION_ACTION_LABEL[p.action]}
							</span>
							<span className="font-mono text-[11px] text-cyan-300">{p.target}</span>
							<span className="min-w-0 flex-1 basis-56 text-[11px] leading-snug text-zinc-400">{p.reason}</span>
							<span className="text-[10px] text-zinc-600">{p.estimatedCost}</span>
							{adopted === key ? (
								<span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
									<BadgeCheck className="size-3.5" /> 已执行
								</span>
							) : (
								<GlowButton
									variant="outline"
									disabled={!executable}
									className="px-3 py-1.5 text-xs"
									onClick={() => void adopt(p, i)}
								>
									<Check className="size-3.5" />
									采纳并执行
								</GlowButton>
							)}
						</div>
					);
				})}
			</div>
			{adoptError && <p className="text-[11px] text-rose-300">{adoptError}</p>}
		</div>
	);
}

export function DeliberationPanel({ run }: { run: RunView }) {
	const { startDeliberation, deliberating, lastDeliberation } = useStudio();
	const [data, setData] = useState<CutVariantsView | null>(null);
	const [rounds, setRounds] = useState<DeliberationRound[]>([]);
	const [baseId, setBaseId] = useState<string | null>(null);
	const [challengerId, setChallengerId] = useState<string | null>(null);
	const [verdict, setVerdict] = useState<"base" | "challenger" | "neither">("base");
	const [tags, setTags] = useState<string[]>([]);
	const [note, setNote] = useState("");
	const [creating, setCreating] = useState(false);
	const [panelError, setPanelError] = useState<string | null>(null);
	const [showHistory, setShowHistory] = useState(false);

	const reload = useCallback(async () => {
		try {
			const [v, d] = await Promise.all([api.fetchCutVariants(run.id), api.fetchDeliberations(run.id)]);
			setData(v);
			setRounds(d.rounds);
			setBaseId((prev) => prev ?? v.variants[0]?.id ?? null);
		} catch {
			// 旧 run / 服务不可达：面板隐藏由 data === null 兜底
		}
	}, [run.id]);

	useEffect(() => {
		void reload();
	}, [reload]);

	if (!data || data.variants.length === 0) return null;

	const base = data.variants.find((v) => v.id === baseId) ?? data.variants[0] ?? null;
	const challenger = data.variants.find((v) => v.id === challengerId) ?? null;
	const others = data.variants.filter((v) => v.id !== base.id);
	const canDeliberate = (tags.length > 0 || note.trim().length > 0) && !deliberating;

	const createPace = async (speed: number) => {
		if (creating) return;
		setCreating(true);
		setPanelError(null);
		try {
			await api.createPaceVariant(run.id, base.id, speed);
			const v = await api.fetchCutVariants(run.id);
			setData(v);
			setChallengerId(v.variants[v.variants.length - 1]?.id ?? null);
		} catch (error) {
			setPanelError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreating(false);
		}
	};

	const launch = async () => {
		if (!canDeliberate) return;
		setPanelError(null);
		const round = await startDeliberation({
			baseId: base.id,
			...(challenger ? { challengerId: challenger.id } : {}),
			verdict: challenger ? verdict : "neither",
			tags,
			note: note.trim() || undefined,
		});
		if (!round) return;
		setTags([]);
		setNote("");
		void reload();
	};

	return (
		<div className="space-y-4 rounded-2xl border border-violet-300/20 bg-violet-400/[0.04] p-5">
			{/* 标题行 */}
			<div className="flex flex-wrap items-center gap-2">
				<Scale className="size-4 text-violet-300" />
				<span className="text-sm font-semibold tracking-wide text-zinc-100">审议优化 · 对比工作台</span>
				<span className="text-[11px] text-zinc-500">双版对比 → 说出不满 → 导演出归因提案 → 你批准才执行</span>
				<span className="ml-auto rounded-full border border-violet-300/40 bg-violet-400/10 px-2.5 py-0.5 font-mono text-[10px] text-violet-200">
					审议 {rounds.length}/{3} 轮
				</span>
			</div>

			{/* 流程指示：对比候选 → 反馈裁决 → 导演归因 */}
			<StepDots
				step={
					deliberating ? 2 : lastDeliberation ? 3 : challengerId !== null || tags.length > 0 || note.trim() ? 1 : 0
				}
			/>

			{/* ① 候选选择区 */}
			<div className="flex flex-wrap items-center gap-2">
				<Gauge className="size-3.5 shrink-0 text-violet-300" />
				<span className="shrink-0 text-[11px] text-zinc-500">候选 A（基准）</span>
				<Segmented
					value={base.id}
					options={data.variants.map((v) => ({ value: v.id, label: v.label }))}
					onChange={(id) => {
						setBaseId(id);
						if (challengerId === id) setChallengerId(null);
					}}
				/>
				<span className="mx-1 h-4 w-px bg-white/10" />
				<span className="shrink-0 text-[11px] text-zinc-500">生成 B 候选</span>
				{data.presets.map((p) => (
					<GlowButton
						key={p.id}
						variant="outline"
						disabled={creating || deliberating}
						className="px-3 py-1.5 text-xs"
						onClick={() => void createPace(p.speed)}
					>
						{creating ? <LoaderCircle className="size-3.5 animate-spin" /> : <Clapperboard className="size-3.5" />}
						{p.label} {p.speed.toFixed(2)}x
					</GlowButton>
				))}
			</div>
			{others.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<Swords className="size-3.5 shrink-0 text-violet-300" />
					<span className="shrink-0 text-[11px] text-zinc-500">候选 B（对比）</span>
					{others.map((v) => (
						<button
							key={v.id}
							type="button"
							onClick={() => setChallengerId((prev) => (prev === v.id ? null : v.id))}
							className={cn(
								"cursor-pointer rounded-full border px-3 py-1 text-[11px] transition-colors",
								challengerId === v.id
									? "border-violet-300/50 bg-violet-400/15 text-violet-100 shadow-[0_0_14px_rgba(167,139,250,0.25)]"
									: "border-white/10 text-zinc-400 hover:border-white/25 hover:text-zinc-200",
							)}
						>
							{v.label} · {v.durationSec.toFixed(1)}s
						</button>
					))}
				</div>
			)}

			{/* ② 双栏对比 + 差异条 */}
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				<ComparePlayer side="A" variant={base} runId={run.id} />
				<ComparePlayer side="B" variant={challenger} runId={run.id} />
			</div>
			{base && challenger && <DeltaStrip a={base} b={challenger} />}

			{/* ③ 裁决（有 B 候选时）+ 标签 + 发起 */}
			<div className="space-y-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
				{challenger && (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[11px] text-zinc-500">你的裁决</span>
						<Segmented
							value={verdict}
							options={[
								{ value: "base", label: "选 A" },
								{ value: "challenger", label: "选 B" },
								{ value: "neither", label: "都不选，让导演想辙" },
							]}
							onChange={setVerdict}
						/>
					</div>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-[11px] text-zinc-500">哪里不满意</span>
					{DELIBERATION_TAGS.map((t) => (
						<button
							key={t}
							type="button"
							onClick={() => setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
							className={cn(
								"cursor-pointer rounded-full px-3 py-1 text-[11px] transition-all",
								tags.includes(t)
									? "border border-cyan-300/50 bg-cyan-400/15 text-cyan-100 shadow-[0_0_14px_rgba(34,211,238,0.2)]"
									: "border border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/25 hover:text-zinc-200",
							)}
						>
							{t}
						</button>
					))}
					<input
						value={note}
						onChange={(e) => setNote(e.target.value)}
						placeholder="补充一句（可空），如「后半段有点拖」"
						className="min-w-48 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-300/40"
					/>
				</div>
				<div className="flex items-center gap-3">
					<GlowButton disabled={!canDeliberate} onClick={() => void launch()}>
						{deliberating ? <LoaderCircle className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
						{challenger ? "发起审议" : "发起审议（单版诊断）"}
					</GlowButton>
					{!challenger && tags.length === 0 && !note.trim() && (
						<span className="text-[11px] text-zinc-600">点选标签或写一句反馈即可发起；也可先生成 B 候选做 A/B 对比</span>
					)}
					{(challenger || tags.length > 0 || note.trim()) && !challenger && (
						<span className="text-[11px] text-zinc-500">单版诊断：导演直接针对当前成片归因你的反馈</span>
					)}
					{challenger && tags.length === 0 && !note.trim() && (
						<span className="text-[11px] text-zinc-600">点选至少一个标签或写一句反馈</span>
					)}
					{deliberating && (
						<span className="text-[11px] text-violet-200">
							导演正在{challenger ? "对比两版成片、" : ""}查看镜头帧…（约 1-3 分钟）
						</span>
					)}
				</div>
				{panelError && <p className="text-[11px] text-rose-300">{panelError}</p>}
			</div>

			{/* ④ 归因提案卡片 */}
			{lastDeliberation && <ProposalCard round={lastDeliberation} runId={run.id} />}

			{/* ⑤ 历史轮次 */}
			{rounds.length > 0 && (
				<div className="rounded-xl border border-white/[0.06] bg-white/[0.02]">
					<button
						type="button"
						onClick={() => setShowHistory((v) => !v)}
						className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
					>
						<History className="size-3.5 text-zinc-500" />
						<span className="text-[11px] text-zinc-400">审议历史</span>
						<span className="font-mono text-[10px] text-zinc-600">{rounds.length} 轮</span>
						<span className="ml-auto text-[11px] text-zinc-500">{showHistory ? "收起" : "展开"}</span>
					</button>
					{showHistory && (
						<div className="space-y-1.5 border-t border-white/[0.06] px-4 py-3">
							{rounds.map((r) => (
								<div key={r.id} className="flex items-start gap-2 text-[11px]">
									<span className="shrink-0 font-mono text-zinc-600">{r.at.slice(5, 16).replace("T", " ")}</span>
									{r.doc ? (
										<BadgeCheck className="mt-0.5 size-3 shrink-0 text-emerald-300" />
									) : (
										<X className="mt-0.5 size-3 shrink-0 text-rose-300" />
									)}
									<span className="min-w-0 flex-1 truncate text-zinc-300">
										{VERDICT_LABEL[r.verdict]} · [{r.tags.join("、") || "无"}]
										{r.doc ? ` · ${r.doc.rootCause}` : ` · ${r.error ?? "无结论"}`}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
