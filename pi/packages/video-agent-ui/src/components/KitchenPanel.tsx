/**
 * KitchenPanel —— B2 只读制片主任面板（指挥台）。
 * observe_kitchen → 建议列表 + 采纳/忽略留痕 + 采纳率。B2 阶段只记录不执行：
 * 采纳是给 B3 的信号（采纳率是设计报告定义的验收度量），动作执行在 B3 接 L2 守卫。
 */

import { useCallback, useEffect, useState } from "react";
import { ChefHat, LoaderCircle, Play, ThumbsDown, ThumbsUp } from "lucide-react";
import type { KitchenObservation, KitchenSummary, SuggestionType } from "@/api/client";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<SuggestionType, string> = {
	submit: "提交",
	defer: "延后",
	downgrade: "降级",
	escalate: "上报",
	signal: "催办",
	wait: "观望",
};

const TYPE_TONE: Record<SuggestionType, string> = {
	submit: "border-emerald-300/40 text-emerald-200",
	defer: "border-amber-300/40 text-amber-200",
	downgrade: "border-amber-300/40 text-amber-200",
	escalate: "border-rose-300/40 text-rose-200",
	signal: "border-cyan-300/40 text-cyan-200",
	wait: "border-white/15 text-zinc-400",
};

function decisionOf(obs: KitchenObservation, suggestionId: string): "adopted" | "dismissed" | undefined {
	return obs.feedback?.find((f) => f.id === suggestionId)?.decision;
}

function executionOf(obs: KitchenObservation, suggestionId: string) {
	return obs.executions?.find((e) => e.id === suggestionId);
}

