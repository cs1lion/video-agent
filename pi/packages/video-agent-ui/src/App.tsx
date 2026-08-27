/**
 * 路由根：/#/ 首页（需求 + 访谈），/#/studio/:runId 工作台。
 * HashRouter 规避静态托管路径问题；刷新工作台页由 URL 恢复轮询。
 */

import { Suspense, lazy } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

// 路由级拆包：首页 / 共创 / 工作台只在访问时下载对应大块功能。
const CoCreatePage = lazy(async () => {
	const page = await import("./pages/CoCreatePage");
	return { default: page.CoCreatePage };
});
const HomePage = lazy(async () => {
	const page = await import("./pages/HomePage");
	return { default: page.HomePage };
});
const StudioPage = lazy(async () => {
	const page = await import("./pages/StudioPage");
	return { default: page.StudioPage };
});

export default function App() {
	return (
		<HashRouter>
			<Suspense
				fallback={
					<div className="flex min-h-dvh items-center justify-center bg-black text-sm text-zinc-500">
						正在加载工作台…
					</div>
				}
			>
				<Routes>
					<Route path="/" element={<HomePage />} />
					<Route path="/cocreate" element={<CoCreatePage />} />
					<Route path="/studio/:id" element={<StudioPage />} />
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
			</Suspense>
		</HashRouter>
	);
}
