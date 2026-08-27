/**
 * SessionRunner — runs one role task in an in-process pi session.
 *
 * Each role gets its own AgentSession with:
 * - the role's system prompt + the studio collaboration protocol appended
 * - a built-in tool whitelist from the role definition
 * - studio shared tools (task updates, messages, blackboard, artifacts,
 *   media generation) bound to the role's identity
 * - an in-memory session (ephemeral; the board/artifacts carry the state)
 *
 * Live activity is reported through `onActivity` for the /studio board.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { GenerationQueue } from "../media/queue.ts";
import { createRoleTools, STUDIO_SHARED_TOOL_NAMES } from "../tools/role-shared-tools.ts";
import type { StudioContext } from "./studio-context.ts";
import type { RoleActivity, RoleConfig, RoleRunEvent, RoleRunResult, UsageTotals } from "./types.ts";

export interface SessionRunnerOptions {
	cwd: string;
	agentDir: string;
	/** Resolve "provider/model-id" references from the role definitions. */
	resolveModel: (ref: string | undefined) => Model<any> | undefined;
	/** Live activity updates for the board (called on every event). */
	onActivity?: (activity: RoleActivity) => void;
	/**
	 * Abort a role session after this many ms without observable activity
	 * (session events or media-queue progress). Guards the pipeline against
	 * sessions whose model call dies silently and never resolves. Must exceed
	 * the longest legitimate silent stretch: one media job attempt can take up
	 * to `timeoutMs` + poll window (~16 min with the shipped video config).
	 * Default 20 minutes.
	 */
	inactivityTimeoutMs?: number;
}

export interface RoleRunRequest {
	role: RoleConfig;
	prompt: string;
	context: StudioContext;
	queue: GenerationQueue;
	taskId?: string;
	onEvent?: (event: RoleRunEvent) => void;
	signal?: AbortSignal;
}

function collaborationProtocol(role: RoleConfig): string {
	return `
## 工作室协作协议（${role.label} / ${role.name}）

你是视频工作室的一员。除了完成本职创作，必须遵守：

1. **开工**：先用 studio_messages(read) 读取发给你的消息，用 studio_blackboard(action=list) 了解项目共享事实（用户需求、风格、角色与场景设定）。需要上游产物（剧本/美术设计/分镜表等）时，用 studio_artifacts(action=list) 查产物 id，再 studio_artifacts(action=read, artifact_id=...) 读内容——不要用 read 工具读项目相对路径（会话工作目录不是项目目录）。
2. **任务**：你的任务由总控分配。开始时用 studio_task_update(update) 把状态设为 running，结束前设为 completed 或 failed，并附 summary 一句话结论。若无法推进则设为 blocked 并说明原因。
3. **产物**：把你的工作成果用 studio_artifacts(submit) 登记（可直接传 content 文本，或先把文件写到项目 assets/ 下再传 path）。未登记的产物不会进入审校和交付流程。
4. **协作**：需要其他角色的信息或发现上游问题时，用 studio_messages(post) 直接发消息给对应角色或 lead；重要结论（角色设定、风格关键词、命名约定）用 studio_blackboard(set) 共享给全组。
5. **媒体生成**：视频/语音/音乐/图像必须通过 studio_media(action=generate) 提交，由制片队列统一限流调度；工具会阻塞等待结果并自动登记产物。生成提示词带上美术设计中该镜头的锚定描述以保持一致性。
6. **收尾**：结束时输出一段给总控的简要汇报（完成了什么、产物在哪、遗留问题）。
`.trim();
}

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(usage: UsageTotals, message: AgentMessage): void {
	if (message.role !== "assistant") return;
	usage.turns++;
	usage.input += message.usage?.input ?? 0;
	usage.output += message.usage?.output ?? 0;
	usage.cacheRead += message.usage?.cacheRead ?? 0;
	usage.cacheWrite += message.usage?.cacheWrite ?? 0;
	usage.cost += message.usage?.cost?.total ?? 0;
}

function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

/** Latest assistant error message, if any. */
function lastErrorMessage(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		return message.errorMessage;
	}
	return undefined;
}

export class SessionRunner {
	private readonly options: SessionRunnerOptions;

	constructor(options: SessionRunnerOptions) {
		this.options = options;
	}

