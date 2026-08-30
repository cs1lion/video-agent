/**
 * OvenChips / OvenBoard —— B1 多池可视化（一 key 一烤炉）。
 * 头部圆点管「瞥一眼」，展开区 OvenBoard 管「看戏」：每炉一行 + 回充倒计时条。
 * 数据源 = 轻量快照端点，useOvens 单一轮询（5s），两处消费同一份状态。
 */

import { useEffect, useState } from "react";
import type { KitchenOven } from "@/api/client";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

const KEY_TYPE_LABEL: Record<string, string> = {
	free: "免费",
	enterprise: "企业版",
	tokenplan: "TokenPlan",
};

/** 单一轮询源：头部 chips 与展开区 board 共用 */
export function useOvens(runId: string): KitchenOven[] | null {
	const [ovens, setOvens] = useState<KitchenOven[] | null>(null);
	useEffect(() => {
		let alive = true;
		const tick = async () => {
			try {
				const snap = await api.kitchenSnapshot(runId);
				if (alive) setOvens(snap.ovens);
			} catch {
				// 烤炉是辅助信息：拉取失败静默，保留上一帧
			}
		};
		void tick();
		const timer = window.setInterval(() => void tick(), 5000);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, [runId]);
	return ovens;
}

function ovenTooltip(o: KitchenOven): string {
	const quota = o.remainingQuotaSec === null ? "无限额（限时免费）" : `剩余 ${Math.round(o.remainingQuotaSec)}s`;
	return [
		`${o.id}（${KEY_TYPE_LABEL[o.keyType] ?? o.keyType}）`,
		`可用令牌 ${Math.floor(o.tokens)}/${o.rpmCap}${o.rpmWaitMs > 0 ? ` · 下一令牌 ${Math.ceil(o.rpmWaitMs / 1000)}s 后` : ""}`,
		`今日配额 ${quota}`,
		`在途 ${o.inFlight} 条 / 预留 ${Math.round(o.reservedSec)}s`,
		o.overrunSec > 0 ? `⚠ 累计超支 ${Math.round(o.overrunSec)}s` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function TokenDots({ oven }: { oven: KitchenOven }) {
	const cap = Math.max(1, Math.round(oven.rpmCap));
	const lit = Math.min(cap, Math.floor(oven.tokens + 1e-9));
	return (
		<span className="flex items-center gap-[3px]">
			{Array.from({ length: cap }, (_, i) => {
				const filled = i < lit;
				const refilling = !filled && i === lit && oven.rpmWaitMs > 0;
				return (
					<span
						key={i}
						className={cn(
							"size-1.5 rounded-full",
							filled ? "bg-amber-300" : "border border-zinc-700",
							refilling && "pulse-dot border-amber-300/70",
						)}
					/>
				);
			})}
		</span>
	);
}

export function OvenChips({ ovens }: { ovens: KitchenOven[] | null }) {
	if (!ovens || ovens.length === 0) {
		return <span className="shrink-0 text-[10px] text-zinc-500">烤炉尚未观察</span>;
	}
	return (
		<div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
			{ovens.map((o) => (
				<span
					key={o.id}
					title={ovenTooltip(o)}
					className={cn(
						"inline-flex shrink-0 cursor-default items-center gap-1.5 rounded-lg border px-2 py-0.5",
						o.overrunSec > 0 ? "border-rose-300/50 bg-rose-400/[0.06]" : "border-white/[0.08] bg-white/[0.03]",
					)}
				>
					<TokenDots oven={o} />
					<span className="font-mono text-[9px] text-zinc-400">{o.id}</span>
					{o.inFlight > 0 && <span className="font-mono text-[9px] text-amber-200/90">在烤 {o.inFlight}</span>}
					<span
						className={cn(
							"font-mono text-[9px]",
							o.remainingQuotaSec !== null && o.remainingQuotaSec < 60 ? "font-bold text-amber-200" : "text-zinc-500",
						)}
					>
						{o.remainingQuotaSec === null ? "∞" : `余 ${Math.round(o.remainingQuotaSec)}s`}
					</span>
				</span>
			))}
		</div>
	);
}

/** 展开区烤炉行：回充倒计时条让「令牌呼吸」可见（rpmWaitMs → 进度，5s 轮询 + 1s 线性过渡） */
export function OvenBoard({ ovens }: { ovens: KitchenOven[] | null }) {
	if (!ovens || ovens.length === 0) return null;
	return (
		<div className="space-y-1.5">
			{ovens.map((o) => {
				const interval = o.rpmCap > 0 ? 60_000 / o.rpmCap : 60_000;
				const refill = o.rpmWaitMs > 0 ? Math.max(0, Math.min(1, 1 - o.rpmWaitMs / interval)) : 1;
				return (
					<div
						key={o.id}
						className={cn(
							"rounded-lg border px-3 py-2",
							o.overrunSec > 0 ? "border-rose-300/40 bg-rose-400/[0.05]" : "border-white/[0.08] bg-white/[0.02]",
						)}
					>
						<div className="flex items-center gap-2.5">
							<span className="w-16 shrink-0 font-mono text-[10px] text-zinc-300">{o.id}</span>
							<span className="shrink-0 rounded border border-white/10 px-1.5 py-px text-[9px] text-zinc-500">
								{KEY_TYPE_LABEL[o.keyType] ?? o.keyType}
							</span>
							<TokenDots oven={o} />
							<span className="font-mono text-[9px] text-zinc-500">
								{Math.floor(o.tokens)}/{o.rpmCap}
							</span>
							<span className="ml-auto font-mono text-[9px] text-zinc-500">
								{o.remainingQuotaSec === null ? "∞ 限时免费" : `余 ${Math.round(o.remainingQuotaSec)}s`}
								{o.inFlight > 0 && ` · 在烤 ${o.inFlight} / 预留 ${Math.round(o.reservedSec)}s`}
								{o.overrunSec > 0 && <span className="text-rose-300"> · 超支 {Math.round(o.overrunSec)}s</span>}
							</span>
						</div>
						{o.rpmWaitMs > 0 && (
							<div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/[0.06]">
								<div
									className="h-full rounded-full bg-zinc-300/70"
									style={{ width: `${refill * 100}%`, transition: "width 1s linear" }}
								/>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
