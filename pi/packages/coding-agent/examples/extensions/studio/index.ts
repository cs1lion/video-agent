/**
 * pi-studio — 视频工作室多 Agent 系统扩展
 *
 * 主 Agent（工作室总控）通过 studio_* 工具规划管线、分派角色会话、
 * 执行质量门控并跟踪进度；10 个专业角色以进程内 pi 会话运行，
 * 通过消息总线/黑板/产物登记表协作。媒体模型（视频/语音/音乐/图像）
 * 经统一队列限流接入，配置见 .pi-studio/models.json。
 *
 * 安装：将本目录链接到 ~/.pi/agent/extensions/studio/（详见 README.md）。
 * 使用：/studio <一句话需求> 一键开机制片，或直接对话；/studio 查看任务板。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { SessionRunner } from "./core/session-runner.ts";
import { StudioContext } from "./core/studio-context.ts";
import type { RoleActivity, RoleConfig } from "./core/types.ts";
import { loadMediaConfig, type MediaModelsFile } from "./media/adapter.ts";
import { GenerationQueue } from "./media/queue.ts";
import { discoverRoles } from "./roles.ts";
import { registerControlTools, type StudioRuntime } from "./tools/control-tools.ts";
import { StudioBoardComponent } from "./ui/studio-board.ts";

const LEAD_PROTOCOL = `
## 视频工作室总控协议（pi-studio）

你同时是「视频工作室总控」。当用户提出视频制作需求时，切换到总控模式工作；普通工程任务照常处理。

### 标准制作管线（任务 DAG 阶段）
brief(创意简报/艺术总监) → script(剧本/编剧) → visual(美术设计/概念设计师) → direction(镜头阐述/导演) → storyboard(分镜表/分镜设计师) → shots(镜头视频/制片调度生成) → audio(配音·配乐·混音/后期+音效师) → edit(剪辑成片/剪辑师) → delivery(交付报告)

### 工作方式
1. **规划**：理解用户一句话需求（用户是视频小白，主动追问关键信息：时长/受众/用途/风格偏好，但不一次问太多）。用 studio_plan 建立项目与任务 DAG；把需求解读写入计划 brief。
2. **分派**：用 studio_dispatch 按依赖波次推进——无依赖任务先行，互不依赖的任务用 parallel 并批，流水线交接（如剧本→美术设计）用 chain。每次分派后向用户简报进展。
3. **质量门**：产物 submitted 后用 studio_review 过审（关键节点：剧本、美术设计、分镜表、每批镜头视频、成片）。驳回的任务会自动重开——重派时反馈已附在任务上，直接重新 dispatch 即可。
4. **跟踪**：随时 studio_progress 总览；用 studio_messages 与角色通信（他们也会直接给你发消息）。
5. **交付**：全部关键产物 approved 后，安排剪辑与制作报告，向用户总结成果位置（项目目录 .pi-studio/<project>/）。

### 原则
- 对用户用通俗语言汇报进度（像制片主任对客户），技术细节点到为止。
- 镜头生成成本高：先让概念设计师产出美术设计与参考图，分镜表确认后再批量生成。
- 角色会话失败或驳回超两次时，先看汇报内容再决定重试或调整任务说明，不要盲目重派。
- 所有阶段性结论同步给用户；重大风格决策（如整体视觉方向）先征询用户意见。
`.trim();

const STUDIO_PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "studio.md");

/**
 * Load the one-click kickoff template (prompts/studio.md) and substitute
 * the user's requirement for $ARGUMENTS. Falls back to a minimal inline
 * message when the template file is unavailable.
 */
function loadKickoffPrompt(request: string): string {
	try {
		const raw = fs.readFileSync(STUDIO_PROMPT_PATH, "utf-8");
		const { body } = parseFrontmatter<Record<string, string>>(raw);
		const template = body.trim();
		if (template) {
			return template.includes("$ARGUMENTS")
				? template.split("$ARGUMENTS").join(request)
				: `${template}\n\n用户需求：${request}`;
		}
	} catch {
		// fall through to the inline default
	}
	return `请以视频工作室总控身份，针对以下需求一键开机制片（studio_plan → 分波次 studio_dispatch → studio_review 质量门 → 交付）：\n\n${request}`;
}

