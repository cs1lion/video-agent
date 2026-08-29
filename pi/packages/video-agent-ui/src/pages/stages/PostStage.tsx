/**
 * AUDIO 阶段：声音设计 —— 逐镜配音试听 + 旁白重录（语音级重做）+ BGM 管理 + 重新导出。
 */

import { useEffect, useRef, useState } from "react";
import { AudioLines, LoaderCircle, Mic, Music, RotateCcw, Trash2, Upload } from "lucide-react";
import type { AssetFile, BgmInfo, RunView, ScriptDoc } from "@/api/client";
import { api } from "@/api/client";
import { GlowButton } from "@/components/ui/primitives";
import { RettsModal } from "@/components/RettsModal";
import { cn } from "@/lib/utils";
import { EmptyState, StageShell } from "./shared";

/** BGM 面板：上传（≤15MB 音频）/ 试听 / 删除；变更后需「重新导出」生效 */
function BgmPanel({ run }: { run: RunView }) {
	const [bgm, setBgm] = useState<BgmInfo | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const load = async () => {
		try {
			setBgm(await api.fetchBgm(run.id));
		} catch {
			setBgm(null);
		}
	};
	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [run.id]);

	const pick = async (file: File | undefined) => {
		if (!file || busy) return;
		if (file.size > 15 * 1024 * 1024) {
			setError("音频需在 15MB 以内");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(new Error("读取文件失败"));
				reader.readAsDataURL(file);
			});
			const info = await api.uploadBgm(run.id, file.name, dataUrl);
			setBgm(info);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	const remove = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await api.deleteBgm(run.id);
			setBgm(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
			<div className="mb-3 flex items-center gap-2">
				<Music className="size-4 text-cyan-300" />
				<span className="text-sm font-medium text-zinc-200">背景音乐（BGM）</span>
				<span className="ml-auto text-[10px] text-zinc-600">循环铺底 · 旁白自动闪避</span>
			</div>

			{bgm ? (
				<div className="space-y-3">
					<audio src={bgm.url} controls preload="metadata" className="w-full" />
					<div className="flex items-center gap-3">
						<span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{bgm.name}</span>
						<input
							ref={fileRef}
							type="file"
							accept="audio/*"
							className="hidden"
							onChange={(e) => void pick(e.target.files?.[0])}
						/>
						<GlowButton variant="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
							{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
							更换
						</GlowButton>
						<GlowButton variant="danger" disabled={busy} onClick={() => void remove()}>
							<Trash2 className="size-4" />
							移除
						</GlowButton>
					</div>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-3">
					<input
						ref={fileRef}
						type="file"
						accept="audio/*"
						className="hidden"
						onChange={(e) => void pick(e.target.files?.[0])}
					/>
					<GlowButton variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
						{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
						上传 BGM
					</GlowButton>
					<span className="text-[11px] text-zinc-600">MP3 / WAV / M4A / OGG / FLAC，≤15MB</span>
				</div>
			)}
			{error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}
		</div>
	);
}

export function PostStage({
	run,
	assets,
	script,
	onRetts,
	rettsBusy,
}: {
	run: RunView;
	assets: AssetFile[];
	script: ScriptDoc | null;
	/** 发起旁白重录（由 StudioPage 接 store.retts） */
	onRetts: (shotId: string, instruction: string) => void;
	rettsBusy: boolean;
}) {
	const tts = assets.filter((a) => a.type === "audio" && a.name.startsWith("tts-"));
	const subs = assets.find((a) => a.name === "subs.ass");

	const audioDone = run.stages.find((s) => s.id === "audio")?.status === "done";
	const canReexport = audioDone && run.status !== "running";
	const [exporting, setExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	const [rettsTarget, setRettsTarget] = useState<string | null>(null);

	const reexport = async () => {
		if (!canReexport || exporting) return;
		setExporting(true);
		setExportError(null);
		try {
			await api.reexport(run.id);
		} catch (e) {
			setExportError(e instanceof Error ? e.message : String(e));
		} finally {
			setExporting(false);
		}
	};

	const redoingShot = run.redoActive?.kind === "retts" ? run.redoActive.shotId : undefined;
	const rettsShotInfo = rettsTarget ? script?.shots.find((s) => s.id === rettsTarget) : undefined;
	const rettsShot = rettsTarget
		? {
				id: rettsTarget,
				narration: rettsShotInfo?.narrationZh,
				dialogue:
					rettsShotInfo?.audioMode === "dialogue" && rettsShotInfo.dialogue
						? { characterId: rettsShotInfo.dialogue.characterId, lines: rettsShotInfo.dialogue.lines }
						: null,
				durationSec: rettsShotInfo?.durationSec,
			}
		: null;
	/** A7：台词镜（audio 阶段不产 tts 产物，音轨在成片/口型里——单独区块展示） */
	const dialogueShots = (script?.shots ?? []).filter((s) => s.audioMode === "dialogue" && s.dialogue);

	return (
		<StageShell kicker="STAGE 05 · SOUND" title="声音设计">
			{tts.length === 0 ? (
				<EmptyState text="声音设计正在为每个镜头录制旁白…" />
			) : (
				<div className="space-y-3">
					<div className="grid gap-3 sm:grid-cols-2">
						{tts.map((a) => {
							const shot = script?.shots.find((s) => `tts-${s.id}.mp3` === a.name);
							const attempts = shot ? (run.ttsAttempts[shot.id] ?? 0) : 0;
							const versions = shot ? (run.ttsVersions[shot.id] ?? []) : [];
							const redoing = shot?.id != null && redoingShot === shot.id;
							return (
								<div
									key={a.name}
									id={shot ? `art-${shot.id}` : undefined}
									className={cn(
										"relative overflow-hidden rounded-xl border bg-white/[0.03] p-3 transition-colors",
										redoing
											? "border-amber-300/50 bg-amber-400/[0.07] shadow-[0_0_28px_rgba(251,191,36,0.15)]"
											: "border-white/10",
									)}
								>
									{redoing && (
										<span className="redo-bar absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-amber-300 to-transparent" />
									)}
									<div className="mb-2 flex items-center justify-between gap-2">
										<span className="font-mono text-xs text-cyan-300">{shot?.id ?? a.name}</span>
										<div className="flex min-w-0 items-center gap-2">
											{versions.length > 0 && (
												<span
													title={`历史版本：${versions.join("、")}`}
													className="shrink-0 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-px font-mono text-[9px] text-amber-200"
												>
													v{versions.length + 1}
												</span>
											)}
											{shot && <span className="max-w-[60%] truncate text-[11px] text-zinc-500">{shot.narrationZh}</span>}
										</div>
									</div>
									<audio src={a.url} controls preload="metadata" className="w-full" />
									{shot && (
										<div className="mt-2 flex items-center justify-between gap-2">
											{redoing ? (
												<span className="flex items-center gap-1.5 text-[11px] text-amber-200">
													<LoaderCircle className="size-3 animate-spin" />
													旁白重录中 · 新语音就位后该镜重排
												</span>
											) : (
												<span className="text-[10px] text-zinc-600">
													{attempts > 0 ? `已重录 ${attempts} 次` : "对语气/文案不满意？"}
												</span>
											)}
											<button
												type="button"
												disabled={run.status === "running" || rettsBusy}
												onClick={() => setRettsTarget(shot.id)}
												className={cn(
													"inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
													attempts > 0
														? "border-amber-300/40 text-amber-200 hover:bg-amber-400/10"
														: "border-white/15 text-zinc-300 hover:border-amber-300/40 hover:bg-amber-400/10 hover:text-amber-200",
												)}
											>
												<AudioLines className="size-3" />
												重录旁白
											</button>
										</div>
									)}
								</div>
							);
						})}
					</div>
					{/* A7：台词镜区块——口型由台词音频驱动，音轨直接烧在口型画面里 */}
					{dialogueShots.length > 0 && (
						<div className="space-y-3">
							<div className="flex items-center gap-2 pt-1">
								<Mic className="size-4 text-violet-300" />
								<span className="text-sm font-medium text-zinc-200">台词镜（口型驱动）</span>
								<span className="text-[10px] text-zinc-600">音频已烧入画面 · 重录台词将级联重生成该镜画面</span>
							</div>
							<div className="grid gap-3 sm:grid-cols-2">
								{dialogueShots.map((shot) => {
									const d = shot.dialogue!;
									const redoing = redoingShot === shot.id;
									return (
										<div
											key={shot.id}
											className={cn(
												"relative overflow-hidden rounded-xl border bg-white/[0.03] p-3 transition-colors",
												redoing ? "border-violet-300/50 bg-violet-400/[0.07]" : "border-violet-300/20",
											)}
										>
											<div className="mb-2 flex items-center gap-2">
												<span className="font-mono text-xs text-violet-300">{shot.id}</span>
												<span className="rounded-full border border-violet-300/30 bg-violet-400/10 px-1.5 py-px text-[9px] text-violet-200">
													口型驱动 · {d.characterId}
												</span>
												{typeof d.audioDurationSec === "number" && (
													<span className="font-mono text-[9px] text-zinc-600">{d.audioDurationSec.toFixed(1)}s</span>
												)}
												<span className="ml-auto text-[11px] text-zinc-500">{shot.durationSec}s</span>
											</div>
											<p className="mb-2 truncate text-[11px] text-zinc-400">
												<span className="mr-1 text-violet-300/80">{d.characterId}：</span>
												{d.lines.zh}
											</p>
											{d.audioUrl ? (
												<audio src={d.audioUrl} controls preload="metadata" className="w-full" />
											) : (
												<p className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[10px] text-zinc-600">
													台词音频尚未就绪（运行中或托管不可用已降旁白）
												</p>
											)}
											<div className="mt-2 flex items-center justify-between gap-2">
												{redoing ? (
													<span className="flex items-center gap-1.5 text-[11px] text-violet-200">
														<LoaderCircle className="size-3 animate-spin" />
														台词重录中 · 口型画面将重新生成
													</span>
												) : (
													<span className="text-[10px] text-zinc-600">
														{(run.ttsAttempts[shot.id] ?? 0) > 0 ? `已重录 ${run.ttsAttempts[shot.id]} 次` : "对台词/口型不满意？"}
													</span>
												)}
												<button
													type="button"
													disabled={run.status === "running" || rettsBusy}
													onClick={() => setRettsTarget(shot.id)}
													className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-violet-300/30 px-2.5 py-1 text-[11px] text-violet-200 transition-colors hover:bg-violet-400/10 disabled:cursor-not-allowed disabled:opacity-40"
												>
													<AudioLines className="size-3" />
													重录台词
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}
					{subs && (
						<a
							href={subs.url}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-2 text-xs text-cyan-300 hover:underline"
						>
							字幕文件 · {subs.name}
						</a>
					)}

					{/* BGM 管理 + 重新导出 */}
					<div className="space-y-3 pt-2">
						<BgmPanel run={run} />
						<div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3">
							<div className="min-w-0 flex-1 text-[11px] text-amber-100/80">
								上传/更换 BGM 或重录旁白后需重新合成：剪辑师将按现有镜头与配音重跑转场决策、混音（BGM 铺底 + 旁白闪避）与质检。
							</div>
							<GlowButton
								onClick={() => void reexport()}
								disabled={!canReexport || exporting}
								className={cn(exporting && "opacity-70")}
							>
								{exporting || (run.status === "running" && audioDone) ? (
									<LoaderCircle className="size-4 animate-spin" />
								) : (
									<RotateCcw className="size-4" />
								)}
								重新导出成片
							</GlowButton>
						</div>
						{exportError && <p className="text-[11px] text-rose-300">{exportError}</p>}
					</div>
				</div>
			)}

			{/* 重录弹窗（旁白 / 台词双分支） */}
			<RettsModal
				shot={rettsShot}
				attempts={rettsTarget ? (run.ttsAttempts[rettsTarget] ?? 0) : 0}
				narration={rettsShot?.narration}
				dialogue={rettsShot?.dialogue}
				durationSec={rettsShot?.durationSec}
				busy={rettsBusy}
				onClose={() => setRettsTarget(null)}
				onSubmit={(shotId, instruction) => {
					setRettsTarget(null);
					onRetts(shotId, instruction);
				}}
			/>
		</StageShell>
	);
}
