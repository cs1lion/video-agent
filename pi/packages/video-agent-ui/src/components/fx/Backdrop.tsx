import { motion } from "framer-motion";

export function Backdrop() {
	return (
		<div className="noise pointer-events-none fixed inset-0 overflow-hidden">
			<div className="bg-grid absolute inset-0" />
			{/* 主极光：青 → 紫 → 粉，亮度提升 */}
			<motion.div
				className="aurora-a absolute -top-[20%] -left-[12%] h-[60vmax] w-[60vmax] rounded-full opacity-40 blur-[120px]"
				style={{ background: "radial-gradient(circle, #0ea5e9 0%, transparent 62%)" }}
			/>
			<motion.div
				className="aurora-b absolute -right-[15%] -bottom-[25%] h-[55vmax] w-[55vmax] rounded-full opacity-40 blur-[130px]"
				style={{ background: "radial-gradient(circle, #7c3aed 0%, transparent 62%)" }}
			/>
			<motion.div
				className="aurora-a absolute top-[-30%] left-1/2 h-[50vmax] w-[50vmax] -translate-x-1/2 rounded-full opacity-20 blur-[110px]"
				style={{ background: "radial-gradient(circle, #f472b6 0%, transparent 60%)" }}
			/>
			{/* 点缀光斑：翡翠绿 + 暖金，打破单调 */}
			<motion.div
				className="aurora-b absolute top-[30%] -left-[8%] h-[36vmax] w-[36vmax] rounded-full opacity-[0.16] blur-[100px]"
				style={{ background: "radial-gradient(circle, #34d399 0%, transparent 60%)" }}
			/>
			<motion.div
				className="aurora-a absolute right-[6%] top-[8%] h-[30vmax] w-[30vmax] rounded-full opacity-[0.14] blur-[96px]"
				style={{ background: "radial-gradient(circle, #fbbf24 0%, transparent 58%)" }}
			/>
			{/* 顶部对角色带：工作台头部的一抹亮色 */}
			<div
				className="absolute inset-x-0 top-0 h-40 opacity-25"
				style={{ background: "linear-gradient(180deg, rgba(103, 232, 249, 0.14), transparent)" }}
			/>
			<div
				className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_38%,rgba(5,7,13,0.68)_100%)]"
			/>
		</div>
	);
}