interface RuntimeState {
	cwd: string | undefined;
	context: StudioContext | undefined;
	runner: SessionRunner | undefined;
	roles: RoleConfig[];
	mediaConfig: MediaModelsFile | undefined;
	modelRegistry: { find: (provider: string, modelId: string) => Model<any> | undefined } | undefined;
	currentModel: Model<any> | undefined;
	/** Live role activity for the board (latest per role). */
	activities: Map<string, RoleActivity>;
}

export default function studioExtension(pi: ExtensionAPI): void {
	const queue = new GenerationQueue(undefined);
	const state: RuntimeState = {
		cwd: undefined,
		context: undefined,
		runner: undefined,
		roles: [],
		mediaConfig: undefined,
		modelRegistry: undefined,
		currentModel: undefined,
		activities: new Map(),
	};

	const ensureRuntime = (cwd: string) => {
		if (state.cwd === cwd && state.runner) return;
		state.cwd = cwd;
		state.roles = discoverRoles(cwd);
		state.mediaConfig = loadMediaConfig(cwd);
		queue.setConfig(state.mediaConfig);
		state.runner = new SessionRunner({
			cwd,
			agentDir: getAgentDir(),
			resolveModel: (ref) => {
				if (!ref) return state.currentModel;
				const separatorIndex = ref.indexOf("/");
				if (separatorIndex <= 0) return undefined;
				const provider = ref.slice(0, separatorIndex);
				const modelId = ref.slice(separatorIndex + 1);
				return state.modelRegistry?.find(provider, modelId) ?? state.currentModel;
			},
			onActivity: (activity) => {
				state.activities.set(activity.role, activity);
			},
		});
	};

	const runtime: StudioRuntime = {
		requireCwd() {
			if (!state.cwd) throw new Error("Studio 尚未初始化（会话未启动）。");
			return state.cwd;
		},
		getContext() {
			if (!state.context) {
				throw new Error("当前没有打开的工作室项目。先用 studio_plan 创建，或用 studio_resume 恢复历史项目。");
			}
			return state.context;
		},
		async createProject(title, request) {
			const cwd = this.requireCwd();
			state.context = await StudioContext.create(cwd, title, request);
			return state.context;
		},
		async resumeProject(projectDir) {
			state.context = await StudioContext.load(projectDir);
			return state.context;
		},
		async listProjects() {
			return StudioContext.listProjects(this.requireCwd());
		},
		requireRoles() {
			if (state.roles.length === 0) {
				throw new Error("Studio 角色未加载（会话未启动或角色目录缺失）。");
			}
			return state.roles;
		},
		getRunner() {
			if (!state.runner) {
				throw new Error("Studio 尚未初始化（会话未启动）。");
			}
			return state.runner;
		},
		queue,
		mediaConfigErrors() {
			return state.mediaConfig?.errors ?? [];
		},
		mediaVisionConfig() {
			return state.mediaConfig?.vision;
		},
	};

	pi.on("session_start", (_event, ctx) => {
		state.modelRegistry = ctx.modelRegistry;
		state.currentModel = ctx.model;
		ensureRuntime(ctx.cwd);
	});

	pi.on("before_agent_start", (event) => {
		const selected = event.systemPromptOptions.selectedTools;
		if (selected && !selected.some((name) => name.startsWith("studio_"))) {
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${LEAD_PROTOCOL}` };
	});

	registerControlTools(pi, runtime);

	pi.registerCommand("studio", {
		description: "一键开机制片（/studio <一句话需求>）或查看任务板（/studio）",
		getArgumentCompletions: (prefix) => {
			const samples = ["一支8-10秒的冰红茶广告片", "产品介绍短视频"];
			const matched = samples.filter((s) => s.startsWith(prefix));
			return matched.length > 0 ? matched.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const request = args.trim();
			if (request) {
				pi.sendUserMessage(loadKickoffPrompt(request));
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/studio 面板需要交互模式；当前进度可用 studio_progress 工具查看", "info");
				return;
			}
			let context: StudioContext;
			try {
				context = runtime.getContext();
			} catch {
				ctx.ui.notify("尚无进行中的工作室项目", "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new StudioBoardComponent(context, theme, () => done());
			});
		},
	});
}
