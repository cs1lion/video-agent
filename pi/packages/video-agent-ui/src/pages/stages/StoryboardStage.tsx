/**
 * PROMPTS 阶段：分镜提示词表 —— 每镜的英文生成提示词，
 * 若剧本已就绪则并排展示该镜旁白，方便对照审读。支持微调（stageId=prompts）。
 */

import type { ScriptDoc, ShotPromptDoc, StageId } from "@/api/client";
import { EmptyState, RefineAction, StageShell } from "./shared";

export function StoryboardStage({
	prompts,
	script,
	onRefine,
}: {
	prompts: ShotPromptDoc | null;
	script: ScriptDoc | null;
	onRefine?: (stageId: StageId) => void;
}) {
	const narrationOf = (shotId: string): string | undefined =>
		script?.shots.find((s) => s.id === shotId)?.narrationZh;

	return (
		<StageShell
			kicker="STAGE 03 · STORYBOARD"
			title="分镜提示词"
			action={<RefineAction stageId="prompts" onRefine={onRefine} />}
		>
			{!prompts || prompts.prompts.length === 0 ? (
				<EmptyState text="分镜师正在把剧本翻译成一格格画面指令…" />
			) : (
				<div className="space-y-3">
					{prompts.prompts.map((p) => {
						const narration = narrationOf(p.shotId);
						return (
							<div key={p.shotId} className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
								<div className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
									<span className="font-mono text-sm font-semibold text-cyan-300">{p.shotId}</span>
									{narration && <span className="truncate text-xs text-zinc-500">旁白 · {narration}</span>}
								</div>
								<p className="px-4 py-3 font-mono text-xs leading-relaxed text-zinc-300">{p.prompt}</p>
							</div>
						);
					})}
				</div>
			)}
		</StageShell>
	);
}
