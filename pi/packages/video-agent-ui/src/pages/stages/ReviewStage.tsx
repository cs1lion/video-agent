/**
 * REVIEW 阶段：审片员 QA 裁决 —— 总分环 + 六轴评分条（含物理正确性/文字质量审核）+ 跨镜一致性预检 + 逐镜三态标注与重做。
 */

import { useEffect, useState } from "react";
import { Camera, LoaderCircle, ScanSearch } from "lucide-react";
import type { AssetFile, AxisId, ConsistencyDoc, PriorityInstruction, QaShotVerdict, QaVerdict } from "@/api/client";
import { api } from "@/api/client";
import { MetricsCard } from "@/components/MetricsCard";
import { ShotPriorityControl } from "@/components/ShotPriorityControl";
import { GlowButton, ProgressBar, ProgressRing } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { EmptyState, StageShell } from "./shared";

const AXIS_LABEL: Record<AxisId, string> = {
	briefFit: "简报契合",
	visualConsistency: "视觉一致性",
	pacing: "节奏",
	physicalAccuracy: "物理正确性",
	characterConsistency: "人物一致性",
	audioSync: "声画同步",
	textQuality: "文字质量",
};

const OVERALL: Record<QaVerdict["overall"], { label: string; cls: string }> = {
	pass: { label: "通过", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" },
	warn: { label: "有保留意见", cls: "border-amber-400/40 bg-amber-400/10 text-amber-200" },
	fail: { label: "未通过", cls: "border-rose-400/40 bg-rose-400/10 text-rose-200" },
};

const VERDICT: Record<QaShotVerdict["verdict"], { label: string; cls: string; bar: string }> = {
	ok: { label: "可用", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200", bar: "border-emerald-400/30" },
	warn: { label: "勉强", cls: "border-amber-400/40 bg-amber-400/10 text-amber-200", bar: "border-amber-400/30" },
	fail: { label: "不合格", cls: "border-rose-400/40 bg-rose-400/10 text-rose-200", bar: "border-rose-400/30" },
};

function frameShotId(name: string): string {
	return name.replace(/^qa-|\.jpg$/g, "");
}

/** 跨镜一致性预检：主动标出服装/发型/画风跳变的镜头（在用户肉眼发现之前） */
function ConsistencyCheck({
	doc,
	busy,
	error,
	onRun,
}: {
	doc: ConsistencyDoc | null | undefined;
	busy: boolean;
	error: string | null;
	onRun: () => void;
}) {
	const flagged = doc?.shots.filter((s) => s.issues.length > 0) ?? [];

	return (
		<div className="rounded-xl border border-emerald-300/20 bg-emerald-400/[0.04] px-4 py-3">
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<ScanSearch className="size-3.5 text-emerald-300" />
				<span className="text-xs tracking-wide text-zinc-300">跨镜一致性预检</span>
				<span className="text-[10px] text-zinc-500">审校模型逐镜比对角色外观与画风，在你看片之前标出跳变点</span>
				<GlowButton
					variant="outline"
					disabled={busy}
					className="ml-auto px-3 py-1.5 text-xs"
					onClick={onRun}
				>
					{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
					{doc ? "重新检查" : "开始检查"}
				</GlowButton>
			</div>
			{busy && <p className="text-[11px] text-emerald-200">审校模型正在逐镜比对全部关键帧…（约 15-40 秒）</p>}
			{error && <p className="text-[11px] text-rose-300">{error}</p>}
			{doc && !busy && (
				<div className="space-y-2">
					<p className="text-[11px] leading-relaxed text-zinc-400">{doc.overall}</p>
					{flagged.length === 0 ? (
						<p className="text-[11px] text-emerald-300">全部镜头外观与画风一致，未发现跳变。</p>
					) : (
						<div className="space-y-1.5">
							{flagged.map((s) => (
								<div key={s.shotId} className="flex flex-wrap items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2">
									<span className="rounded border border-rose-300/40 bg-rose-400/10 px-1.5 py-px font-mono text-[10px] text-rose-200">
										{s.shotId}
									</span>
									<span className="min-w-0 flex-1 text-[11px] leading-snug text-zinc-300">
										{s.appearance || "（无外观描述）"}
										{s.issues.length > 0 && <span className="text-rose-200"> · {s.issues.join("；")}</span>}
									</span>
								</div>
							))}
							<p className="text-[10px] text-zinc-500">
								提示：对不一致镜头点「补拍重做」——跳变描述会自动预填进重做指令；也可在成片交付页发起审议让导演出方案。
							</p>
						</div>
					)}
					<p className="font-mono text-[9px] text-zinc-600">
						{doc.model} · {new Date(doc.checkedAt).toLocaleString("zh-CN")}
					</p>
				</div>
			)}
			{doc === null && !busy && !error && (
				<p className="text-[11px] text-zinc-500">
					尚未预检。出片中或预检被跳过；可点上方按钮手动重跑。
				</p>
			)}
		</div>
	);
}

export function ReviewStage({
	runId,
	verdict,
	assets,
	shotAttempts,
	runStatus,
	onReshot,
}: {
	runId: string;
	verdict?: QaVerdict;
	assets: AssetFile[];
	/** 每镜已重做次数（重做中置灰按钮） */
	shotAttempts: Record<string, number>;
	/** run 状态：running 时禁止再次发起 */
	runStatus: string;
	/** 发起镜头级重做（由 StudioPage 打开 ReshotModal；instruction 为预填指令，如一致性跳变描述） */
	onReshot: (shotId: string, instruction?: string) => void;
}) {
	const frames = assets.filter((a) => a.type === "image" && a.name.startsWith("qa-"));
	const [priorities, setPriorities] = useState<Record<string, PriorityInstruction["priority"]>>({});
	useEffect(() => {
		let alive = true;
		api
			.fetchPriorityInstructions(runId)
			.then((list) => {
				if (!alive) return;
				setPriorities(Object.fromEntries(list.map((i) => [i.shotId, i.priority])));
			})
			.catch(() => {
				// 老 run 无指令文件：空态合法
			});
		return () => {
			alive = false;
		};
	}, [runId]);
	const setPriorityOf = (shotId: string, p: PriorityInstruction["priority"] | undefined) => {
		setPriorities((m) => {
			const next = { ...m };
			if (p) next[shotId] = p;
			else delete next[shotId];
			return next;
		});
	};
	// 一致性数据提升到本层：预检面板展示 + 补拍指令预填共用
	const [consistencyDoc, setConsistencyDoc] = useState<ConsistencyDoc | null | undefined>(undefined);
	const [checking, setChecking] = useState(false);
	const [checkError, setCheckError] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		setConsistencyDoc(undefined);
		api.fetchConsistency(runId)
			.then((d) => {
				if (alive) setConsistencyDoc(d);
			})
			.catch(() => {
				if (alive) setConsistencyDoc(null);
			});
		return () => {
			alive = false;
		};
	}, [runId]);
	const runConsistency = async () => {
		if (checking) return;
		setChecking(true);
		setCheckError(null);
		try {
			setConsistencyDoc(await api.checkConsistency(runId));
		} catch (e) {
			setCheckError(e instanceof Error ? e.message : String(e));
		} finally {
			setChecking(false);
		}
	};
	/** 一致性跳变 → 补拍指令预填（把预检发现直接带进重做 prompt） */
	const consistencyPrefillOf = (shotId: string): string | undefined => {
		const issue = consistencyDoc?.shots.find((s) => s.shotId === shotId && s.issues.length > 0);
		if (!issue) return undefined;
		return `保持跨镜一致${issue.appearance ? `（${issue.appearance}）` : ""}：${issue.issues.join("；")}`;
	};
	if (!verdict) {
		return (
			<StageShell kicker="STAGE 06 · REVIEW" title="质量审读">
				<EmptyState text="审片员将在成片装配后给出五维评分…" />
			</StageShell>
		);
	}
	const overall = OVERALL[verdict.overall];
	const shots = verdict.shots ?? [];
	const canReshot = runStatus !== "running";

	return (
		<StageShell kicker="STAGE 06 · REVIEW" title="质量审读">
			<div className="space-y-6">
				<div className="flex flex-wrap items-center gap-5">
					<ProgressRing value={verdict.score} size={84} stroke={7} label={`${verdict.score}`} />
					<div>
						<span className={`inline-block rounded-full border px-3 py-1 text-sm ${overall.cls}`}>{overall.label}</span>
						<p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-500">
							审片员按五个维度独立打分，并逐镜标注可用性。对不满意的镜头可直接「补拍重做」——质检反馈会自动写进重生成的提示词。
						</p>
					</div>
				</div>

				<div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
					{verdict.axes.map((axis) => (
						<div key={axis.id}>
							<div className="mb-1.5 flex items-center justify-between text-xs">
								<span className="text-zinc-300">{AXIS_LABEL[axis.id] ?? axis.id}</span>
								<span className="font-mono text-zinc-500">{axis.score}</span>
							</div>
							<ProgressBar value={axis.score} hue={axis.score >= 85 ? 160 : axis.score >= 70 ? 45 : 350} />
						</div>
					))}
				</div>

				<MetricsCard runId={runId} runStatus={runStatus} />

				<ConsistencyCheck doc={consistencyDoc} busy={checking} error={checkError} onRun={() => void runConsistency()} />

				{frames.length > 0 && (
					<div>
						<div className="mb-2.5 flex items-baseline justify-between">
							<span className="text-xs tracking-wide text-zinc-500">审片依据 · 逐镜标注</span>
							{shots.length === 0 && (
								<span className="text-[10px] text-zinc-500">（本 run 生成于逐镜标注功能上线前，仅展示抽帧）</span>
							)}
						</div>
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
							{frames.map((f) => {
								const id = frameShotId(f.name);
								const shot = shots.find((s) => s.id === id);
								const v = shot ? VERDICT[shot.verdict] : null;
								const attempts = shotAttempts[id] ?? 0;
								return (
									<div key={f.name} className={`overflow-hidden rounded-xl border ${v ? v.bar : "border-white/10"}`}>
										<img src={f.url} alt={f.name} className="aspect-video w-full object-cover" />
										<div className="space-y-1.5 bg-black/40 px-2.5 py-2">
											<div className="flex items-center gap-1">
												<span className="font-mono text-[10px] text-zinc-300">{id}</span>
												<span className="ml-auto flex items-center gap-1">
													{v ? (
														<span className={`rounded-full border px-1.5 py-px text-[10px] ${v.cls}`}>{v.label}</span>
													) : null}
													<ShotPriorityControl
														runId={runId}
														shotId={id}
														value={priorities[id]}
														onChange={(p) => setPriorityOf(id, p)}
														interactive={runStatus === "running"}
													/>
												</span>
											</div>
											{shot && shot.verdict !== "ok" && (
												<p className="line-clamp-2 text-[10px] leading-snug text-zinc-400">{shot.reason}</p>
											)}
											<GlowButton
												variant="outline"
												disabled={!canReshot}
												onClick={() => onReshot(id, consistencyPrefillOf(id))}
												className="w-full px-2 py-1 text-[11px]"
											>
												<Camera className="size-3" />
												{attempts > 0 ? `已重做 ${attempts} 次` : "补拍重做"}
											</GlowButton>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>
		</StageShell>
	);
}