	async run(request: RoleRunRequest): Promise<RoleRunResult> {
		const { role, context, queue, onEvent, signal } = request;
		const usage = emptyUsage();
		const activity: RoleActivity = {
			role: role.name,
			label: role.label,
			status: "running",
			taskId: request.taskId,
			activity: "会话启动",
			usage,
		};
		const emitActivity = (line: string) => {
			activity.activity = line.replace(/\n/g, " ").slice(0, 120);
			this.options.onActivity?.({ ...activity, usage: { ...usage } });
		};
		emitActivity("会话启动");

		try {
			const resourceLoader = new DefaultResourceLoader({
				cwd: this.options.cwd,
				agentDir: this.options.agentDir,
				// Role sessions must not load user extensions (this one included):
				// studio_* control tools would leak into every sub-agent.
				noExtensions: true,
				appendSystemPromptOverride: (base) => [...base, role.systemPrompt, collaborationProtocol(role)],
			});
			await resourceLoader.reload();

			const model = this.options.resolveModel(role.model);
			const { session } = await createAgentSession({
				cwd: this.options.cwd,
				resourceLoader,
				sessionManager: SessionManager.inMemory(),
				...(model ? { model } : {}),
				// The SDK's `tools` allowlist filters customTools too, so the
				// shared studio tools must be whitelisted alongside the role's
				// built-in tools or they silently disappear from the session.
				tools: role.tools ? [...role.tools, ...STUDIO_SHARED_TOOL_NAMES] : undefined,
				customTools: createRoleTools({
					context,
					roleName: role.name,
					queue,
					...(request.taskId ? { taskId: request.taskId } : {}),
				}),
			});

			let aborted = false;
			const onAbort = () => {
				aborted = true;
				void session.abort();
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			// Inactivity watchdog: a role session whose model call dies silently
			// would otherwise stall the whole pipeline (studio_dispatch awaits it
			// without a timeout). Any session event or queue job update resets the
			// timer; silence beyond the threshold aborts the session.
			const inactivityTimeoutMs = this.options.inactivityTimeoutMs ?? 20 * 60_000;
			let lastActivityAt = Date.now();
			let inactivityTimedOut = false;
			const touch = () => {
				lastActivityAt = Date.now();
			};
			const unsubscribeQueue = request.queue.onJobUpdate(touch);
			const watchdog = setInterval(() => {
				if (Date.now() - lastActivityAt < inactivityTimeoutMs || inactivityTimedOut) return;
				inactivityTimedOut = true;
				emitActivity(
					`⚠ ${Math.round((Date.now() - lastActivityAt) / 60_000)} 分钟无任何会话/队列活动，中止本角色会话（防管线挂起）`,
				);
				void session.abort();
			}, 30_000);
			watchdog.unref?.();

			const unsubscribe = session.subscribe((event) => {
				touch();
				switch (event.type) {
					case "message_update":
						if (event.assistantMessageEvent.type === "text_delta") {
							emitActivity(`✍ ${event.assistantMessageEvent.delta}`);
							onEvent?.({ type: "text", text: event.assistantMessageEvent.delta });
						}
						break;
					case "tool_execution_start":
						emitActivity(`⚙ ${event.toolName}`);
						onEvent?.({ type: "tool_call", name: event.toolName, args: event.args ?? {} });
						break;
					case "message_end":
						if (event.message.role === "assistant") {
							addUsage(usage, event.message);
							const text = event.message.content
								.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
								.map((part) => part.text)
								.join("");
							if (text.trim()) onEvent?.({ type: "message", text });
						}
						break;
					default:
						break;
				}
			});

			let promptError: string | undefined;
			let messages: AgentMessage[] = [];
			try {
				emitActivity("思考中…");
				await session.prompt(request.prompt);
			} catch (error) {
				promptError = error instanceof Error ? error.message : String(error);
			} finally {
				messages = session.messages;
				clearInterval(watchdog);
				unsubscribeQueue();
				unsubscribe();
				signal?.removeEventListener("abort", onAbort);
				session.dispose();
			}

			const error =
				promptError ??
				lastErrorMessage(messages) ??
				(inactivityTimedOut
					? `角色会话无活动超时（超过 ${Math.round(inactivityTimeoutMs / 60_000)} 分钟无会话事件/队列进展），已自动中止以解除管线阻塞`
					: undefined) ??
				(aborted ? "已中止" : undefined);
			const output = lastAssistantText(messages);
			const result: RoleRunResult = {
				role: role.name,
				taskId: request.taskId,
				ok: !error,
				output,
				usage,
				error,
			};
			activity.status = "idle";
			activity.activity = result.ok ? `完成：${output.slice(0, 80)}` : `失败：${error}`;
			this.options.onActivity?.({ ...activity, usage: { ...usage } });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			activity.status = "idle";
			activity.activity = `会话异常：${message}`;
			this.options.onActivity?.({ ...activity, usage: { ...usage } });
			return {
				role: role.name,
				taskId: request.taskId,
				ok: false,
				output: "",
				usage,
				error: message,
			};
		}
	}
}
