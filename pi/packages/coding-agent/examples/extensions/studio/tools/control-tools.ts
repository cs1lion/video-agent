/**
 * Control tools for the studio lead (main agent).
 *
 * studio_plan     — create the project and its task DAG from the user brief
 * studio_dispatch — run tasks through role sessions (single/parallel/chain)
 * studio_review   — quality gate: dispatch the reviewer, apply the verdict
 * studio_progress — board snapshot
 * studio_messages — the lead's handle on the same message bus roles use
 * studio_resume   — list/resume saved projects after a restart
 *
 * The runtime (context/runner/queue) is resolved lazily per execute because
 * the session cwd is not known when the extension registers tools.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionRunner } from "../core/session-runner.ts";
import type { StudioContext } from "../core/studio-context.ts";
import {
	PIPELINE_STAGES,
	type PipelineStage,
	type RoleConfig,
	type RoleRunEvent,
	type StudioProject,
} from "../core/types.ts";
import type { VisionConfig } from "../media/adapter.ts";
import type { GenerationQueue } from "../media/queue.ts";
import { describeArtifact } from "../media/vision.ts";
import { findRole, roleListText } from "../roles.ts";

const MAX_PARALLEL = 4;

export interface StudioRuntime {
	/** Current working directory (throws before session_start). */
	requireCwd(): string;
	/** Active project context (throws when no project is open). */
	getContext(): StudioContext;
	/** Create a new studio project. */
	createProject(title: string, request: string): Promise<StudioContext>;
	/** Resume a saved project by directory. */
	resumeProject(projectDir: string): Promise<StudioContext>;
	/** Saved projects under the studio root (newest first). */
	listProjects(): Promise<Array<{ dir: string; project: StudioProject }>>;
	/** Studio roles (throws before session_start). */
	requireRoles(): RoleConfig[];
	getRunner(): SessionRunner;
	queue: GenerationQueue;
	/** Media config problems surfaced to the lead. */
	mediaConfigErrors(): string[];
	/** Vision model config for media artifact review (if configured). */
	mediaVisionConfig(): VisionConfig | undefined;
}

function ok(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details, isError: true };
}

const StageEnum = StringEnum(PIPELINE_STAGES as unknown as [PipelineStage, ...PipelineStage[]], {
	description: "制作阶段",
});

/** Build the dispatch prompt for one board task. */
function buildTaskPrompt(context: StudioContext, taskId: string): string {
	const task = context.getTask(taskId);
	if (!task) throw new Error(`任务 ${taskId} 不存在`);
	const project = context.getProject();
	const parts: string[] = [
		`【任务 ${task.id}：${task.title}】`,
		`项目：${project.title}（需求：${project.brief ?? project.request}）`,
		"",
		`工作说明：${task.brief}`,
		`验收标准：${task.acceptance}`,
	];
	if (task.reviewFeedback.length > 0) {
		parts.push("", `⚠ 历史审校反馈（本次必须解决）：`, ...task.reviewFeedback.map((f) => `- ${f}`));
	}
	parts.push("", `项目目录：${context.projectDir}（产物写 assets/ 下并登记）`);
	return parts.join("\n");
}

