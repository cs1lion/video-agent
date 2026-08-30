/**
 * EXPORT 阶段：成片交付 —— 播放 / 下载 / 多画幅分发版 / 组合出片（版本并列装配）/ 指标 / 追踪。
 */

import { useEffect, useState } from "react";
import {
	Clapperboard,
	Download,
	FileDown,
	Film,
	LoaderCircle,
	MonitorSmartphone,
	Scissors,
	Sparkles,
} from "lucide-react";
import type {
	AssetFile,
	CutsView,
	ExportAspectRatio,
	RunMetrics,
	RunView,
	TraceSpan,
	TransitionsView,
	VersionsView,
} from "@/api/client";
import { api, SFX_LABEL, TRANSITION_LABEL } from "@/api/client";
import { useStudio } from "@/store/store";
import { DeliberationPanel } from "@/components/DeliberationPanel";
import { MetricsCard } from "@/components/MetricsCard";
import { GlowButton } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { EmptyState, StageShell } from "./shared";

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
			<div className="text-[10px] tracking-wide text-zinc-500">{label}</div>
			<div className="mt-1 font-mono text-lg text-zinc-100">{value}</div>
		</div>
	);
}

const KIND_BAR: Record<TraceSpan["kind"], string> = {
	llm: "bg-zinc-200/70",
	media: "bg-zinc-400/70",
	ffmpeg: "bg-amber-400/70",
	qa: "bg-emerald-400/70",
};

const KIND_DOT: Record<TraceSpan["kind"], string> = {
	llm: "bg-zinc-200",
	media: "bg-zinc-300",
	ffmpeg: "bg-amber-300",
	qa: "bg-emerald-300",
};

