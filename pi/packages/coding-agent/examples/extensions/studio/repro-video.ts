/**
 * Minimal repro: run the agnes-video adapter exactly as the queue does.
 *   npx tsx examples/extensions/studio/repro-video.ts <workspaceRoot>
 */
import * as path from "node:path";
import { loadMediaConfig, type MediaAdapterConfig } from "./media/adapter.ts";
import { createOpenAICompatibleAdapter } from "./media/openai-compatible.ts";

async function main() {
	const workspaceRoot = path.resolve(process.argv[2] ?? "C:/Users/18712/OneDrive/桌面/piagent-glm");
	const config = loadMediaConfig(workspaceRoot);
	console.log(`config source: ${config.source}`);
	const video = config.media.find((a) => a.id === "agnes-video") as MediaAdapterConfig;
	if (!video) throw new Error("agnes-video adapter not found");
	console.log(
		`adapter: ${video.id} | apiKey present: ${Boolean(video.apiKey)} | key prefix: ${video.apiKey?.slice(0, 8)}`,
	);
	const adapter = createOpenAICompatibleAdapter(video);
	console.log("generating (this polls until done)…");
	try {
		const result = await adapter.generate({
			kind: "video",
			prompt:
				"A glass of iced red tea on a wooden table, condensation droplets, soft sunlight, commercial product shot, cinematic",
			params: { width: 1280, height: 720, frame_rate: 24, num_frames: 41 },
			outputBase: path.join(workspaceRoot, ".pi-studio", "smoke", "repro-video"),
		});
		console.log(`SUCCESS: ${result.filePath}`);
	} catch (error) {
		console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
		if (error && typeof error === "object" && "status" in error) {
			console.error(`status: ${(error as { status?: number }).status}`);
		}
	}
}

void main();
