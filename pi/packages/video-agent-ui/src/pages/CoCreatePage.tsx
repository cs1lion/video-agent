/**
 * 共创工作室：为想深度参与设计的用户准备。
 * 左：与「创意合伙人」的创意对话；右：共创空间 —— 沉淀人物形象、场景描述、
 * 创意情节与音乐简报（可手编、可从对话一键提炼），随后带设定进入正常管线。
 */

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
	ArrowLeft,
	ArrowRight,
	Clapperboard,
	LoaderCircle,
	Package,
	ScrollText,
	Sparkles,
	Trash2,
	UserRound,
	WandSparkles,
} from "lucide-react";
import { DEFAULT_GENERATION_OPTIONS, type GenerationOptions } from "@earendil-works/pi-video-agent";
import { api, type CoCharacter, type CoSpaceDraft, type CostEstimateView, type UploadedImage } from "@/api/client";
import { ImageUploader } from "@/components/ImageUploader";
import { OptionsForm } from "@/components/OptionsForm";
import { Backdrop } from "@/components/fx/Backdrop";
import { GlowButton, SectionTitle } from "@/components/ui/primitives";

type ChatMessage = { role: "user" | "assistant"; content: string };

/** 首页「进入共创工作室」带入的创作基底 */
interface IncomingState {
	brief?: { logline: string; keyMessage?: string };
	options?: GenerationOptions;
	images?: UploadedImage[];
}

const OPENING: ChatMessage = {
	role: "assistant",
	content:
		"我是你的创意合伙人。说说你想拍什么——产品、人群、想要的感觉都行；我会帮你把想法磨成能开拍的设定，聊出的人物和场景都会存进右侧的共创空间。",
};

const PROMPT_HINTS = [
	"帮我想 3 个有反差感的开场",
	"给主角设计一个视觉记忆点",
	"这个卖点用画面怎么演？",
	"推荐两个适合的场景",
];

function ItemList<T extends { name: string; description: string }>({
	items,
	onChange,
	namePlaceholder,
	descPlaceholder,
	extraRow,
}: {
	items: T[];
	onChange: (items: T[]) => void;
	namePlaceholder: string;
	descPlaceholder: string;
	/** A7：条目附加行（角色卡的台词音色下拉）；update 打补丁回写该条 */
	extraRow?: (item: T, update: (patch: Partial<T>) => void) => React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			{items.map((item, i) => (
				<div key={i} className="group rounded-xl border border-white/10 bg-white/[0.03] p-2.5 transition-colors hover:border-white/20">
					<div className="flex items-center gap-2">
						<input
							value={item.name}
							placeholder={namePlaceholder}
							maxLength={40}
							className="field-input !border-transparent !bg-transparent !px-1 !py-0.5 !text-xs font-medium"
							onChange={(e) => onChange(items.map((it, j) => (j === i ? { ...it, name: e.target.value } : it)))}
						/>
						<button
							type="button"
							onClick={() => onChange(items.filter((_, j) => j !== i))}
							className="cursor-pointer rounded-md p-1 text-zinc-600 opacity-0 transition-opacity hover:bg-rose-400/10 hover:text-rose-300 group-hover:opacity-100"
							aria-label="删除"
						>
							<Trash2 className="size-3.5" />
						</button>
					</div>
					<textarea
						value={item.description}
						placeholder={descPlaceholder}
						rows={2}
						maxLength={600}
						className="field-input mt-1 resize-y !px-1 !py-0.5 !text-xs"
						onChange={(e) => onChange(items.map((it, j) => (j === i ? { ...it, description: e.target.value } : it)))}
					/>
					{extraRow?.(item, (patch) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it))))}
				</div>
			))}
			<button
				type="button"
				onClick={() => onChange([...items, { name: "", description: "" } as T])}
				className="w-full cursor-pointer rounded-xl border border-dashed border-white/15 py-2 text-xs text-zinc-500 transition-colors hover:border-cyan-300/40 hover:text-cyan-200"
			>
				+ 添加一条
			</button>
		</div>
	);
}

