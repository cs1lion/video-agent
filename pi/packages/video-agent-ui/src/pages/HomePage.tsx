/**
 * 首页：Hero 口令条（一句话开拍）→ 继续制作 → 作品墙 → 流水线实况 → 团队 → 高级选项。
 * 访谈走服务端 Clarifier 会话；启动后跳转 /studio/:runId 工作台。
 * 布局原则：首屏动作 = 说一句话就开拍；访谈/高级选项/参考图全部下移或折叠。
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
	ArrowRight,
	ChevronDown,
	Clapperboard,
	Film,
	LoaderCircle,
	MessageCircleQuestion,
	SkipForward,
	Sparkles,
	Users,
} from "lucide-react";
import { DEFAULT_GENERATION_OPTIONS, type GenerationOptions } from "@earendil-works/pi-video-agent";
import { api, type CostEstimateView, type QuestionView, type UploadedImage } from "@/api/client";
import { DemoReel } from "@/components/DemoReel";
import { ImageUploader } from "@/components/ImageUploader";
import { OptionsForm } from "@/components/OptionsForm";
import { PipelineFlow } from "@/components/PipelineFlow";
import { RecentProjects } from "@/components/RecentProjects";
import { TeamGrid } from "@/components/TeamGrid";
import { FoldText } from "@/components/fx/FoldText";
import { Lightfall } from "@/components/fx/Lightfall";
import { GlassPanel, GlowButton, ProgressBar, SectionTitle } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Phase = "brief" | "interview" | "ready";

/** Lightfall 主题色：暗底亮暖（琥珀→橙→暖玫）；模块级常量保持引用稳定（组件内 effect 依赖它） */
const HERO_LIGHTFALL_COLORS = ["#fbbf24", "#fb923c", "#fb7185"];

