/**
 * Studio media layer smoke test — exercises the real adapters against the
 * configured APIs (image / tts / video / vision). No text LLM needed.
 *
 *   npx tsx examples/extensions/studio/smoke.ts [workspaceRoot]
 *
 * workspaceRoot defaults to the parent of the pi repo (where
 * `.pi-studio/models.json` lives). Outputs are written to
 * `<workspaceRoot>/.pi-studio/smoke/`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadMediaConfig, type MediaAdapterConfig } from "./media/adapter.ts";
import { createOpenAICompatibleAdapter } from "./media/openai-compatible.ts";
import { describeArtifact } from "./media/vision.ts";

function pngSize(filePath: string): { width: number; height: number } {
	const buffer = fs.readFileSync(filePath);
	// PNG IHDR: width at offset 16, height at offset 20 (big-endian u32).
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	};
}

function assert(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(`断言失败: ${message}`);
}

async function main() {
	const workspaceRoot = path.resolve(
		process.argv[2] ?? path.join(import.meta.dirname, "..", "..", "..", "..", "..", ".."),
	);
	console.log(`工作区根目录: ${workspaceRoot}`);

	const config = loadMediaConfig(workspaceRoot);
	console.log(`配置来源: ${config.source ?? "（未找到）"}`);
	if (config.errors.length > 0) {
		console.error(`配置错误:\n${config.errors.join("\n")}`);
		process.exit(1);
	}
	const outDir = path.join(workspaceRoot, ".pi-studio", "smoke");
	fs.mkdirSync(outDir, { recursive: true });

	const find = (id: string): MediaAdapterConfig => {
		const adapter = config.media.find((a) => a.id === id);
		assert(adapter, `缺少适配器 ${id}`);
		return adapter;
	};

	// ---------------------------------------------------------------- image
	console.log("\n[1/4] 阶跃生图 …");
	const imageAdapter = createOpenAICompatibleAdapter(find("step-image"));
	const imageResult = await imageAdapter.generate({
		kind: "image",
		prompt:
			"夏日午后的冰红茶玻璃瓶特写，琥珀色茶汤，冰块与柠檬片，水珠凝结，背景是虚化的阳光与绿叶，商业广告摄影风格，画质细腻",
		params: {},
		outputBase: path.join(outDir, "smoke-image"),
	});
	const size = pngSize(imageResult.filePath);
	console.log(`  ✓ 图片已保存: ${imageResult.filePath} (${size.width}x${size.height})`);
	assert(size.width === 1360 && size.height === 768, "768x1360 应生成 1360 宽 × 768 高（横版）");

	// ------------------------------------------------------------------ tts
	console.log("\n[2/4] 阶跃 TTS …");
	const ttsAdapter = createOpenAICompatibleAdapter(find("step-tts"));
	const ttsResult = await ttsAdapter.generate({
		kind: "tts",
		prompt: "（清爽有活力）这个夏天，来一口冰红茶！",
		params: { instruction: "广告旁白，语气清爽有活力" },
		outputBase: path.join(outDir, "smoke-tts"),
	});
	const ttsBytes = fs.statSync(ttsResult.filePath).size;
	console.log(`  ✓ 音频已保存: ${ttsResult.filePath} (${(ttsBytes / 1024).toFixed(0)} KB)`);
	assert(ttsBytes > 10_000, "TTS 音频应大于 10KB");

	// --------------------------------------------------------------- vision
	console.log("\n[3/4] 视觉审校（step-3.7-flash 描述生成图）…");
	const description = await describeArtifact(config.vision, {
		name: "smoke-image",
		source: imageResult.filePath,
		kind: "image",
		expectation: "冰红茶玻璃瓶商业广告特写",
		brief: "冰红茶主题广告片冒烟测试",
	});
	console.log(`  ✓ 审校模型返回 (ok=${description.ok}):\n${description.description.slice(0, 400)}`);

	// ---------------------------------------------------------------- video
	console.log("\n[4/4] Agnes 视频（约 3.4 秒，异步生成需等待）…");
	const videoAdapter = createOpenAICompatibleAdapter(find("agnes-video"));
	const videoResult = await videoAdapter.generate({
		kind: "video",
		prompt:
			"A chilled glass bottle of iced black tea with condensation droplets, lemon slice and ice cubes, slow cinematic push-in shot, bright summer sunlight, commercial advertisement style",
		params: { seconds: 3.5 },
		outputBase: path.join(outDir, "smoke-video"),
	});
	const videoBytes = fs.statSync(videoResult.filePath).size;
	console.log(
		`  ✓ 视频已保存: ${videoResult.filePath} (${(videoBytes / 1024 / 1024).toFixed(1)} MB, URL: ${videoResult.meta?.url ?? "无"})`,
	);
	assert(videoBytes > 100_000, "视频应大于 100KB");

	console.log("\n全部冒烟测试通过 ✓");
}

main().catch((error) => {
	console.error(`\n冒烟测试失败: ${error instanceof Error ? error.stack : String(error)}`);
	process.exit(1);
});
