/**
 * BRIEF 阶段：需求简报 + 生成参数 + 参考图回看。
 */

import type { RunView } from "@/api/client";
import { StageShell } from "./shared";

function SpecRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
			<div className="text-[10px] text-zinc-500">{label}</div>
			<div className="mt-0.5 font-mono text-xs text-zinc-200">{value}</div>
		</div>
	);
}

export function BriefStage({ run }: { run: RunView }) {
	const o = run.options;
	return (
		<StageShell kicker="CREATIVE BRIEF" title="需求简报">
			<div className="space-y-5">
				<p className="text-base leading-relaxed text-zinc-100">{run.brief.logline}</p>
				{run.brief.keyMessage && (
					<div className="inline-block rounded-lg border border-cyan-300/30 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100">
						关键信息 · {run.brief.keyMessage}
					</div>
				)}

				{run.images.length > 0 && (
					<div>
						<div className="mb-2 text-xs text-zinc-500">参考素材（美术指导将以此锚定视觉）</div>
						<div className="flex flex-wrap gap-3">
							{run.images.map((img) => (
								<figure key={img.id} className="w-28">
									<img
										src={img.url}
										alt={img.name}
										className="aspect-square w-full rounded-xl border border-white/15 object-cover"
									/>
									<figcaption className="mt-1 truncate text-center text-[10px] text-zinc-600">{img.name}</figcaption>
								</figure>
							))}
						</div>
					</div>
				)}

				<div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
					<SpecRow label="分辨率" value={o.resolution} />
					<SpecRow label="画幅" value={o.aspectRatio} />
					<SpecRow label="叙事结构" value={`${o.shotCount} 镜 × ${o.clipDurationSec}s`} />
					<SpecRow label="帧率 / 运动" value={`${o.fps}fps · ${o.motionIntensity === "low" ? "舒缓" : o.motionIntensity === "medium" ? "自然" : "强烈"}`} />
					<SpecRow label="内容语言" value={o.promptLanguage === "zh" ? "中文" : "English"} />
					<SpecRow label="细节增强" value={o.detailBoost ? "开启" : "关闭"} />
					<SpecRow label="种子" value={o.seed !== undefined ? String(o.seed) : "随机"} />
					<SpecRow label="负向词" value={o.negativePrompt ? `${o.negativePrompt.length} 字` : "无"} />
				</div>
			</div>
		</StageShell>
	);
}
