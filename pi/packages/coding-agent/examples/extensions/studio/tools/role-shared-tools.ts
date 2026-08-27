/**
 * Shared tools injected into every studio role session.
 *
 * Identity binding: role tools operate through StudioContext, which scopes
 * task updates / artifact submissions to the calling role. Media generation
 * funnels through the shared GenerationQueue so per-adapter concurrency
 * limits hold, and successful generations are auto-registered as artifacts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { StudioContext } from "../core/studio-context.ts";
import type { ArtifactKind, MediaKind, TaskStatus } from "../core/types.ts";
import { ARTIFACT_KIND_LABELS, STAGE_LABELS } from "../core/types.ts";
import type { GenerationQueue } from "../media/queue.ts";

export interface RoleToolsOptions {
	context: StudioContext;
	/** Role identity ("lead" for the studio lead). */
	roleName: string;
	queue: GenerationQueue;
	/** Task dispatched to this session (review sessions have none). */
	taskId?: string;
}

function errorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text" as const, text: `错误：${message}` }], details: undefined, isError: true };
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

const TaskStatusEnum = StringEnum(["running", "completed", "failed", "blocked"] as const);

/** Artifact kind recorded for each media kind. */
function artifactKindFor(kind: MediaKind): ArtifactKind {
	switch (kind) {
		case "video":
			return "video";
		case "tts":
			return "audio";
		case "music":
			return "music";
		case "image":
			return "image";
	}
}

/** Names of the shared tools injected into every role session. */
export const STUDIO_SHARED_TOOL_NAMES = [
	"studio_task_update",
	"studio_messages",
	"studio_blackboard",
	"studio_artifacts",
	"studio_media",
	"studio_project_info",
] as const;