const STAGE_GROUP_LABEL: Record<string, string> = {
	script: "剧本",
	visual: "美术设计",
	prompts: "分镜提示词",
	clips: "片段生成",
	audio: "声音设计",
	export: "剪辑与质检",
	reshot: "镜头重做",
	chat: "导演对话",
};

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 运行追踪时间轴：按阶段分组，条形长度 = 耗时占比 */
function TraceTimeline({ runId, runStatus }: { runId: string; runStatus: string }) {
	const [spans, setSpans] = useState<TraceSpan[] | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	// 运行中每 5s 追一次；终态拉一次
	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const data = await api.fetchTraces(runId);
				if (alive) setSpans(data);
			} catch {
				// 拉取失败保留旧数据
			}
		};
		void load();
		if (runStatus === "running") {
			const timer = setInterval(load, 5000);
			return () => {
				alive = false;
				clearInterval(timer);
			};
		}
		return () => {
			alive = false;
		};
	}, [runId, runStatus, reloadKey]);

	const maxMs = spans ? Math.max(1, ...spans.map((s) => s.durationMs)) : 1;
	const groups = new Map<string, TraceSpan[]>();
	for (const span of spans ?? []) {
		const list = groups.get(span.stage) ?? [];
		list.push(span);
		groups.set(span.stage, list);
	}

	return (
		<div className="rounded-xl border border-white/10 bg-white/[0.02]">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left"
			>
				<span className="text-xs tracking-wide text-zinc-400">运行追踪</span>
				<span className="font-mono text-[10px] text-zinc-500">
					{spans ? `${spans.length} spans` : "…"}
				</span>
				{runStatus === "running" && <LoaderCircle className="size-3 animate-spin text-zinc-400" />}
				<span className="ml-auto text-xs text-zinc-500">{expanded ? "收起" : "展开"}</span>
			</button>

			{expanded && (
				<div className="space-y-4 border-t border-white/[0.06] px-4 py-3">
					{spans === null ? (
						<p className="py-4 text-center text-xs text-zinc-500">加载中…</p>
					) : spans.length === 0 ? (
						<p className="py-4 text-center text-xs text-zinc-500">
							（本 run 生成于追踪功能上线前，无 span 记录；新 run 将完整留痕）</p>
					) : (
						<>
							{[...groups.entries()].map(([stage, list]) => (
								<div key={stage}>
									<div className="mb-1.5 flex items-center gap-2">
										<span className="text-[10px] tracking-widest text-zinc-500">
											{STAGE_GROUP_LABEL[stage] ?? stage}
										</span>
										<span className="font-mono text-[10px] text-zinc-600">{list.length}</span>
									</div>
									<div className="space-y-1">
										{list.map((span) => (
											<div key={span.spanId} className="group flex items-center gap-2.5">
												<span className={cn("size-1.5 shrink-0 rounded-full", KIND_DOT[span.kind])} />
												<span className="w-44 shrink-0 truncate text-[11px] text-zinc-300">{span.name}</span>
												<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
													<div
														className={cn("h-full rounded-full", KIND_BAR[span.kind])}
														style={{ width: `${Math.max(2, (span.durationMs / maxMs) * 100)}%` }}
													/>
												</div>
												<span className="w-16 shrink-0 text-right font-mono text-[10px] text-zinc-500">
													{fmtDuration(span.durationMs)}
												</span>
												<span
													className={cn(
														"w-24 shrink-0 text-right text-[10px]",
														span.status === "ok" ? "text-zinc-500" : "text-rose-300",
													)}
												>
													{span.status === "ok" ? "" : span.status === "semantic-fail" ? "语义不合格" : "失败"}
												</span>
												{span.output && (
													<span className="pointer-events-none absolute left-1/2 top-0 z-10 hidden max-w-sm truncate rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-[10px] text-zinc-300 shadow-xl group-hover:block">
														{span.output}
													</span>
												)}
											</div>
										))}
									</div>
								</div>
							))}
							<button
								type="button"
								onClick={() => setReloadKey((k) => k + 1)}
								className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-400"
							>
								刷新
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}

/** 剪辑时间轴：镜头块按时长比例排布，切点上标注剪辑师选定的转场 */
function TransitionTimeline({ runId, runStatus }: { runId: string; runStatus: string }) {
	const [data, setData] = useState<TransitionsView | null | undefined>(undefined);

	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const d = await api.fetchTransitions(runId);
				if (alive) setData(d);
			} catch {
				if (alive) setData(null);
			}
		};
		void load();
		if (runStatus === "running") {
			const timer = setInterval(load, 5000);
			return () => {
				alive = false;
				clearInterval(timer);
			};
		}
		return () => {
			alive = false;
		};
	}, [runId, runStatus]);

	if (data === undefined) return null; // 加载中不占位
	if (data === null || data.shotDur.length === 0) return null; // 旧 run 无转场表

	const { transitions, shotDur } = data;
	const total = shotDur.reduce((sum, d) => sum + d, 0);
	const used = transitions.filter((t) => t.type !== "cut");
	const sfxCount = transitions.filter((t) => t.sfxType).length;
	const transitionOf = (afterIdx: number) => transitions.find((t) => t.afterShotIndex === afterIdx);

	return (
		<div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
			<div className="mb-2.5 flex items-center gap-2">
				<Scissors className="size-3.5 text-amber-300" />
				<span className="text-xs tracking-wide text-zinc-400">剪辑时间轴</span>
				<span className="font-mono text-[10px] text-zinc-500">
					{shotDur.length} 镜 · {total.toFixed(1)}s · {used.length} 处转场{sfxCount > 0 ? ` · ${sfxCount} 处音效` : ""}
				</span>
				{runStatus === "running" && <LoaderCircle className="size-3 animate-spin text-amber-300" />}
			</div>
			<div className="flex items-stretch gap-1 overflow-x-auto pb-1">
				{shotDur.map((dur, i) => {
					const t = transitionOf(i);
					return (
						<div key={i} className="flex shrink-0 items-center gap-1">
							<div
								className="flex min-w-[64px] flex-col justify-between rounded-lg border border-white/[0.08] bg-gradient-to-b from-amber-400/10 to-zinc-400/10 px-2 py-1.5"
								style={{ width: `${Math.max(64, (dur / total) * 560)}px` }}
							>
								<span className="font-mono text-[10px] text-zinc-300">SH{String(i + 1).padStart(2, "0")}</span>
								<span className="font-mono text-[10px] text-zinc-500">{dur.toFixed(1)}s</span>
							</div>
							{i < shotDur.length - 1 &&
								(t && t.type !== "cut" ? (
									<div
										title={`${TRANSITION_LABEL[t.type]} ${t.durationSec.toFixed(1)}s${t.sfxType ? ` · 音效 ${SFX_LABEL[t.sfxType]}` : ""}`}
										className="flex h-9 w-[52px] shrink-0 flex-col items-center justify-center rounded-md border border-amber-300/30 bg-amber-400/10"
									>
										<span className="text-[10px] leading-tight text-amber-200">{TRANSITION_LABEL[t.type]}</span>
										<span className="font-mono text-[9px] leading-tight text-amber-200/60">
											{t.durationSec.toFixed(1)}s{t.sfxType ? " ♪" : ""}
										</span>
									</div>
								) : (
									<div
										title={t?.sfxType ? `硬切 · 音效 ${SFX_LABEL[t.sfxType]}` : "硬切"}
										className="relative flex h-9 w-[24px] shrink-0 items-center justify-center"
									>
										<span className="h-6 w-px bg-white/20" />
										{t?.sfxType && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-[9px] leading-none text-amber-300/80">♪</span>}
									</div>
								))}
						</div>
					);
				})}
			</div>
			{sfxCount > 0 && (
				<div className="mt-2 flex flex-wrap gap-2 text-[10px] text-zinc-500">
					{transitions
						.filter((t) => t.sfxType)
						.map((t) => (
							<span key={t.afterShotIndex} className="rounded-full border border-white/10 px-2 py-0.5">
								SH{String(t.afterShotIndex + 1).padStart(2, "0")} 后 · {SFX_LABEL[t.sfxType!]}
							</span>
						))}
				</div>
			)}
		</div>
	);
}

/**
 * 剪辑台：每镜视频/音频版本并列，勾选组合后装配一条交付版（限次）。
 * 版本清单来自 /versions（当前 + 补拍/重录历史）；合成只走本地 ffmpeg。
 */
function ComposeDesk({
	run,
	cuts,
	onPreview,
}: {
	run: RunView;
	cuts?: CutsView;
	onPreview: (url: string) => void;
}) {
	// selector 订阅：动作函数引用稳定，store 其他字段变化不再触发本组件重渲染
	const compose = useStudio((s) => s.compose);
	const [data, setData] = useState<VersionsView | null>(null);
	const [selVideo, setSelVideo] = useState<Record<string, string>>({});
	const [selAudio, setSelAudio] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		api.fetchShotVersions(run.id)
			.then((v) => {
				if (alive) setData(v);
			})
			.catch(() => {
				if (alive) setData({ shots: [], remaining: 0 });
			});
		return () => {
			alive = false;
		};
	}, [run.id, run.videoUrl]);

	if (!data || data.shots.every((s) => s.video.length === 0)) return null;

	const remaining = data.remaining;
	const canCompose = remaining > 0 && run.status !== "running" && !busy;
	const selections: Record<string, { video?: string; audio?: string }> = {};
	for (const s of data.shots) {
		selections[s.shotId] = {
			...(selVideo[s.shotId] ? { video: selVideo[s.shotId] } : {}),
			...(selAudio[s.shotId] ? { audio: selAudio[s.shotId] } : {}),
		};
	}

	const launch = async () => {
		if (!canCompose) return;
		setBusy(true);
		setError(null);
		try {
			await compose(selections);
			setData(await api.fetchShotVersions(run.id));
			setSelVideo({});
			setSelAudio({});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const chip = (active: boolean) =>
		cn(
			"cursor-pointer rounded-md border px-1.5 py-px font-mono text-[10px] transition-colors",
			active ? "border-zinc-100/40 bg-white/[0.08] text-zinc-100" : "border-white/10 text-zinc-500 hover:text-zinc-300",
		);

	return (
		<div className="rounded-xl border border-amber-300/20 bg-amber-400/[0.04] px-4 py-3">
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<Sparkles className="size-3.5 text-amber-300" />
				<span className="text-xs tracking-wide text-zinc-300">组合出片 · 版本并列</span>
				<span className="text-[10px] text-zinc-500">逐镜勾选视频与配音版本，本地装配一条交付版（主成片不受影响）</span>
				<span
					className={cn(
						"ml-auto rounded-full border px-2 py-0.5 font-mono text-[10px]",
						remaining > 0 ? "border-amber-300/40 bg-amber-400/10 text-amber-200" : "border-white/10 text-zinc-500",
					)}
				>
					剩 {remaining} 次
				</span>
			</div>
			<div className="space-y-2">
				{data.shots.map((s) => (
					<div key={s.shotId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-white/[0.02] px-3 py-2">
						<span className="w-12 shrink-0 font-mono text-xs text-zinc-300">{s.shotId}</span>
						<span className="text-[10px] text-zinc-500">画面</span>
						{s.video.map((v) => (
							<button
								key={v.file}
								type="button"
								title={`预览/选择 ${v.file}`}
								onClick={() => setSelVideo((p) => ({ ...p, [s.shotId]: v.label === "最新" ? "" : v.file }))}
								className={chip((selVideo[s.shotId] ?? "") === (v.label === "最新" ? "" : v.file))}
							>
								{v.label}
							</button>
						))}
						<span className="mx-1 h-3.5 w-px bg-white/10" />
						<span className="text-[10px] text-zinc-500">配音</span>
						{s.audio.length === 0 ? (
							<span className="font-mono text-[10px] text-zinc-600">无配音</span>
						) : (
							s.audio.map((a) => (
								<button
									key={a.file}
									type="button"
									title={`选择 ${a.file}`}
									onClick={() => setSelAudio((p) => ({ ...p, [s.shotId]: a.label === "最新" ? "" : a.file }))}
									className={chip((selAudio[s.shotId] ?? "") === (a.label === "最新" ? "" : a.file))}
								>
									{a.label}
								</button>
							))
						)}
					</div>
				))}
			</div>
			{error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}
			<div className="mt-3 flex items-center gap-3">
				<GlowButton disabled={!canCompose} onClick={() => void launch()}>
					{busy || (run.status === "running" && !run.redoActive) ? (
						<LoaderCircle className="size-4 animate-spin" />
					) : (
						<Film className="size-4" />
					)}
					合成交付版
				</GlowButton>
				{remaining === 0 && <span className="text-[11px] text-zinc-500">次数已用尽；微调后可继续用「重新导出」。</span>}
			</div>

			{/* 已合成的交付版列表 */}
			{(cuts?.renders.length ?? 0) > 0 && (
				<div className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-2.5">
					{cuts!.renders.map((r, i) => {
						const name = r.file.split(/[\\/]/).pop() ?? `cut-${i + 1}.mp4`;
						const url = `/api/runs/${run.id}/files/assets/${encodeURIComponent(name)}`;
						return (
							<div key={r.file} id={`art-cut-${i + 1}`} className="flex items-center gap-2 text-[11px]">
								<Film className="size-3 shrink-0 text-amber-300" />
								<button
									type="button"
									onClick={() => onPreview(url)}
									className="cursor-pointer font-mono text-zinc-300 hover:text-amber-200 hover:underline"
								>
									{name}
								</button>
								<span className="text-zinc-500">{new Date(r.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
								<a href={url} download className="ml-auto inline-flex items-center gap-1 text-zinc-500 hover:text-amber-200">
									<Download className="size-3" />
									下载
								</a>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** 成片文件名 → 展示标签（final.mp4 主版 / final-9x16.mp4 竖版） */
function finalLabelOf(name: string): string {
	const m = /^final-(\d+x\d+)\.mp4$/.exec(name);
	if (!m) return "主版";
	return `${m[1]!.replace("x", ":")} 版`;
}

const ASPECT_OPTIONS: { value: ExportAspectRatio; label: string }[] = [
	{ value: "9:16", label: "9:16 竖版" },
	{ value: "1:1", label: "1:1 方版" },
	{ value: "4:3", label: "4:3 传统" },
];

export function ExportStage({
	run,
	assets,
	cuts,
}: {
	run: RunView;
	assets: AssetFile[];
	/** 组合出片台账（cuts.json；旧 run 可能缺失） */
	cuts?: CutsView;
}) {
	const metrics: RunMetrics | undefined = run.metrics;
	const audioDone = run.stages.find((s) => s.id === "audio")?.status === "done";
	const clipsDone = run.stages.find((s) => s.id === "clips")?.status === "done";
	const canReexport = audioDone && clipsDone && run.status !== "running";
	const [exportingAspect, setExportingAspect] = useState<ExportAspectRatio | null>(null);
	const [aspectError, setAspectError] = useState<string | null>(null);

	// 播放源：用户点选的分发版优先，否则跟随最近导出的成片
	const versions = assets.filter((a) => /^final(-\d+x\d+)?\.mp4$/.test(a.name));
	const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
	useEffect(() => {
		setSelectedUrl(null); // run.videoUrl 变化（重新导出完成）后回到默认源
	}, [run.videoUrl]);
	const final = selectedUrl ?? run.videoUrl;

	const exportAspect = async (aspect: ExportAspectRatio) => {
		if (!canReexport || exportingAspect) return;
		setExportingAspect(aspect);
		setAspectError(null);
		try {
			await api.reexport(run.id, aspect);
		} catch (e) {
			setAspectError(e instanceof Error ? e.message : String(e));
		} finally {
			setExportingAspect(null);
		}
	};

	return (
		<StageShell kicker="FINAL CUT" title="成片交付">
			{!final ? (
				<EmptyState text="剪辑师正在装配最终成片…" />
			) : (
				<div className="space-y-5">
					<MetricsCard runId={run.id} runStatus={run.status} />

					<div
						id="art-final"
						className="overflow-hidden rounded-xl border border-zinc-100/20 bg-black/60 shadow-[0_0_40px_rgba(244,244,245,0.06)]"
					>
						<video src={final} controls className="mx-auto max-h-[70vh] w-full object-contain" />
					</div>

					<DeliberationPanel run={run} />

					<ComposeDesk run={run} cuts={cuts} onPreview={setSelectedUrl} />

					<div className="flex flex-wrap items-center gap-3">
						<a href={api.downloadUrl(run.id)} download>
							<GlowButton>
								<Download className="size-4" />
								下载成片
							</GlowButton>
						</a>
						{assets
							.filter((a) => a.name === "subs.ass" || a.type === "other")
							.map((a) => (
								<a key={a.name} href={a.url} download>
									<GlowButton variant="outline">
										<FileDown className="size-4" />
										{a.name}
									</GlowButton>
								</a>
							))}
					</div>

					{/* 多平台分发：已有版本切换 + 其他画幅导出（复用现有镜头/配音，仅重跑剪辑） */}
					<div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
						<div className="mb-2.5 flex items-center gap-2">
							<MonitorSmartphone className="size-3.5 text-zinc-400" />
							<span className="text-xs tracking-wide text-zinc-400">多平台分发</span>
							<span className="text-[10px] text-zinc-500">一次拍摄，多画幅交付（复用现有镜头与配音）</span>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							{versions.length > 0 ? (
								versions.map((v) => (
									<button
										key={v.name}
										type="button"
										title={`播放 ${v.name}`}
										onClick={() => setSelectedUrl(v.url)}
										className={cn(
											"cursor-pointer rounded-full border px-3 py-1 text-[11px] transition-colors",
											final === v.url
												? "border-zinc-100/40 bg-white/[0.08] text-zinc-100"
												: "border-white/10 text-zinc-400 hover:border-white/25 hover:text-zinc-200",
										)}
									>
										<Clapperboard className="mr-1 inline size-3" />
										{finalLabelOf(v.name)}
									</button>
								))
							) : (
								<span className="text-[11px] text-zinc-500">暂无分发版</span>
							)}
							<span className="mx-1 h-4 w-px bg-white/10" />
							{ASPECT_OPTIONS.map((opt) => (
								<GlowButton
									key={opt.value}
									variant="outline"
									disabled={!canReexport || exportingAspect !== null}
									onClick={() => void exportAspect(opt.value)}
								>
									{exportingAspect === opt.value || (run.status === "running" && exportingAspect === null) ? (
										<LoaderCircle className="size-4 animate-spin" />
									) : (
										<MonitorSmartphone className="size-4" />
									)}
									{opt.label}
								</GlowButton>
							))}
						</div>
						{aspectError && <p className="mt-2 text-[11px] text-rose-300">{aspectError}</p>}
					</div>

					<TransitionTimeline runId={run.id} runStatus={run.status} />

					{metrics && (
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
							<Metric label="LLM 调用" value={String(metrics.llmCalls)} />
							<Metric label="媒体生成" value={String(metrics.mediaCalls)} />
							<Metric label="重试次数" value={String(metrics.retries)} />
							<Metric
								label="适配器分布"
								value={Object.keys(metrics.perAdapter).length > 0 ? Object.values(metrics.perAdapter).join(" / ") : "—"}
							/>
						</div>
					)}

					<TraceTimeline runId={run.id} runStatus={run.status} />
				</div>
			)}
		</StageShell>
	);
}