export function registerControlTools(pi: ExtensionAPI, runtime: StudioRuntime): void {
	const planTool = defineTool({
		name: "studio_plan",
		label: "制定制作计划",
		description:
			"用户新需求确定后，创建项目并制定任务计划（管线 DAG）。按标准制作管线拆分任务：brief→script→visual→direction→storyboard→shots→audio→edit→delivery，role 填角色名（art-director/screenwriter/concept-designer/director/storyboard-artist/producer/post-production/sound-mixer/reviewer/editor，可用 studio_list_roles 查看）。depends_on 填前序任务 id（T1、T2…按顺序自动编号，只能引用更早的任务）。",
		parameters: Type.Object({
			project_name: Type.String({ description: "项目名" }),
			brief: Type.String({ description: "用户需求与创意基调（原文+你的解读）" }),
			tasks: Type.Array(
				Type.Object({
					stage: StageEnum,
					title: Type.String(),
					brief: Type.String({ description: "给该角色的具体任务说明" }),
					role: Type.String({ description: "负责角色名" }),
					depends_on: Type.Optional(Type.Array(Type.String(), { description: "前序任务 id，如 ['T1']" })),
					acceptance: Type.Optional(Type.String({ description: "验收标准（审校依据）" })),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const roles = runtime.requireRoles();
				const unknown = [...new Set(params.tasks.map((t) => t.role))].filter((name) => !findRole(roles, name));
				if (unknown.length > 0) {
					return fail(`未知角色：${unknown.join(", ")}。\n可用角色：\n${roleListText(roles)}`);
				}
				const context = await runtime.createProject(params.project_name, params.brief);
				const taskInputs = params.tasks.map((task, index) => ({
					id: `T${index + 1}`,
					stage: task.stage,
					role: task.role,
					title: task.title,
					brief: task.brief,
					acceptance: task.acceptance,
					dependsOn: task.depends_on ?? [],
				}));
				const { tasks, errors } = await context.plan(params.project_name, params.brief, taskInputs);
				if (errors.length > 0) {
					return fail(`计划校验失败：\n${errors.join("\n")}`);
				}
				const mediaErrors = runtime.mediaConfigErrors();
				const mediaNote = mediaErrors.length > 0 ? `\n\n⚠ 媒体模型配置问题：\n${mediaErrors.join("\n")}` : "";
				return ok(
					`项目已创建：「${params.project_name}」（${context.projectId}），共 ${tasks.length} 个任务。${mediaNote}\n\n${context.progressSummary()}\n\n下一步：用 studio_dispatch 分派无依赖任务（可分派的任务已在上方列出）。`,
					{ projectId: context.projectId, taskIds: tasks.map((t) => t.id) },
				);
			} catch (error) {
				return fail(`制定计划失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	const rolesTool = defineTool({
		name: "studio_list_roles",
		label: "查看角色",
		description: "列出工作室可用角色及其职责。",
		parameters: Type.Object({}),
		async execute() {
			return ok(roleListText(runtime.requireRoles()));
		},
	});

	const dispatchTool = defineTool({
		name: "studio_dispatch",
		label: "分派任务",
		description:
			"分派制作任务给角色会话执行。single 单任务（task_id）；parallel 并行多任务（互不依赖的任务同批执行）；chain 顺序执行（任务说明里可用 {previous} 引用上一步汇报，用于流水线交接）。基于任务板传任务 id（自动带任务说明/验收标准/审校反馈，完成后自动更新状态）。镜头生成等高成本任务建议小批量分派。",
		parameters: Type.Object({
			mode: StringEnum(["single", "parallel", "chain"] as const),
			task_id: Type.Optional(Type.String({ description: "single 模式：任务板任务 id" })),
			task_ids: Type.Optional(Type.Array(Type.String(), { description: "parallel 模式：任务 id 列表" })),
			chain_task_ids: Type.Optional(
				Type.Array(Type.String(), { description: "chain 模式：按顺序执行的任务 id 列表" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			try {
				const context = runtime.getContext();
				const runner = runtime.getRunner();
				const roles = runtime.requireRoles();
				interface Unit {
					role: RoleConfig;
					prompt: string;
					taskId: string;
				}
				const units: Unit[] = [];

				const resolveUnit = (taskId: string): Unit => {
					const task = context.getTask(taskId);
					if (!task) throw new Error(`任务 ${taskId} 不存在`);
					const role = findRole(roles, task.role);
					if (!role) throw new Error(`任务 ${taskId} 的负责角色 ${task.role} 未定义`);
					if (task.status !== "pending" && task.status !== "reopened" && task.status !== "failed") {
						throw new Error(`任务 ${taskId} 当前状态 ${task.status}，只有 pending/reopened/failed 可分派`);
					}
					const unmet = task.dependsOn.filter((dep) => context.getTask(dep)?.status !== "completed");
					if (unmet.length > 0) throw new Error(`任务 ${taskId} 依赖未完成：${unmet.join(", ")}`);
					return { role, prompt: buildTaskPrompt(context, taskId), taskId };
				};

				if (params.mode === "single") {
					if (!params.task_id) return fail("single 模式需要 task_id");
					units.push(resolveUnit(params.task_id));
				} else if (params.mode === "parallel") {
					if (!params.task_ids?.length) return fail("parallel 模式需要 task_ids");
					if (params.task_ids.length > MAX_PARALLEL) {
						return fail(`并行上限 ${MAX_PARALLEL}，当前 ${params.task_ids.length} 个`);
					}
					for (const taskId of params.task_ids) units.push(resolveUnit(taskId));
				} else {
					if (!params.chain_task_ids?.length) return fail("chain 模式需要 chain_task_ids");
					for (const taskId of params.chain_task_ids) units.push(resolveUnit(taskId));
				}

				const results: Array<{
					role: string;
					taskId: string;
					ok: boolean;
					output: string;
					error?: string;
				}> = [];

				const emit = () => {
					if (!onUpdate) return;
					const lines = results.map(
						(r, i) =>
							`${r.ok ? "✓" : "✗"} ${i + 1}. ${r.role}${r.taskId ? ` ${r.taskId}` : ""}${r.output ? `：${r.output.slice(0, 100).replace(/\n/g, " ")}` : ""}`,
					);
					onUpdate({
						content: [
							{
								type: "text",
								text: `分派进度（${results.length}/${units.length} 完成）：\n${lines.join("\n") || "（启动中…）"}`,
							},
						],
						details: undefined,
					});
				};

				const runUnit = async (unit: Unit, previousOutput?: string) => {
					await context.updateTask(unit.taskId, { status: "running" });
					const events: RoleRunEvent[] = [];
					const result = await runner.run({
						role: unit.role,
						prompt: previousOutput ? unit.prompt.replace(/\{previous\}/g, previousOutput) : unit.prompt,
						context,
						queue: runtime.queue,
						taskId: unit.taskId,
						signal,
						onEvent: (event) => {
							events.push(event);
						},
					});
					results.push({
						role: unit.role.name,
						taskId: unit.taskId,
						ok: result.ok,
						output: result.output,
						error: result.error,
					});
					// The role session may already have updated its task status;
					// only set the final state when it is still "running".
					const latest = context.getTask(unit.taskId);
					if (latest?.status === "running") {
						await context.updateTask(unit.taskId, {
							status: result.ok ? "completed" : "failed",
							...(result.ok ? { summary: result.output.slice(0, 200) } : {}),
						});
					}
					emit();
					return result;
				};

				if (params.mode === "parallel") {
					await Promise.all(units.map((unit) => runUnit(unit)));
				} else {
					let previousOutput = "";
					for (const unit of units) {
						const result = await runUnit(unit, previousOutput || undefined);
						if (!result.ok) break;
						previousOutput = result.output;
					}
				}

				const summary = results
					.map(
						(r, i) =>
							`### ${i + 1}. ${r.role}（${r.taskId}）${r.ok ? " ✓" : " ✗"}\n${r.ok ? r.output : `失败：${r.error ?? "(无输出)"}`}`,
					)
					.join("\n\n");
				const okCount = results.filter((r) => r.ok).length;
				return ok(`分派完成：${okCount}/${results.length} 成功\n\n${summary}\n\n${context.progressSummary()}`, {
					results: results.map((r) => ({ ...r, output: r.output.slice(0, 2000) })),
				});
			} catch (error) {
				return fail(`分派失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	const reviewTool = defineTool({
		name: "studio_review",
		label: "质量审校",
		description:
			"对已提交(submitted)的产物执行质量门：派 reviewer 审阅并按创意简报给出结论。approved 通过；rejected 连同意见自动重开产出该产物的任务（重派即附反馈）。可一次审多个产物。关键节点（剧本、美术设计、分镜表、镜头视频、成片）都应过审。",
		parameters: Type.Object({
			artifact_ids: Type.Array(Type.String(), { minItems: 1, description: "待审产物 id 列表" }),
			extra_criteria: Type.Optional(Type.String({ description: "附加审校要点" })),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const context = runtime.getContext();
				const runner = runtime.getRunner();
				const artifacts = params.artifact_ids
					.map((id) => context.getArtifact(id))
					.filter((a): a is NonNullable<typeof a> => a !== undefined);
				const missing = params.artifact_ids.filter((id) => !artifacts.some((a) => a.id === id));
				if (missing.length > 0) return fail(`产物不存在：${missing.join(", ")}`);
				const notSubmitted = artifacts.filter((a) => a.status !== "submitted");
				if (notSubmitted.length > 0) {
					return fail(
						`这些产物不是待审状态（submitted）：${notSubmitted.map((a) => `${a.id}[${a.status}]`).join(", ")}`,
					);
				}

				const roles = runtime.requireRoles();
				const reviewer = findRole(roles, "reviewer");
				if (!reviewer) return fail("reviewer 角色未定义");

				const project = context.getProject();

				// Probe media artifacts with the vision model so the text reviewer
				// can judge image/video/audio content from real descriptions.
				const visionConfig = runtime.mediaVisionConfig();
				const mediaKinds = new Set(["image", "video", "audio", "music"]);
				const mediaArtifacts = artifacts.filter(
					(a) => mediaKinds.has(a.kind) && (a.sourceUrl || a.kind !== "video"),
				);
				const descriptions = new Map<string, string>();
				if (mediaArtifacts.length > 0) {
					await Promise.all(
						mediaArtifacts.map(async (artifact) => {
							const kind = artifact.kind === "video" ? "video" : artifact.kind === "image" ? "image" : "audio";
							const source = artifact.sourceUrl ?? path.join(context.projectDir, artifact.path);
							const description = await describeArtifact(
								visionConfig,
								{
									name: artifact.name,
									source,
									kind,
									expectation: artifact.summary,
									brief: project.brief ?? project.request,
								},
								signal,
							);
							descriptions.set(artifact.id, description.description);
						}),
					);
				}

				// Text artifact content is inlined into the review prompt so the
				// reviewer never has to resolve project-relative paths against the
				// session cwd (role sessions run in the user's working directory,
				// not the project directory).
				const TEXT_KINDS = new Set(["brief", "script", "visual-bible", "storyboard", "report"]);
				const INLINE_LIMIT = 40_000;
				const artifactLines = (
					await Promise.all(
						artifacts.map(async (a) => {
							const base = `- ${a.id}《${a.name}》（${a.kind}，by ${a.role}）${a.summary ? `：${a.summary}` : ""}`;
							const description = descriptions.get(a.id);
							const descLine = description ? `\n  视觉审校描述：${description}` : "";
							if (!TEXT_KINDS.has(a.kind)) return `${base}${descLine}`;
							const absolute = path.join(context.projectDir, a.path);
							const stat = await fs.promises.stat(absolute).catch(() => undefined);
							if (!stat) return `${base}${descLine}\n  ⚠ 产物文件缺失：${absolute}`;
							if (stat.size <= INLINE_LIMIT) {
								const content = await fs.promises.readFile(absolute, "utf-8").catch(() => undefined);
								if (content !== undefined) {
									return `${base}${descLine}\n  ---- 产物内容 ----\n${content}\n  ---- 内容结束 ----`;
								}
							}
							return `${base}${descLine}\n  （文件较大，用 read 工具读取绝对路径：${absolute}）`;
						}),
					)
				).join("\n");
				const prompt = [
					"请审校以下产物。项目创意基调（用户需求）：",
					project.brief ?? project.request,
					"",
					"待审产物：",
					artifactLines,
					params.extra_criteria ? `\n附加审校要点：${params.extra_criteria}` : "",
					"",
					"审校要求：",
					"1. 文本产物的完整内容已内联在上方（过大的文件给出了绝对路径，可用 read 工具读取）；媒体产物以「视觉审校描述」（多模态模型实地查看的结论）为主要判断依据。",
					"2. 对照创意简报、上游产物（美术设计/分镜表）与角色规范逐项检查。",
					"3. 对每个产物给出结论，并在最后输出一个 JSON 汇总块：",
					"```json",
					'{"verdicts":[{"artifact_id":"art-xxx","approved":true,"notes":"..."},{"artifact_id":"art-yyy","approved":false,"notes":"具体问题与可执行的修改建议"}]}',
					"```",
					"注意：approved=false 时 notes 必须具体可执行（哪个镜头/哪段偏离创意、怎么改）。",
					"本次是审校会话，没有分派给你的任务：不要使用 studio_task_update 修改任务状态，结论只通过 JSON 汇总块返回。",
				].join("\n");

				const result = await runner.run({
					role: reviewer,
					prompt,
					context,
					queue: runtime.queue,
					signal,
				});
				if (!result.ok) {
					return fail(`审校会话失败：${result.error ?? result.output}`);
				}

				const verdicts = parseVerdicts(result.output);
				if (verdicts.length === 0) {
					return fail(
						`审校完成但未解析出结论 JSON。审校汇报：\n${result.output}\n\n可重试，或参考汇报内容用 studio_artifacts 的状态自行判断。`,
					);
				}
				const applied: string[] = [];
				for (const verdict of verdicts) {
					const outcome = await context.applyReview(
						verdict.artifact_id,
						verdict.approved ? "approved" : "rejected",
						verdict.notes,
					);
					if (!outcome.artifact) {
						applied.push(`${verdict.artifact_id} 应用结论失败（id 不存在？）`);
						continue;
					}
					applied.push(
						`${outcome.artifact.id} ${verdict.approved ? "✓ 通过" : "✗ 驳回并重开任务"}：${verdict.notes}`,
					);
				}
				return ok(`审校完成：\n${applied.join("\n")}\n\n${context.progressSummary()}`, {
					verdicts,
					reviewerOutput: result.output.slice(0, 4000),
				});
			} catch (error) {
				return fail(`审校失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	const progressTool = defineTool({
		name: "studio_progress",
		label: "进度总览",
		description: "查看制作进度总览：各阶段任务状态、产物质量状态、待审清单。向用户汇报前先看这个。",
		parameters: Type.Object({}),
		async execute() {
			return ok(runtime.getContext().progressSummary());
		},
	});

	const resumeTool = defineTool({
		name: "studio_resume",
		label: "恢复项目",
		description: "不传参数列出可恢复的历史项目；传 project_dir 恢复指定项目（重启会话后继续制作时使用）。",
		parameters: Type.Object({
			project_dir: Type.Optional(Type.String({ description: "项目目录（list 结果中的 dir）" })),
		}),
		async execute(_toolCallId, params) {
			try {
				if (!params.project_dir) {
					const projects = await runtime.listProjects();
					if (projects.length === 0) return ok("没有可恢复的项目。用 studio_plan 创建新项目。");
					return ok(
						`${projects
							.map(
								(p) =>
									`- ${p.dir}\n  「${p.project.title}」（${p.project.id}，${p.project.status}，${p.project.createdAt}）`,
							)
							.join("\n")}\n\n用 studio_resume 传 project_dir 恢复。`,
					);
				}
				const context = await runtime.resumeProject(params.project_dir);
				return ok(
					`已恢复项目「${context.getProject().title}」（${context.projectId}）。\n\n${context.progressSummary()}`,
				);
			} catch (error) {
				return fail(`恢复项目失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	// The lead's handle on the message bus. Context is resolved lazily inside
	// execute because no project is open when tools are registered.
	const leadMessageTool = defineTool({
		name: "studio_messages",
		label: "工作室消息",
		description:
			"工作室消息总线（总控视角）。read 读取发给你的未读消息（角色会直接给你发）；post 发消息给角色或 all（全员广播，如风格调整、计划变更）；list 查看全部消息流。",
		parameters: Type.Object({
			action: StringEnum(["read", "post", "list"] as const),
			to: Type.Optional(Type.String({ description: "收件角色名 / all（post 必填）" })),
			content: Type.Optional(Type.String({ description: "消息正文（post 必填）" })),
			task_id: Type.Optional(Type.String({ description: "关联任务 id" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const context = runtime.getContext();
				if (params.action === "list") {
					const messages = context.getMessages(50);
					if (messages.length === 0) return ok("消息流为空。");
					return ok(
						messages
							.map((m) => `[${m.id}] ${m.from} → ${m.to}${m.taskId ? ` (${m.taskId})` : ""}：${m.content}`)
							.join("\n"),
					);
				}
				if (params.action === "read") {
					const unread = await context.readMessagesFor("lead");
					if (unread.length === 0) return ok("没有未读消息。");
					return ok(unread.map((m) => `[${m.id}] 来自 ${m.from}：\n${m.content}`).join("\n---\n"));
				}
				if (!params.to || !params.content) return fail("post 需要 to 和 content");
				const message = await context.postMessage("lead", params.to, params.content, params.task_id);
				return ok(`已发送 ${message.id} → ${params.to}`);
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
		},
	});

	for (const tool of [planTool, rolesTool, dispatchTool, reviewTool, progressTool, resumeTool, leadMessageTool]) {
		pi.registerTool(tool);
	}
}

interface VerdictEntry {
	artifact_id: string;
	approved: boolean;
	notes: string;
}

/** Extract the last ```json verdicts block from reviewer output. */
function parseVerdicts(output: string): VerdictEntry[] {
	const matches = [...output.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)];
	for (let i = matches.length - 1; i >= 0; i--) {
		try {
			const parsed = JSON.parse(matches[i][1]) as { verdicts?: unknown };
			if (Array.isArray(parsed.verdicts)) {
				return parsed.verdicts.filter(
					(v): v is VerdictEntry =>
						v !== null &&
						typeof v === "object" &&
						typeof (v as VerdictEntry).artifact_id === "string" &&
						typeof (v as VerdictEntry).approved === "boolean" &&
						typeof (v as VerdictEntry).notes === "string",
				);
			}
		} catch {
			// Try the next JSON block.
		}
	}
	return [];
}