export function createRoleTools(options: RoleToolsOptions): ToolDefinition[] {
	const { context, roleName, queue, taskId } = options;

	const taskTool = defineTool({
		name: "studio_task_update",
		label: "任务更新",
		description:
			"查看/更新分配给你的制作任务。list 列出你的任务；update 更新状态（running 开始，completed 完成，failed 失败，blocked 受阻）并附 summary。只能操作本次会话被分派的任务。",
		parameters: Type.Object({
			action: StringEnum(["list", "update"] as const),
			task_id: Type.Optional(Type.String({ description: "任务 id（update 必填）" })),
			status: Type.Optional(TaskStatusEnum),
			summary: Type.Optional(Type.String({ description: "一句话进度/结论说明" })),
		}),
		async execute(_toolCallId, params) {
			try {
				if (params.action === "list") {
					const mine = context.getTasks().filter((t) => t.role === roleName);
					if (mine.length === 0) return textResult("当前没有分配给你的任务。");
					return textResult(
						mine
							.map(
								(t) =>
									`${t.id} [${t.status}] ${t.title}（${STAGE_LABELS[t.stage]}）\n  说明：${t.brief}\n  验收：${t.acceptance}${t.reviewFeedback.length > 0 ? `\n  ⚠ 审校反馈：${t.reviewFeedback.join("；")}` : ""}`,
							)
							.join("\n"),
					);
				}
				if (!taskId) {
					return errorResult("本会话没有分派任务（如审校会话），不能更新任务状态。");
				}
				if (!params.task_id) return errorResult("update 需要 task_id");
				if (!params.status) return errorResult("update 需要 status");
				if (params.task_id !== taskId) {
					return errorResult(`任务 ${params.task_id} 不是本次会话分派给你的任务（${taskId}），不能更新。`);
				}
				const task = await context.updateTask(params.task_id, {
					status: params.status as TaskStatus,
					...(params.summary !== undefined ? { summary: params.summary } : {}),
				});
				if (!task) return errorResult(`任务 ${params.task_id} 不存在`);
				return textResult(`已更新 ${task.id} → ${task.status}${task.summary ? `（${task.summary}）` : ""}`);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	const messageTool = defineTool({
		name: "studio_messages",
		label: "工作室消息",
		description:
			"工作室消息总线。read 读取发给你（含广播）的未读消息并标记已读；post 发消息给其他角色、lead（总控）或 all（全员广播）。这是跨角色协作的主通道。",
		parameters: Type.Object({
			action: StringEnum(["read", "post"] as const),
			to: Type.Optional(Type.String({ description: "收件角色名 / lead / all（post 必填）" })),
			content: Type.Optional(Type.String({ description: "消息正文（post 必填）" })),
			task_id: Type.Optional(Type.String({ description: "关联任务 id" })),
		}),
		async execute(_toolCallId, params) {
			try {
				if (params.action === "read") {
					const unread = await context.readMessagesFor(roleName);
					if (unread.length === 0) return textResult("没有未读消息。");
					return textResult(unread.map((m) => `[${m.id}] 来自 ${m.from}：\n${m.content}`).join("\n---\n"));
				}
				if (!params.to || !params.content) return errorResult("post 需要 to 和 content");
				const message = await context.postMessage(roleName, params.to, params.content, params.task_id);
				return textResult(`已发送 ${message.id} → ${params.to}`);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	const blackboardTool = defineTool({
		name: "studio_blackboard",
		label: "项目黑板",
		description:
			"项目级共享事实（全角色可见）：list 列出全部条目；set 写入/更新（如角色设定、风格关键词、镜头命名约定）。关键结论都应写到这里。",
		parameters: Type.Object({
			action: StringEnum(["list", "set"] as const),
			key: Type.Optional(Type.String({ description: "条目 key，如 style-keywords（set 必填）" })),
			value: Type.Optional(Type.String({ description: "条目内容（set 必填）" })),
		}),
		async execute(_toolCallId, params) {
			try {
				if (params.action === "list") {
					const entries = context.getBlackboard();
					if (entries.length === 0) return textResult("黑板为空。");
					return textResult(entries.map((e) => `${e.key} = ${e.value}`).join("\n"));
				}
				if (!params.key || !params.value) return errorResult("set 需要 key 和 value");
				await context.writeBlackboard(roleName, params.key, params.value);
				return textResult(`已写入黑板：${params.key}`);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	const artifactTool = defineTool({
		name: "studio_artifacts",
		label: "产物登记",
		description:
			"产物登记表。list 查看产物（可按 kind 过滤，含质量状态与审校意见）；read 按产物 id 读取内容（读上游剧本/美术设计/分镜表用这个，不要用 read 工具读相对路径）；submit 登记你的产物——文本类产物（剧本/美术设计/分镜表/报告）直接传 content；已在 assets/ 下的文件传 path（相对项目目录）。产物须登记后才会进入审校与交付。",
		parameters: Type.Object({
			action: StringEnum(["list", "read", "submit"] as const),
			artifact_id: Type.Optional(Type.String({ description: "产物 id（read 必填）" })),
			kind: Type.Optional(
				StringEnum(Object.keys(ARTIFACT_KIND_LABELS) as ArtifactKind[], {
					description: "submit 必填 / list 可选过滤",
				}),
			),
			name: Type.Optional(Type.String({ description: "产物名称（submit 必填）" })),
			content: Type.Optional(Type.String({ description: "文本产物内容（submit 与 path 二选一）" })),
			path: Type.Optional(
				Type.String({ description: "项目内相对路径，如 assets/script.md（submit 与 content 二选一）" }),
			),
			summary: Type.Optional(Type.String({ description: "一句话内容说明" })),
			task_id: Type.Optional(Type.String({ description: "关联任务 id" })),
		}),
		async execute(_toolCallId, params) {
			try {
				if (params.action === "read") {
					if (!params.artifact_id) return errorResult("read 需要 artifact_id");
					const content = await context.readArtifact(params.artifact_id);
					return textResult(content);
				}
				if (params.action === "list") {
					let artifacts = context.getArtifacts();
					if (params.kind) artifacts = artifacts.filter((a) => a.kind === params.kind);
					if (artifacts.length === 0) return textResult("暂无产物。");
					return textResult(
						artifacts
							.map(
								(a) =>
									`${a.id} [${a.status}] ${ARTIFACT_KIND_LABELS[a.kind]}《${a.name}》 by ${a.role} → ${a.path}${a.reviewComments ? `\n  审校：${a.reviewComments}` : ""}`,
							)
							.join("\n"),
					);
				}
				if (!params.kind || !params.name) return errorResult("submit 需要 kind 和 name");
				if (!params.content && !params.path) return errorResult("submit 需要 content 或 path");
				const artifact = await context.submitArtifact({
					taskId: params.task_id ?? "",
					role: roleName,
					name: params.name,
					kind: params.kind,
					...(params.content !== undefined ? { content: params.content } : {}),
					...(params.path !== undefined ? { sourcePath: params.path } : {}),
					...(params.summary !== undefined ? { summary: params.summary } : {}),
				});
				return textResult(`已登记产物 ${artifact.id}《${artifact.name}》（${artifact.path}），等待审校。`);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	const mediaTool = defineTool({
		name: "studio_media",
		label: "媒体生成",
		description:
			"媒体模型生成（经制片队列统一限流）。generate 提交生成任务并等待完成：kind 为 video/image/tts/music，prompt 为生成提示词，output_name 为输出文件名（不含扩展名），params 为模型参数（视频传 seconds 或 num_frames/frame_rate/width/height，TTS 传 voice/instruction，图像传 size 等），task_id 关联任务（成功后自动登记产物）。status 查看队列与跟踪统计（每任务尝试历史/错误分类，每适配器成功/失败/重试/429限流次数、平均耗时与并发状态）。遇到模型限流或服务繁忙时队列会自动退避重试并临时降低该模型并发，无需手动干预。",
		parameters: Type.Object({
			action: StringEnum(["generate", "status"] as const),
			kind: Type.Optional(StringEnum(["video", "tts", "music", "image"] as const, { description: "generate 必填" })),
			prompt: Type.Optional(Type.String({ description: "生成提示词（generate 必填）" })),
			params: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "模型参数，如 { seconds: 5, width: 1152, height: 768 } 或 { voice: 'cixingnansheng' }",
				}),
			),
			output_name: Type.Optional(
				Type.String({ description: "输出文件名（不含扩展名），如 shot-01（generate 必填）" }),
			),
			priority: Type.Optional(Type.Number({ description: "排队优先级，小者先（默认 100）" })),
			task_id: Type.Optional(Type.String({ description: "关联任务 id，生成成功后自动登记产物" })),
			job_id: Type.Optional(Type.String({ description: "status 查询指定任务" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			try {
				if (params.action === "status") {
					const jobs = params.job_id ? queue.list().filter((j) => j.id === params.job_id) : queue.list();
					const stats = queue.stats();
					const statLines = Object.values(stats.adapters).map(
						(a) =>
							`- ${a.id}: 成功 ${a.done} / 失败 ${a.failed} / 重试 ${a.retries} / 限流(429) ${a.rateLimited}` +
							`${a.done > 0 ? `，平均耗时 ${(a.avgDurationMs / 1000).toFixed(0)}s` : ""}` +
							`，并发上限 ${a.limit}${a.throttledForMs ? `（限流冷却中，剩 ${(a.throttledForMs / 1000).toFixed(0)}s）` : ""}`,
					);
					const summary = [
						`队列总览：提交 ${stats.submitted} / 成功 ${stats.done} / 失败 ${stats.failed} / 重试 ${stats.retries} / 限流 ${stats.rateLimited}；排队 ${stats.queued} / 运行中 ${stats.running}`,
						...(statLines.length > 0 ? ["适配器统计：", ...statLines] : []),
					].join("\n");
					if (jobs.length === 0) return textResult(`${summary}\n\n（暂无生成任务）`);
					const jobLines = jobs.map((j) => {
						const retries = j.attemptLog
							.filter((a) => a.error)
							.map(
								(a) =>
									`#${a.attempt} ${a.retryable ? "可重试" : "不可重试"}错误: ${(a.error ?? "").slice(0, 120)}`,
							);
						return [
							`${j.id} [${j.status}] ${j.kind} → ${j.relativePath}${j.queuedMs !== undefined ? `（排队 ${(j.queuedMs / 1000).toFixed(1)}s）` : ""}${j.error ? ` 错误：${j.error}` : ""}`,
							...(retries.length > 0 ? retries.map((line) => `  ↳ ${line}`) : []),
						].join("\n");
					});
					return textResult(`${summary}\n\n任务明细：\n${jobLines.join("\n")}`);
				}
				if (!params.kind || !params.prompt || !params.output_name) {
					return errorResult("generate 需要 kind、prompt、output_name");
				}
				const job = queue.submit(
					{
						roleName,
						kind: params.kind,
						prompt: params.prompt,
						params: (params.params as Record<string, unknown>) ?? {},
						outputName: params.output_name,
						priority: params.priority,
					},
					context.projectDir,
				);
				onUpdate?.({
					content: [{ type: "text", text: `已排队 ${job.id}（${params.kind}），等待生成…` }],
					details: undefined,
				});
				const finished = await queue.awaitJob(
					job.id,
					(j) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `${j.id} ${params.kind}：${j.status}${j.error ? ` ${j.error}` : ""}`,
								},
							],
							details: undefined,
						});
					},
					signal,
				);
				if (finished.status === "failed") {
					const retryNotes = finished.attemptLog
						.filter((a) => a.error)
						.map(
							(a) =>
								`第${a.attempt}次${a.retryable ? "（限流/繁忙，已自动重试）" : ""}: ${(a.error ?? "").slice(0, 160)}`,
						);
					return errorResult(
						`生成失败（已尝试 ${finished.attempts} 次）：${finished.error}` +
							(retryNotes.length > 1 ? `\n尝试历史：\n${retryNotes.join("\n")}` : ""),
					);
				}
				// Auto-register the generated file as an artifact so it enters
				// the review/delivery flow without an extra step.
				const artifact = await context.submitArtifact({
					taskId: params.task_id ?? "",
					role: roleName,
					name: params.output_name,
					kind: artifactKindFor(params.kind),
					sourcePath: finished.relativePath,
					...(finished.metaUrl ? { sourceUrl: finished.metaUrl } : {}),
					summary: params.prompt.slice(0, 120),
				});
				return textResult(
					`生成完成：${finished.relativePath}\n已自动登记为产物 ${artifact.id}《${artifact.name}》。`,
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	const projectInfoTool = defineTool({
		name: "studio_project_info",
		label: "项目信息",
		description: "查看项目概况、完整任务板进度与全部产物状态。开工前先看一眼。",
		parameters: Type.Object({}),
		async execute() {
			try {
				return textResult(context.progressSummary());
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	return [taskTool, messageTool, blackboardTool, artifactTool, mediaTool, projectInfoTool];
}
