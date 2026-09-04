/**
 * 单脚本跑批（带 gender 注入）—— stress test 专用。
 * 不扫全目录，只跑传入的文件路径。
 *
 * 用法：node doc/scripts/dense-dialogues/run-single.mjs <script-path>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runScript } from "./run-scripts-v2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, ".");
const BATCH_ROOT = path.resolve(__dirname, "../../../e2e/results");

const argFile = process.argv[2];
if (!argFile) {
	console.error("用法：node doc/scripts/dense-dialogues/run-single.mjs <script-path>");
	process.exit(1);
}
const filePath = path.isAbsolute(argFile) ? argFile : path.resolve(process.cwd(), argFile);
if (!fs.existsSync(filePath)) {
	console.error(`脚本不存在：${filePath}`);
	process.exit(1);
}

// BATCH_NAME 含 "single" 标记，独立目录
const BATCH_NAME = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-single`;
process.env.BATCH_NAME = BATCH_NAME;

const batchDir = path.join(BATCH_ROOT, BATCH_NAME);
console.log(`单脚本跑批 → ${batchDir}`);

const result = await runScript(filePath, batchDir);
fs.writeFileSync(
	path.join(batchDir, "summary.json"),
	JSON.stringify(
		{
			base: process.env.VIDEO_AGENT_API ?? "http://127.0.0.1:8790",
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			results: [result],
		},
		null,
		"\t",
	),
	"utf-8",
);
console.log(`\n完成 → ${batchDir}/summary.json`);
