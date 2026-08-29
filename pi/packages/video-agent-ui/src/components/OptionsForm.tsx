/**
 * 生成质量选项表单：分辨率 / 画幅 / 镜头数 / 单镜时长 / 帧率 /
 * 运动强度 / 内容语言 / 细节增强 / 种子 / 负向提示词。
 * 白名单与预设全部来自 @earendil-works/pi-video-agent，UI 不自造第二套。
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
	MAX_SHOTS,
	MIN_SHOTS,
	NEGATIVE_PROMPT_PRESETS,
	SHOT_COUNT_PRESETS,
	type AspectRatio,
	type ClipDurationSec,
	type Fps,
	type GenerationOptions,
	type MotionIntensity,
	type Resolution,
	type ShotCount,
} from "@earendil-works/pi-video-agent";
import { Segmented } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type PresetKey = keyof typeof NEGATIVE_PROMPT_PRESETS;

const PRESET_ORDER: readonly PresetKey[] = ["cleanProduct", "portrait", "stylized", "none"];

function detectPreset(value: string): PresetKey | "custom" {
	for (const key of PRESET_ORDER) {
		if (NEGATIVE_PROMPT_PRESETS[key].value === value) return key;
	}
	return "custom";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-2">
			<span className="text-xs font-medium text-zinc-400">{label}</span>
			{children}
		</div>
	);
}

export function OptionsForm({
	options,
	onChange,
}: {
	options: GenerationOptions;
	onChange: (patch: Partial<GenerationOptions>) => void;
}) {
	const [open, setOpen] = useState(false);
	const preset = detectPreset(options.negativePrompt);

	return (
		<div className="rounded-xl border border-white/10 bg-white/[0.03]">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
			>
				<span className="text-sm text-zinc-200">高级选项</span>
				<span className="flex items-center gap-2 text-xs text-zinc-500">
					{options.resolution} · {options.aspectRatio} · {options.shotCount} 镜 × {options.clipDurationSec}s ·{" "}
					{options.fps}fps
					<ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
				</span>
			</button>
			{open && (
				<div className="space-y-5 border-t border-white/10 px-4 py-4">
					<div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
						<Field label="分辨率">
							<Segmented<Resolution>
								value={options.resolution}
								onChange={(v) => onChange({ resolution: v })}
								options={[
									{ value: "480p", label: "480p" },
									{ value: "720p", label: "720p" },
									{ value: "1080p", label: "1080p" },
								]}
							/>
						</Field>
						<Field label="画幅">
							<Segmented<AspectRatio>
								value={options.aspectRatio}
								onChange={(v) => onChange({ aspectRatio: v })}
								options={[
									{ value: "16:9", label: "16:9" },
									{ value: "9:16", label: "9:16" },
									{ value: "1:1", label: "1:1" },
									{ value: "4:3", label: "4:3" },
								]}
							/>
						</Field>
						<Field label="镜头数">
							<div className="flex flex-wrap items-center gap-2">
								<Segmented<ShotCount>
									value={options.shotCount}
									onChange={(v) => onChange({ shotCount: v })}
									options={SHOT_COUNT_PRESETS.map((n) => ({ value: n, label: `${n} 镜` }))}
								/>
								{/* 自定义入口：高级选项里允许自由填 3..30，让长片 / 转场多的片子可起拍。 */}
								<div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
									<span>自定义</span>
									<input
										type="number"
										min={MIN_SHOTS}
										max={MAX_SHOTS}
										step={1}
										inputMode="numeric"
										className="field-input !w-20 !py-1 !text-xs"
										value={
											SHOT_COUNT_PRESETS.includes(options.shotCount)
												? ""
												: options.shotCount
										}
										placeholder={`${MIN_SHOTS}-${MAX_SHOTS}`}
										title={`分镜数范围 ${MIN_SHOTS}..${MAX_SHOTS}`}
										onChange={(e) => {
											const raw = e.target.value.trim();
											if (raw === "") return; // 输入框为空不覆盖当前选中预设
											const n = Number.parseInt(raw, 10);
											if (Number.isInteger(n) && n >= MIN_SHOTS && n <= MAX_SHOTS) {
												onChange({ shotCount: n });
											}
										}}
									/>
								</div>
							</div>
							{/* 当前选中超出预设时给一行提示，避免用户误以为没生效 */}
							{!SHOT_COUNT_PRESETS.includes(options.shotCount) && (
								<p className="text-[10px] text-amber-200/80">
									当前 {options.shotCount} 镜（自定义），可用范围 {MIN_SHOTS}–{MAX_SHOTS}
								</p>
							)}
						</Field>
						<Field label="单镜时长">
							<Segmented<ClipDurationSec>
								value={options.clipDurationSec}
								onChange={(v) => onChange({ clipDurationSec: v })}
								options={[3, 5, 8, 10].map((n) => ({ value: n as ClipDurationSec, label: `${n}s` }))}
							/>
						</Field>
						<Field label="帧率">
							<Segmented<Fps>
								value={options.fps}
								onChange={(v) => onChange({ fps: v })}
								options={[24, 30, 60].map((n) => ({ value: n as Fps, label: `${n}` }))}
							/>
						</Field>
						<Field label="运动强度">
							<Segmented<MotionIntensity>
								value={options.motionIntensity}
								onChange={(v) => onChange({ motionIntensity: v })}
								options={[
									{ value: "low", label: "舒缓" },
									{ value: "medium", label: "自然" },
									{ value: "high", label: "强烈" },
								]}
							/>
						</Field>
						<Field label="音频驱动">
							<Segmented<"off" | "dialogue">
								value={options.audioDrive ?? "off"}
								onChange={(v) => onChange({ audioDrive: v })}
								options={[
									{ value: "off", label: "关闭" },
									{ value: "dialogue", label: "台词驱动口型" },
								]}
							/>
							{(options.audioDrive ?? "off") === "dialogue" && (
								<p className="text-[10px] leading-relaxed text-amber-200/80">
									台词镜先录台词（角色音色）再以参考音频生成口型；台词超长自动精简重录一次，镜长按音频反推（4–12s）。仅共创来源可用。
								</p>
							)}
						</Field>
						<Field label="内容语言">
							<Segmented<"zh" | "en">
								value={options.promptLanguage}
								onChange={(v) => onChange({ promptLanguage: v })}
								options={[
									{ value: "zh", label: "中文" },
									{ value: "en", label: "English" },
								]}
							/>
						</Field>
						<Field label="细节增强">
							<button
								type="button"
								role="switch"
								aria-checked={options.detailBoost}
								onClick={() => onChange({ detailBoost: !options.detailBoost })}
								className={cn(
									"relative h-8 w-14 cursor-pointer rounded-full border transition-colors",
									options.detailBoost ? "border-cyan-300/50 bg-cyan-400/25" : "border-white/15 bg-white/[0.05]",
								)}
							>
								<span
									className={cn(
										"absolute top-1/2 size-6 -translate-y-1/2 rounded-full bg-zinc-200 shadow transition-all",
										options.detailBoost ? "left-7 shadow-[0_0_10px_rgba(34,211,238,0.6)]" : "left-1",
									)}
								/>
							</button>
						</Field>
						<Field label="种子（留空随机）">
							<input
								className="field-input"
								type="number"
								min={0}
								step={1}
								inputMode="numeric"
								value={options.seed ?? ""}
								placeholder="——"
								onChange={(e) => {
									const raw = e.target.value.trim();
									if (raw === "") {
										onChange({ seed: undefined });
										return;
									}
									const n = Number.parseInt(raw, 10);
									if (Number.isInteger(n) && n >= 0) onChange({ seed: n });
								}}
							/>
						</Field>
					</div>

					<Field label="负向词预设">
						<select
							className="field-input cursor-pointer"
							value={preset}
							onChange={(e) => {
								const key = e.target.value;
								if (key === "custom") return;
								onChange({ negativePrompt: NEGATIVE_PROMPT_PRESETS[key as PresetKey].value });
							}}
						>
							{PRESET_ORDER.map((key) => (
								<option key={key} value={key} className="bg-zinc-900">
									{NEGATIVE_PROMPT_PRESETS[key].label.zh}
								</option>
							))}
							<option value="custom" className="bg-zinc-900">
								自定义
							</option>
						</select>
					</Field>

					<Field label="负向提示词">
						<textarea
							className="field-input resize-y"
							rows={3}
							value={options.negativePrompt}
							onChange={(e) => onChange({ negativePrompt: e.target.value })}
						/>
					</Field>
				</div>
			)}
		</div>
	);
}
