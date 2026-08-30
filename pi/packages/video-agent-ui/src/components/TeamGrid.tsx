/**
 * 制作团队：9 个 Agent 角色身份卡（与后端 pipeline ROLE_LABEL 对齐）。
 * 这是与「单 prompt 出视频」产品的差异化卖点，首页独立成区。
 */

import { motion } from "framer-motion";
import {
	ClipboardList,
	Clapperboard,
	Film,
	Megaphone,
	Palette,
	PenLine,
	Scissors,
	ShieldCheck,
	Video,
	Volume2,
} from "lucide-react";
import type { RoleId } from "@/api/client";

interface RoleCard {
	id: RoleId;
	label: string;
	duty: string;
	icon: typeof Film;
}

/** 角色名册：首页团队卡与工作台 TeamPresence 共用 */
export const ROLES: readonly RoleCard[] = [
	{ id: "director", label: "导演", duty: "与你对话，统筹创作方向", icon: Megaphone },
	{ id: "producer", label: "制片人", duty: "多池配额调度，投料建议与预算告警", icon: ClipboardList },
	{ id: "writer", label: "编剧", duty: "剧本、旁白与叙事节奏", icon: PenLine },
	{ id: "art", label: "美术指导", duty: "角色场景设定与视觉圣经", icon: Palette },
	{ id: "storyboard", label: "分镜师", duty: "镜头拆解与生成提示词", icon: Film },
	{ id: "tech", label: "技术导演", duty: "关键帧与视频片段生成", icon: Video },
	{ id: "sound", label: "声音设计", duty: "配音、音效与混音", icon: Volume2 },
	{ id: "editor", label: "剪辑师", duty: "转场节奏与成片导出", icon: Scissors },
	{ id: "reviewer", label: "审片员", duty: "逐镜质检与重做建议", icon: ShieldCheck },
] as const;

export function TeamGrid() {
	return (
		<section>
			<div className="mb-4 flex items-end justify-between gap-4">
				<div>
					<div className="shiny-text mb-1 font-mono text-[10px] tracking-[0.35em]">YOUR CREW</div>
					<h2 className="text-lg font-semibold text-zinc-100">你的 AI 制作团队</h2>
				</div>
				<span className="hidden font-mono text-xs text-zinc-500 sm:block">
					<Clapperboard className="mr-1 inline size-3.5 align-[-2px]" />
					全程接力 · 关键节点等你确认
				</span>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{ROLES.map((role, idx) => {
					const Icon = role.icon;
					return (
						<motion.div
							key={role.id}
							initial={{ opacity: 0, y: 12 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-40px" }}
							transition={{ duration: 0.35, delay: idx * 0.04 }}
							className="group flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 transition-all hover:border-amber-300/40 hover:bg-amber-400/[0.06]"
						>
							<span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] transition-colors group-hover:border-amber-300/40">
								<Icon className="size-4 text-zinc-400 transition-colors group-hover:text-amber-300" />
							</span>
							<span className="min-w-0">
								<span className="block text-sm font-medium text-zinc-100">{role.label}</span>
								<span className="block truncate text-[11px] text-zinc-500 transition-colors group-hover:text-zinc-400">
									{role.duty}
								</span>
							</span>
						</motion.div>
					);
				})}
			</div>
		</section>
	);
}