export function CoCreatePage() {
	const navigate = useNavigate();
	const location = useLocation();
	const incoming = (location.state ?? null) as IncomingState | null;
	const [messages, setMessages] = useState<ChatMessage[]>([OPENING]);
	const [input, setInput] = useState("");
	const [chatBusy, setChatBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [logline, setLogline] = useState(incoming?.brief?.logline ?? "");
	const [keyMessage, setKeyMessage] = useState(incoming?.brief?.keyMessage ?? "");
	const [images, setImages] = useState<UploadedImage[]>(incoming?.images ?? []);
	const [space, setSpace] = useState<CoSpaceDraft>({ characters: [], scenes: [], ideas: [] });
	const [extracting, setExtracting] = useState(false);
	const [launching, setLaunching] = useState(false);
	const [options, setOptions] = useState<GenerationOptions>(incoming?.options ?? { ...DEFAULT_GENERATION_OPTIONS });
	/** P2：启动前预估成本。依赖 space + options，共创调整后实时变。 */
	const [estimate, setEstimate] = useState<CostEstimateView | null>(null);
	/** A7：TTS 音色表（角色卡台词音色绑定；拉取失败静默隐藏下拉） */
	const [voices, setVoices] = useState<Record<string, string> | null>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		api.fetchVoices().then(setVoices).catch(() => setVoices(null));
	}, []);

	// P2：参数/共创空间变化时拉预估（debounce 200ms）
	useEffect(() => {
		let alive = true;
		const timer = setTimeout(() => {
			api
				.estimateCost(options, space)
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
	}, [options, space]);

	/** 创作基底 → 合伙人对话的上下文（服务端并入 system prompt，建议主动贴合） */
	const briefContext = (() => {
		const parts: string[] = [];
		if (logline.trim()) parts.push(`一句话创意：「${logline.trim()}」`);
		if (keyMessage.trim()) parts.push(`关键信息：「${keyMessage.trim()}」`);
		parts.push(`生成选项：${options.resolution} / ${options.aspectRatio} / 单镜约 ${options.clipDurationSec}s`);
		if (options.audioDrive === "dialogue") parts.push("已开台词驱动口型：建议角色台词每镜一句、多角色对白拆镜");
		if (images.length > 0) parts.push(`参考图 ${images.length} 张（${images.map((i) => i.name).join("、")}）`);
		return parts.length > 0 ? `用户从首页带入了创作基底——${parts.join("；")}。请主动贴合这些信息给建议。` : null;
	})();

	async function send(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed || chatBusy) return;
		const next = [...messages, { role: "user" as const, content: trimmed }];
		setMessages(next);
		setInput("");
		setChatBusy(true);
		setError(null);
		try {
			const reply = await api.cocreateChat(next.map((m) => ({ role: m.role, content: m.content })), briefContext ?? undefined);
			setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
			requestAnimationFrame(() => listRef.current?.scrollTo({ top: 999999, behavior: "smooth" }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setChatBusy(false);
		}
	}

	async function extract(): Promise<void> {
		const transcript = messages.map((m) => `${m.role === "user" ? "我" : "合伙人"}：${m.content}`).join("\n");
		setExtracting(true);
		setError(null);
		try {
			const found = await api.cocreateExtract(transcript);
			if (!found) return;
			setSpace((prev) => {
				const characters = [...prev.characters];
				for (const c of found.characters) {
					if (!characters.some((x) => x.name === c.name)) characters.push(c);
				}
				const scenes = [...prev.scenes];
				for (const s of found.scenes) {
					if (!scenes.some((x) => x.name === s.name)) scenes.push(s);
				}
				const ideas = [...new Set([...prev.ideas, ...found.ideas])];
				return { characters, scenes, ideas, musicBrief: prev.musicBrief || found.musicBrief };
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setExtracting(false);
		}
	}

	async function launch(): Promise<void> {
		setLaunching(true);
		setError(null);
		try {
			const { runId } = await api.generate(
				{ logline: logline.trim(), ...(keyMessage.trim() ? { keyMessage: keyMessage.trim() } : {}) },
				options,
				images.map((i) => i.id),
				space,
			);
			navigate(`/studio/${encodeURIComponent(runId)}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setLaunching(false);
		}
	}

	const canLaunch = logline.trim().length > 0 && !launching;
	const assetCount = space.characters.length + space.scenes.length + space.ideas.length;

	return (
		<div className="relative min-h-dvh overflow-x-hidden text-zinc-200">
			<Backdrop />
			<main className="relative z-10 mx-auto w-full max-w-7xl px-5 py-8">
				<header className="mb-6 flex items-center gap-3">
					<button
						type="button"
						onClick={() => navigate("/")}
						className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
					>
						<ArrowLeft className="size-3.5" />
						返回首页
					</button>
					<h1 className="text-lg font-semibold text-zinc-100">共创工作室</h1>
					<span className="rounded-full border border-violet-300/40 bg-violet-400/10 px-2.5 py-0.5 text-[11px] text-violet-200">
						CO-CREATION
					</span>
				</header>

				{error && (
					<div className="mb-4 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</div>
				)}

				{incoming?.brief && (
					<div className="mb-4 rounded-xl border border-cyan-300/25 bg-cyan-400/[0.05] px-4 py-2.5">
						<div className="flex flex-wrap items-center gap-2">
							<span className="rounded-full border border-cyan-300/40 bg-cyan-400/10 px-2 py-0.5 text-[10px] text-cyan-200">
								已从首页带入
							</span>
							<span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
								{incoming.brief.logline}
								{incoming.brief.keyMessage ? ` · 关键信息：${incoming.brief.keyMessage}` : ""}
							</span>
							<span className="text-[10px] text-zinc-600">参考图可增删，合伙人会贴合这些信息给建议</span>
						</div>
						{images.length > 0 && (
							<div className="mt-2.5">
								<ImageUploader value={images} onChange={setImages} />
							</div>
						)}
					</div>
				)}

				<div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
					{/* 创意对话 */}
					<motion.section
						initial={{ opacity: 0, y: 14 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						className="glass flex min-h-[62vh] flex-col rounded-2xl p-5"
					>
						<SectionTitle kicker="CREATIVE PARTNER" title="创意对话" />
						<div ref={listRef} className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ maxHeight: "48vh" }}>
							{messages.map((m, i) => (
								<div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
									<div
										className={
											m.role === "user"
												? "max-w-[80%] rounded-2xl rounded-br-md border border-cyan-300/30 bg-cyan-400/10 px-4 py-2.5 text-sm leading-relaxed text-cyan-50"
												: "max-w-[85%] rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm leading-relaxed text-zinc-200"
										}
									>
										{m.content}
									</div>
								</div>
							))}
							{chatBusy && (
								<div className="flex justify-start">
									<div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-zinc-500">
										<LoaderCircle className="size-3.5 animate-spin" />
										合伙人正在想…
									</div>
								</div>
							)}
						</div>
						<div className="mt-4 flex flex-wrap gap-1.5">
							{PROMPT_HINTS.map((h) => (
								<button
									key={h}
									type="button"
									disabled={chatBusy}
									onClick={() => void send(h)}
									className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:border-violet-300/40 hover:text-violet-200 disabled:opacity-40"
								>
									{h}
								</button>
							))}
						</div>
						<div className="mt-3 flex items-end gap-2">
							<textarea
								value={input}
								rows={2}
								maxLength={1200}
								placeholder="描述想法、追问建议、或让合伙人帮你完善某个设定…（Ctrl+Enter 发送）"
								className="field-input flex-1 resize-y"
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && input.trim() && !chatBusy) void send(input);
								}}
							/>
							<GlowButton onClick={() => void send(input)} disabled={!input.trim() || chatBusy}>
								<ArrowRight className="size-4" />
								发送
							</GlowButton>
						</div>
					</motion.section>

					{/* 共创空间 */}
					<motion.aside
						initial={{ opacity: 0, y: 14 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4, delay: 0.08 }}
						className="glass rounded-2xl p-5"
					>
						<SectionTitle
							kicker={`CO-CREATION SPACE · ${assetCount} 条资产`}
							title="共创空间"
							right={
								<button
									type="button"
									onClick={() => void extract()}
									disabled={extracting || messages.length < 2}
									className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-violet-400/40 px-3 py-1.5 text-xs text-violet-200 transition-colors hover:bg-violet-400/10 disabled:cursor-not-allowed disabled:opacity-40"
								>
									{extracting ? <LoaderCircle className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
									从对话提炼
								</button>
							}
						/>
						<div className="max-h-[52vh] space-y-4 overflow-y-auto pr-1">
							<section>
								<div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
									<UserRound className="size-3.5 text-cyan-300/80" />
									人物形象 <span className="text-zinc-600">外貌 / 性格 / 与产品的关系</span>
								</div>
								<ItemList<CoCharacter>
									items={space.characters}
									onChange={(characters) => setSpace((s) => ({ ...s, characters }))}
									namePlaceholder="例：加班的年轻上班族小林"
									descPlaceholder="一句中文：外貌特征 + 性格气质 + 与产品的关系"
									extraRow={(item, update) =>
										options.audioDrive === "dialogue" && voices && Object.keys(voices).length > 0 ? (
											<select
												value={item.voiceId ?? ""}
												onChange={(e) => update({ voiceId: e.target.value || undefined })}
												className="field-input mt-1 !py-1 !text-[11px]"
												aria-label="台词音色"
											>
												<option value="">台词音色：默认</option>
												{Object.entries(voices).map(([label, id]) => (
													<option key={id} value={id}>
														{label}
													</option>
												))}
											</select>
										) : null
									}
								/>
							</section>
							<section>
								<div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
									<Package className="size-3.5 text-cyan-300/80" />
									场景描述 <span className="text-zinc-600">空间氛围与关键陈设</span>
								</div>
								<ItemList
									items={space.scenes}
									onChange={(scenes) => setSpace((s) => ({ ...s, scenes }))}
									namePlaceholder="例：深夜写字楼工位"
									descPlaceholder="一句中文：时间光线 + 空间氛围 + 关键陈设"
								/>
							</section>
							<section>
								<div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
									<ScrollText className="size-3.5 text-cyan-300/80" />
									创意情节 <span className="text-zinc-600">已认可的节拍 / 卖点演绎</span>
								</div>
								<ItemList
									items={space.ideas.map((i) => ({ name: "", description: i }))}
									onChange={(items) =>
										setSpace((s) => ({
											...s,
											ideas: items.map((i) => i.description).filter((d) => d.trim()),
										}))
									}
									namePlaceholder=""
									descPlaceholder="一条情节 / 节拍 / 卖点演绎方式"
								/>
							</section>
							<section>
								<div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
									<Sparkles className="size-3.5 text-amber-300/80" />
									背景音乐简报 <span className="text-zinc-600">风格 / 乐器 / 节奏意图</span>
								</div>
								<textarea
									value={space.musicBrief ?? ""}
									rows={2}
									maxLength={300}
									placeholder="例：轻快的夏日流行放克，贝斯驱动，副歌加入拍手声；结尾渐弱收在冰块声上"
									className="field-input !text-xs"
									onChange={(e) => setSpace((s) => ({ ...s, musicBrief: e.target.value }))}
								/>
								<p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
									音乐生成模型尚未接入：简报会随项目落盘并在交付说明中呈现，接入后可直接按此生成底床。
								</p>
							</section>
						</div>

						<hr className="my-4 border-white/10" />

						<div className="space-y-3">
							<div>
								<label htmlFor="cocreate-logline" className="mb-1.5 block text-xs font-medium text-zinc-400">
									一句定调（进管线的叙事起点）*
								</label>
								<input
									id="cocreate-logline"
									className="field-input"
									placeholder="把共创讨论收敛成一句话，例：深夜办公室里，小林靠一口冰红茶回血翻盘"
									value={logline}
									maxLength={120}
									onChange={(e) => setLogline(e.target.value)}
								/>
							</div>
							<div>
								<label htmlFor="cocreate-keymessage" className="mb-1.5 block text-xs font-medium text-zinc-400">
									关键信息（可选）
								</label>
								<input
									id="cocreate-keymessage"
									className="field-input"
									placeholder="例：品牌名 FIZZ 与新口味「白桃气泡」"
									value={keyMessage}
									maxLength={120}
									onChange={(e) => setKeyMessage(e.target.value)}
								/>
							</div>
							<OptionsForm options={options} onChange={(patch) => setOptions((o) => ({ ...o, ...patch }))} />
							{/* P2：启动前预估成本（共创空间里有实体则加点 redo 缓冲） */}
							{estimate && (
								<div
									className="rounded-xl border border-amber-300/20 bg-amber-400/[0.05] px-4 py-3"
									title={estimate.lines.map((l) => `${l.label}: ${estimate.currency === "CNY" ? "¥" : "$"}${l.amount.toFixed(2)}`).join("\n")}
								>
									<div className="flex items-center justify-between gap-2">
										<span className="text-xs font-medium text-amber-200">本次预估</span>
										<span className="font-mono text-base text-amber-100">
											{estimate.currency === "CNY" ? "¥" : "$"}
											{estimate.total.toFixed(2)}
										</span>
									</div>
									<div className="mt-1 text-[10px] leading-relaxed text-zinc-500">
										{estimate.lines
											.filter((l) => (options.audioDrive === "dialogue" ? true : l.label !== "台词重录缓冲"))
											.slice(0, 5)
											.map((l) => `${l.label} ${estimate.currency === "CNY" ? "¥" : "$"}${l.amount.toFixed(2)}`)
											.join(" · ")}
									</div>
									<p className="mt-1 text-[10px] text-zinc-600">
										{`含共创 ${space.characters.length + space.scenes.length} 项资产迭代`}
										{options.audioDrive === "dialogue" && " · 台词镜：台词先录、口型后生成，超长自动精简重录（已含重录缓冲）"}
									</p>
								</div>
							)}
							<GlowButton className="w-full" onClick={() => void launch()} disabled={!canLaunch}>
								{launching ? <LoaderCircle className="size-4 animate-spin" /> : <Clapperboard className="size-4" />}
								带着共创设定启动制作
							</GlowButton>
							<p className="text-[11px] leading-relaxed text-zinc-600">
								人物与场景将直接作为美术设计的推导基准，全阶段 prompt 注入共创设定；镜头数与单镜时长可在上方调大，做更长的成片。
							</p>
						</div>
					</motion.aside>
				</div>
			</main>
		</div>
	);
}
