/**
 * MetricsCard —— B5 A/B 度量落地（设计方案 §4-C）。
 * 主指标 = 配额利用率；四个次指标 + 底部账本小字。
 * 每个指标独立降级为 —（限时免费期 quotaUtilization 必为 null，显示专属文案）。
 */

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import type { RunMetrics } from "@/api/client";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

/** 被拒率告警阈值（总文档 §3.8：>20% = 代理在瞎指挥） */
const REJECTION_ALERT = 0.2;

function pct(v: number | null): string {
	return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function fmtMs(ms: number | null): string {
	if (ms === null) return "—";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function SubMetric({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
	return (
		<div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
			<div className="text-[9px] tracking-wide text-zinc-500">{label}</div>
			<div className={cn("mt-0.5 font-mono text-sm", alert ? "text-amber-200" : "text-zinc-200")}>{value}</div>
		</div>
	);
}

export function MetricsCard({ runId, runStatus }: { runId: string; runStatus: string }) {
	const [metrics, setMetrics] = useState<RunMetrics | null>(null);
	const [loaded, setLoaded] = useState(false);
	const done = runStatus === "done";

	// 进入阶段页拉一次；run.status 变为 done 时补拉一次（账本终值）
	useEffect(() => {
		let alive = true;
		api
			.fetchRunMetrics(runId)
			.then((m) => {
				if (alive) setMetrics(m);
			})
			.catch(() => {
				// 度量是辅助信息：拉取失败静默，指标降级为 —
			})
			.finally(() => {
				if (alive) setLoaded(true);
			});
		return () => {
			alive = false;
		};
	}, [runId, done]);

	const m = metrics;

	return (
		<div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
			<div className="mb-2.5 flex items-center gap-2">
				<Gauge className="size-3.5 text-amber-300" />
				<span className="text-xs tracking-wide text-zinc-400">调度度量</span>
				<span className="text-[10px] text-zinc-500">配额账本的 A/B 视角</span>
			</div>
			{!loaded ? (
				<div className="space-y-1.5">
					<div className="skeleton h-7 w-2/5" />
					<div className="skeleton h-2.5 w-3/5" />
				</div>
			) : (
				<>
					<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
						<div className="shrink-0">
							<div className="text-[10px] text-zinc-500">配额利用率</div>
							{m?.quotaUtilization != null ? (
								<div className="mt-0.5 font-mono text-2xl text-amber-200">{pct(m.quotaUtilization)}</div>
							) : (
								<div className="mt-1 text-sm text-zinc-500">限时免费期 · 不计秒数</div>
							)}
						</div>
						<div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
							<SubMetric
								label="有效吞吐"
								value={m?.effectiveThroughput != null ? `${m.effectiveThroughput.toFixed(2)} clips/min` : "—"}
							/>
							<SubMetric label="P0 延迟 P95" value={fmtMs(m?.p0LatencyP95 ?? null)} />
							<SubMetric label="浪费率" value={pct(m?.wasteRate ?? null)} />
							<SubMetric
								label="被拒率"
								value={pct(m?.rejectionRate ?? null)}
								alert={m?.rejectionRate != null && m.rejectionRate > REJECTION_ALERT}
							/>
						</div>
					</div>
					{m && (
						<div className="mt-3 border-t border-white/[0.06] pt-2 font-mono text-[10px] text-zinc-500">
							消耗 {m.consumedSec}s · 有效 {m.effectiveSec}s · 浪费 {m.wastedSec}s · 成片 {m.completedClips} · 失败{" "}
							{m.failedClips}
						</div>
					)}
				</>
			)}
		</div>
	);
}