export function KitchenPanel({ runId, running }: { runId: string; running: boolean }) {
	const [open, setOpen] = useState(false);
	const [summary, setSummary] = useState<KitchenSummary | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setSummary(await api.kitchenFetch(runId));
			setError(null);
		} catch {
			// 观察面板是辅助信息：拉取失败静默（老 run 无 kitchen.ndjson 返回空列表是合法态）
		}
	}, [runId]);

	useEffect(() => {
		void load();
	}, [load]);

	const observe = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await api.kitchenObserve(runId);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const feedback = async (obsId: string, suggestionId: string, decision: "adopted" | "dismissed") => {
		if (busy) return;
		setBusy(true);
		try {
			await api.kitchenFeedback(runId, obsId, suggestionId, decision);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	/** B3：应用建议（L2 守卫校验 → 执行 defer/downgrade/播报；被拒也留痕） */
	const apply = async (obsId: string, suggestionId: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const r = await api.kitchenApply(runId, obsId, suggestionId);
			if (!r.verdict.ok && r.verdict.detail) setError(`守卫否决：${r.verdict.detail}`);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const stats = summary?.stats;
	const observations = [...(summary?.observations ?? [])].reverse().slice(0, 5);
	const suggestionCount = observations.reduce((n, o) => n + o.suggestions.length, 0);

	return (
		<div className="relative z-10 shrink-0 border-b border-white/[0.07] px-5 py-1.5">
			<div className="flex items-center gap-2.5">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300 transition-colors hover:text-zinc-100"
				>
					<ChefHat className="size-3.5 text-violet-300" />
					<span>制片主任建议</span>
					{suggestionCount > 0 && (
						<span className="rounded-full border border-violet-300/30 bg-violet-400/10 px-1.5 py-px font-mono text-[9px] text-violet-200">
							{suggestionCount}
						</span>
					)}
					{stats && stats.total > 0 && (
						<span className="text-[10px] text-zinc-600">
							采纳率 {Math.round((stats.adoptionRate ?? 0) * 100)}%
							{stats.applied + stats.rejected > 0 && ` · 被拒率 ${Math.round((stats.rejectionRate ?? 0) * 100)}%`}
						</span>
					)}
				</button>
				<button
					type="button"
					onClick={() => void observe()}
					disabled={busy || !running}
					title={running ? "让制片主任看一眼当前厨房（配额/排队/在途/失败）" : "仅在 run 运行中可观察"}
					className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-violet-300/30 px-2.5 py-1 text-[11px] text-violet-200 transition-colors hover:bg-violet-400/10 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy ? <LoaderCircle className="size-3 animate-spin" /> : <ChefHat className="size-3" />}
					观察厨房
				</button>
			</div>
			{error && <p className="mt-1 text-[10px] text-rose-300">{error}</p>}
			{open && (
				<div className="mt-2 space-y-2 pb-2">
					{observations.length === 0 ? (
						<p className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-zinc-600">
							还没有观察记录。run 运行中点「观察厨房」，制片主任会给出配额/排序建议（只建议，不自动执行）。
						</p>
					) : (
						observations.map((obs) => (
							<div key={obs.id} className="rounded-xl border border-violet-300/15 bg-violet-400/[0.04] p-3">
								<div className="mb-1.5 flex items-center gap-2 text-[10px] text-zinc-600">
									<span className="font-mono">{new Date(obs.at).toLocaleTimeString()}</span>
									<span>
										排队 {obs.snapshot.readyTasks.length} · 在途 {obs.snapshot.inFlightTasks.length} · 失败{" "}
										{obs.snapshot.recentFailures.length}
										{obs.snapshot.budget.remainingSec != null && ` · 剩余配额 ${obs.snapshot.budget.remainingSec}s`}
									</span>
								</div>
								{obs.suggestions.length === 0 ? (
									<p className="text-[11px] text-zinc-500">{obs.reasoning || "无需调整。"}</p>
								) : (
									<div className="space-y-1.5">
										{obs.suggestions.map((s) => {
											const decided = decisionOf(obs, s.id);
											const execution = executionOf(obs, s.id);
											return (
												<div key={s.id} className="flex items-start gap-2 rounded-lg bg-black/20 px-2.5 py-1.5">
													<span
														className={cn(
															"mt-px shrink-0 rounded-full border px-1.5 py-px text-[9px]",
															TYPE_TONE[s.type] ?? "border-white/15 text-zinc-400",
														)}
													>
														{TYPE_LABEL[s.type] ?? s.type}
													</span>
													<div className="min-w-0 flex-1">
														<p className="text-[11px] leading-relaxed text-zinc-200">
															{s.message}
															{s.taskId && <span className="ml-1 font-mono text-[9px] text-zinc-600">{s.taskId}</span>}
														</p>
														{s.reason && <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-600">{s.reason}</p>}
														{execution && (
															<p
																className={cn(
																	"mt-0.5 text-[10px] leading-relaxed",
																	execution.status === "applied" ? "text-emerald-300/80" : "text-rose-300/80",
																)}
															>
																{execution.status === "applied" ? "✓ 已执行" : "✕ 被守卫否决"} · {execution.detail}
															</p>
														)}
													</div>
													<div className="flex shrink-0 items-center gap-1">
														<button
															type="button"
															disabled={busy || !running || Boolean(execution)}
															onClick={() => void apply(obs.id, s.id)}
															title={execution ? "已执行过" : running ? "经 L2 守卫校验后执行（defer/downgrade/播报）" : "仅在 run 运行中可应用"}
															className={cn(
																"cursor-pointer rounded-md border px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
																execution?.status === "applied"
																	? "border-emerald-300/50 bg-emerald-400/15 text-emerald-200"
																	: execution?.status === "rejected"
																		? "border-rose-300/50 bg-rose-400/15 text-rose-200"
																		: "border-violet-300/40 text-violet-200 hover:bg-violet-400/10",
															)}
														>
															<Play className="size-3" />
														</button>
														<button
															type="button"
															disabled={busy || Boolean(decided)}
															onClick={() => void feedback(obs.id, s.id, "adopted")}
															title="采纳（B2 只记录，B3 才接自动执行）"
															className={cn(
																"cursor-pointer rounded-md border px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
																decided === "adopted"
																	? "border-emerald-300/50 bg-emerald-400/15 text-emerald-200"
																	: "border-white/10 text-zinc-400 hover:border-emerald-300/40 hover:text-emerald-200",
															)}
														>
															<ThumbsUp className="size-3" />
														</button>
														<button
															type="button"
															disabled={busy || Boolean(decided)}
															onClick={() => void feedback(obs.id, s.id, "dismissed")}
															title="忽略"
															className={cn(
																"cursor-pointer rounded-md border px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
																decided === "dismissed"
																	? "border-rose-300/50 bg-rose-400/15 text-rose-200"
																	: "border-white/10 text-zinc-400 hover:border-rose-300/40 hover:text-rose-200",
															)}
														>
															<ThumbsDown className="size-3" />
														</button>
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}
