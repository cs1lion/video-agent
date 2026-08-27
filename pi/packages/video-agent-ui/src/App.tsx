/**
 * 路由根：/#/ 首页（需求 + 访谈），/#/studio/:runId 工作台。
 * HashRouter 规避静态托管路径问题；刷新工作台页由 URL 恢复轮询。
 */

import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { CoCreatePage } from "./pages/CoCreatePage";
import { HomePage } from "./pages/HomePage";
import { StudioPage } from "./pages/StudioPage";

export default function App() {
	return (
		<HashRouter>
			<Routes>
				<Route path="/" element={<HomePage />} />
				<Route path="/cocreate" element={<CoCreatePage />} />
				<Route path="/studio/:id" element={<StudioPage />} />
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</HashRouter>
	);
}
