import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			// 直接引用 workspace 源码：GenerationOptions 等类型的单一来源
			"@earendil-works/pi-video-agent": fileURLToPath(
				new URL("../video-agent/src/index.ts", import.meta.url),
			),
		},
	},
	server: {
		// 8787/8788 均被其他项目会话占用（遗留 piagent-cc / 并行 piagent-ox），
		// 本项目固定改用 5200（UI）/ 8790（API），避免端口争抢。
		port: 5200,
		proxy: {
			"/api": "http://localhost:8790",
		},
	},
});