export function HomePage() {
	const navigate = useNavigate();
	const [logline, setLogline] = useState("");
	const [keyMessage, setKeyMessage] = useState("");
	const [images, setImageList] = useState<UploadedImage[]>([]);
	const [options, setOptions] = useState<GenerationOptions>({ ...DEFAULT_GENERATION_OPTIONS });
	const [phase, setPhase] = useState<Phase>("brief");
	const [question, setQuestion] = useState<QuestionView | null>(null);
	/** 定制题后台生成中（question 为空 + pending → 轮询等就绪，不阻塞交互） */
	const [tailorPending, setTailorPending] = useState(false);
	const [progress, setProgress] = useState({ answeredCount: 0, askedCount: 0, total: 0 });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	/** P2：启动前预估成本（shotCount 等参数变化时重拉） */
	const [estimate, setEstimate] = useState<CostEstimateView | null>(null);

	function briefOf(): { logline: string; keyMessage?: string } {
		return { logline: logline.trim(), ...(keyMessage.trim() ? { keyMessage: keyMessage.trim() } : {}) };
	}

	async function run(fn: () => Promise<void>): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const startInterview = () =>
		run(async () => {
			await api.startInterview(briefOf());
			const r = await api.currentQuestion();
			if (r.question) {
				setPhase("interview");
				setQuestion(r.question);
			} else if (r.pending) {
				setPhase("interview");
				setQuestion(null);
				setTailorPending(true);
			} else {
				setPhase("ready");
			}
		});

	const applyAdvance = (r: { done: boolean; pending?: boolean; question: QuestionView | null; answeredCount: number; askedCount: number; total: number }) => {
		setProgress({ answeredCount: r.answeredCount, askedCount: r.askedCount, total: r.total });
		if (r.pending) {
			setQuestion(null);
			setTailorPending(true);
			return;
		}
		setTailorPending(false);
		if (r.done || !r.question) setPhase("ready");
		else setQuestion(r.question);
	};

	const answer = (answerId: string) =>
		run(async () => {
			applyAdvance(await api.answerQuestion(answerId));
		});

	const skipQuestion = () =>
		run(async () => {
			applyAdvance(await api.skipQuestion());
		});

	// P2：估算成本随选项变化（shotCount 等参数变 → 重拉）
	useEffect(() => {
		let alive = true;
		// debounce 200ms 避免连续调节冲响应
		const timer = setTimeout(() => {
			api
				.estimateCost(options)
				.then((e) => {
					if (alive) setEstimate(e);
				})
				.catch(() => {
					if (alive) setEstimate(null);
				});
		}, 200);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [options]);

	// 定制题就绪轮询：pending 期间每 1.6s 拉一次，拿到题即停
	useEffect(() => {
		if (phase !== "interview" || question || !tailorPending) return;
		let alive = true;
		const timer = setInterval(() => {
			void (async () => {
				try {
					const r = await api.currentQuestion();
					if (!alive) return;
					if (r.question) {
						setQuestion(r.question);
						setTailorPending(false);
					} else if (!r.pending) {
						setPhase("ready");
						setTailorPending(false);
					}
				} catch {
					// 网络抖动：下一轮继续
				}
			})();
		}, 1600);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [phase, question, tailorPending]);

	const skipInterview = () =>
		run(async () => {
			await api.skipInterview();
			setPhase("ready");
			setQuestion(null);
			setTailorPending(false);
		});

	const generate = () =>
		run(async () => {
			const { runId } = await api.generate(briefOf(), options, images.map((i) => i.id));
			navigate(`/studio/${encodeURIComponent(runId)}`);
		});

	const canRoll = Boolean(logline.trim()) && !busy;

	return (
		<div className="relative min-h-dvh overflow-x-hidden text-zinc-200">
			{/* 流光雨幕：与主体同一块（absolute 随内容同高同滚）；定位走内联样式，避免被组件 CSS 的 position:relative 覆盖 */}
			<Lightfall
				className="pointer-events-none"
				style={{
					position: "absolute",
					inset: 0,
					/* 暖光垂直渐隐：标题区最亮，向下淡出，表单区只留余韵 */
					maskImage: "linear-gradient(180deg, black 0%, black 40%, transparent 82%)",
					WebkitMaskImage: "linear-gradient(180deg, black 0%, black 40%, transparent 82%)",
				}}
				colors={HERO_LIGHTFALL_COLORS}
				backgroundColor="#1c0e03"
				speed={0.45}
				streakCount={3}
				streakWidth={1.4}
				streakLength={1.35}
				glow={1.15}
				density={0.6}
				zoom={3}
				backgroundGlow={0.32}
				opacity={0.75}
				mouseInteraction={false}
				mixBlendMode="screen"
			/>
			{/* 暗角收紧：中心透明区缩小，边缘压得更暗 */}
			<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_26%,rgba(7,6,5,0.8)_100%)]" />

			<main className="relative z-10 mx-auto flex w-full max-w-5xl flex-col gap-16 px-5 pb-16 pt-24">
				{/* ---------- Hero：一句话开拍 ---------- */}
				<motion.section
					initial={{ opacity: 0, y: 18 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6 }}
					className="flex flex-col items-center text-center"
				>
					<div className="mb-3 font-mono text-[11px] tracking-[0.4em] text-amber-300/80">PI STUDIO · VIDEO AGENT</div>
					<FoldText
						text="一句话，一部短片"
						splitBy="char"
						hinge="top"
						duration={0.7}
						stagger={0.06}
						trigger="mount"
						perspective={900}
						creaseShading={0.5}
						color="#fff7ed"
						fontSize="clamp(2.4rem, 8vw, 4.6rem)"
						fontWeight={800}
						className="block cursor-default"
					/>
					<p className="mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
						导演、编剧、美术、分镜、技术导演、声音与剪辑接力协作，全程可视化，关键产物经你确认后再消耗生成额度。
					</p>

					{/* 导演口令条：说一句话就开拍 */}
					<div className="glass-strong mt-8 flex w-full max-w-2xl items-center gap-2 rounded-2xl p-2">
						<Sparkles className="ml-2 size-4 shrink-0 text-amber-300/80" />
						<input
							value={logline}
							onChange={(e) => setLogline(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && canRoll) void startInterview();
							}}
							placeholder="说一句创意：25 秒气泡水广告，夏日傍晚天台的清爽感…"
							className="h-10 min-w-0 flex-1 bg-transparent px-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
						/>
						<GlowButton onClick={startInterview} disabled={!canRoll} className="shrink-0">
							{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Clapperboard className="size-4" />}
							开拍
						</GlowButton>
					</div>
					<div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[11px] text-zinc-500">
						<button
							type="button"
							onClick={startInterview}
							disabled={!canRoll}
							className="inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
						>
							<MessageCircleQuestion className="size-3.5" />
							先聊几句（创意访谈）
						</button>
						<span className="text-zinc-700">·</span>
						<button
							type="button"
							onClick={generate}
							disabled={!canRoll}
							className="inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
						>
							<SkipForward className="size-3.5" />
							跳过访谈直接制作
						</button>
						<span className="text-zinc-700">·</span>
						<button
							type="button"
							onClick={() => navigate("/cocreate", { state: { brief: briefOf(), options, images } })}
							disabled={busy}
							className="inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Users className="size-3.5" />
							共创工作室
						</button>
					</div>
					<div className="mt-5 flex flex-wrap justify-center gap-2 text-[11px] text-zinc-500">
						{["短片 & 广告片", "逐阶段微调", "审议优化闭环", "参考图注入"].map((s) => (
							<span key={s} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
								{s}
							</span>
						))}
					</div>
					{error && (
						<div className="mt-4 w-full max-w-2xl rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-left text-sm text-rose-200">
							{error}
						</div>
					)}
				</motion.section>

				{/* ---------- 继续制作（运行中 / 待确认 / 成品都可回到工作台） ---------- */}
				<RecentProjects />

				{/* ---------- 访谈 / 就绪面板（口令条触发后展开） ---------- */}
				<AnimatePresence mode="wait">
					{phase !== "brief" && (
						<motion.div
							key={phase}
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -12 }}
							transition={{ duration: 0.3 }}
						>
							<GlassPanel className="p-6 sm:p-8">
								<AnimatePresence mode="wait">
									{phase === "interview" && (
										<motion.div
											key="interview"
											initial={{ opacity: 0, x: 24 }}
											animate={{ opacity: 1, x: 0 }}
											exit={{ opacity: 0, x: -24 }}
											transition={{ duration: 0.25 }}
										>
											<SectionTitle
												kicker="ART DIRECTION INTERVIEW"
												title="美术指导想先了解你"
												right={
													progress.total > 0 && (
														<span className="font-mono text-xs text-zinc-500">
															{progress.answeredCount}/{progress.total}
														</span>
													)
												}
											/>
											{question ? (
												<div className="space-y-5">
													<ProgressBar value={progress.total > 0 ? Math.min(100, (progress.askedCount / progress.total) * 100) : 8} />
													<div className="flex items-center gap-2">
														<span
															className={cn(
																"rounded-full border px-2.5 py-0.5 text-[11px]",
																question.weight === "tailored"
																	? "border-violet-300/50 bg-violet-400/10 text-violet-200"
																	: "border-amber-300/40 bg-amber-400/10 text-amber-200",
															)}
														>
															{question.category}
														</span>
														<span className="text-[11px] text-zinc-500">
															{question.weight === "core" ? "核心偏好" : question.weight === "tailored" ? "按你的需求定制" : "进阶微调"}
														</span>
													</div>
													<p className="text-base leading-relaxed text-zinc-100">{question.text}</p>
													<div className="grid gap-2">
														{question.options.map((opt) => (
															<button
																key={opt.id}
																type="button"
																disabled={busy}
																onClick={() => answer(opt.id)}
																className="glare-hover group cursor-pointer rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition-all hover:border-amber-300/50 hover:bg-amber-400/10 disabled:opacity-50"
															>
																<div className="flex items-center justify-between gap-3">
																	<span className="text-sm font-medium text-zinc-100 group-hover:text-amber-100">{opt.label}</span>
																	<ArrowRight className="size-4 shrink-0 text-zinc-600 transition-colors group-hover:text-amber-300" />
																</div>
																{opt.hint && <div className="mt-1 text-xs text-zinc-500">{opt.hint}</div>}
															</button>
														))}
													</div>
													<div className="flex items-center justify-between pt-1">
														<button
															type="button"
															disabled={busy}
															onClick={skipQuestion}
															className="cursor-pointer text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
														>
															这道题先跳过，不选也行
														</button>
														<GlowButton variant="ghost" onClick={skipInterview} disabled={busy}>
															跳过剩余问题
														</GlowButton>
													</div>
													{busy && (
														<p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
															<LoaderCircle className="size-3 animate-spin" />
															{progress.answeredCount >= 8 && progress.askedCount <= 10
																? "正在按你的需求定制后续问题…"
																: "正在准备下一题…"}
														</p>
													)}
												</div>
											) : tailorPending ? (
												<div className="flex h-40 flex-col items-center justify-center gap-3">
													<LoaderCircle className="size-5 animate-spin text-violet-300" />
													<p className="text-sm text-zinc-300">正在按你的需求生成 5 道定制问题…</p>
													<p className="text-[11px] text-zinc-600">已结合你的风格偏好，通常几秒内完成；也可以先跳过</p>
													<GlowButton variant="ghost" onClick={skipInterview} disabled={busy}>
														跳过剩余问题
													</GlowButton>
												</div>
											) : (
												<div className="flex h-32 items-center justify-center text-sm text-zinc-500">
													<LoaderCircle className="mr-2 size-4 animate-spin" /> 正在准备访谈…
												</div>
											)}
										</motion.div>
									)}

									{phase === "ready" && (
										<motion.div
											key="ready"
											initial={{ opacity: 0, x: 24 }}
											animate={{ opacity: 1, x: 0 }}
											exit={{ opacity: 0, x: -24 }}
											transition={{ duration: 0.25 }}
										>
											<SectionTitle kicker="READY TO ROLL" title="需求已就绪" />
											<div className="space-y-5">
												<div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
													<div className="text-sm text-zinc-100">{briefOf().logline}</div>
													{keyMessage.trim() && <div className="mt-1 text-xs text-zinc-500">关键信息：{keyMessage.trim()}</div>}
													{images.length > 0 && (
														<div className="mt-3 flex gap-2">
															{images.map((img) => (
																<img key={img.id} src={img.url} alt={img.name} className="size-12 rounded-lg object-cover" />
															))}
														</div>
													)}
												</div>
												<p className="text-xs leading-relaxed text-zinc-500">
													点击「启动制作」后团队立即开工：编剧 → 美术设计 → 分镜提示词 → 片段生成 → 配音 → 成片导出。美术设计与关键帧完成后会各暂停一次等你确认，避免未确认就消耗生成额度。
													过程中可随时在工作台与导演对话或对中间产物提出修改。
												</p>
												{/* P2：启动前预估成本 */}
												{estimate && (
													<div
														className="rounded-xl border border-amber-300/20 bg-amber-400/[0.05] px-4 py-3"
														title={estimate.lines.map((l) => `${l.label}: ${estimate.currency === "CNY" ? "¥" : "$"}${l.amount.toFixed(2)}`).join("\n")}
													>
														<div className="flex items-center justify-between gap-2">
															<span className="text-xs font-medium text-amber-200">本次预估成本</span>
															<span className="font-mono text-base text-amber-100">
																{estimate.currency === "CNY" ? "¥" : "$"}
																{estimate.total.toFixed(2)}
															</span>
														</div>
														<div className="mt-1 text-[10px] leading-relaxed text-zinc-500">
															{estimate.lines
																.slice(0, 4)
																.map((l) => `${l.label} ${estimate.currency === "CNY" ? "¥" : "$"}${l.amount.toFixed(2)}`)
																.join(" · ")}
														</div>
														<p className="mt-1 text-[10px] text-zinc-600">
															只是参考估算。实时计费以生成后实际调用为准（下次迭代接入）。
														</p>
													</div>
												)}
												<div className="flex flex-wrap items-center gap-3 pt-1">
													<GlowButton onClick={generate} disabled={busy}>
														{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Clapperboard className="size-4" />}
														启动制作
													</GlowButton>
													<GlowButton variant="ghost" onClick={() => setPhase("brief")} disabled={busy}>
														返回修改需求
													</GlowButton>
												</div>
											</div>
										</motion.div>
									)}
								</AnimatePresence>
							</GlassPanel>
						</motion.div>
					)}
				</AnimatePresence>

				{/* ---------- 作品墙（有成片才出现） ---------- */}
				<DemoReel />

				{/* ---------- 流水线实况 ---------- */}
				<section>
					<div className="mb-4 flex items-end justify-between gap-4">
						<div>
							<div className="shiny-text mb-1 font-mono text-[10px] tracking-[0.35em]">PIPELINE</div>
							<h2 className="text-lg font-semibold text-zinc-100">六阶段流水线，全程可视化</h2>
						</div>
						<span className="font-mono text-xs text-zinc-500">script → export</span>
					</div>
					<GlassPanel className="p-5">
						<PipelineFlow demo />
						<p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
							每个阶段由对应 Agent 负责，产物实时可查；美术设计与关键帧两处设有确认闸门，你点头才继续。
						</p>
					</GlassPanel>
				</section>

				{/* ---------- 制作团队 ---------- */}
				<TeamGrid />

				{/* ---------- 高级选项（折叠收纳） ---------- */}
				<section>
					<button
						type="button"
						onClick={() => setAdvancedOpen((v) => !v)}
						className="group flex w-full cursor-pointer items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300 transition-colors hover:border-white/20"
					>
						<span className="flex items-center gap-2">
							高级选项与参考素材
							{(keyMessage.trim() || images.length > 0) && (
								<span className="rounded-full border border-amber-300/40 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
									已配置
								</span>
							)}
						</span>
						<ChevronDown className={cn("size-4 text-zinc-500 transition-transform duration-300", advancedOpen && "rotate-180")} />
					</button>
					<AnimatePresence initial={false}>
						{advancedOpen && (
							<motion.div
								initial={{ height: 0, opacity: 0 }}
								animate={{ height: "auto", opacity: 1 }}
								exit={{ height: 0, opacity: 0 }}
								transition={{ duration: 0.3, ease: "easeInOut" }}
								className="overflow-hidden"
							>
								<GlassPanel className="mt-3 space-y-5 p-6">
									<div>
										<label htmlFor="keyMessage" className="mb-2 block text-xs font-medium text-zinc-400">
											必须出现的关键信息（可选）
										</label>
										<input
											id="keyMessage"
											className="field-input"
											placeholder="例：品牌名 FIZZ 与新口味「白桃气泡」"
											value={keyMessage}
											onChange={(e) => setKeyMessage(e.target.value)}
										/>
									</div>
									<div>
										<div className="mb-2 text-xs font-medium text-zinc-400">参考素材</div>
										<ImageUploader value={images} onChange={setImageList} />
									</div>
									<OptionsForm options={options} onChange={(patch) => setOptions((o) => ({ ...o, ...patch }))} />
								</GlassPanel>
							</motion.div>
						)}
					</AnimatePresence>
				</section>

				<footer className="flex items-center justify-center gap-2 text-[11px] text-zinc-600">
					<Film className="size-3.5" />
					powered by pi-video-agent pipeline · LLM + generative media
					<Sparkles className="size-3.5" />
				</footer>
			</main>
		</div>
	);
}
