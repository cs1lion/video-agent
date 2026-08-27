/**
 * Shared types for the studio multi-agent video production system.
 */

// ============================================================================
// Pipeline stages
// ============================================================================

export const PIPELINE_STAGES = [
	"brief",
	"script",
	"visual",
	"direction",
	"storyboard",
	"shots",
	"audio",
	"edit",
	"delivery",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<PipelineStage, string> = {
	brief: "创意简报",
	script: "剧本",
	visual: "美术设计",
	direction: "镜头阐述",
	storyboard: "分镜表",
	shots: "镜头生成",
	audio: "音频制作",
	edit: "剪辑成片",
	delivery: "交付",
};

// ============================================================================
// Roles
// ============================================================================

/** A studio role definition parsed from roles/*.md */
export interface RoleConfig {
	/** Stable role id, e.g. "art-director" (frontmatter name) */
	name: string;
	/** Short description shown to the lead when planning */
	description: string;
	/** Display label, e.g. "艺术总监" (frontmatter label, defaults to name) */
	label: string;
	/** Built-in tool whitelist for the role session (read/bash/...) */
	tools?: string[];
	/** Bound model spec "provider/model-id" (frontmatter) */
	model?: string;
	/** Full role system prompt (markdown body) */
	systemPrompt: string;
	/** Absolute path of the source file */
	filePath: string;
}

// ============================================================================
// Project / Tasks
// ============================================================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "reopened" | "blocked";

export const TASK_STATUS_ICONS: Record<TaskStatus, string> = {
	pending: "○",
	running: "◐",
	completed: "✓",
	failed: "✗",
	reopened: "↻",
	blocked: "⊘",
};

export type ProjectStatus = "planning" | "in_production" | "review" | "delivered";

/** A node in the production pipeline DAG. */
export interface PipelineTask {
	id: string;
	/** Pipeline stage (for board grouping) */
	stage: PipelineStage;
	/** Assigned role id */
	role: string;
	title: string;
	/** What the role should do */
	brief: string;
	/** Acceptance criteria used by the review gate */
	acceptance: string;
	/** Task ids that must complete before this one can be dispatched */
	dependsOn: string[];
	status: TaskStatus;
	attempts: number;
	/** Latest completion note written by the role or lead */
	summary?: string;
	/** Block reason (when status === "blocked") */
	blockedReason?: string;
	/** Accumulated reviewer feedback, replayed on re-dispatch */
	reviewFeedback: string[];
	dispatchedAt?: string;
	completedAt?: string;
}

export interface StudioProject {
	id: string;
	title: string;
	/** The user's original one-line request */
	request: string;
	/** The lead's interpretation of the request (creative direction) */
	brief?: string;
	status: ProjectStatus;
	createdAt: string;
	updatedAt: string;
}

// ============================================================================
// Artifacts
// ============================================================================

export type ArtifactStatus = "submitted" | "approved" | "rejected";

export const ARTIFACT_STATUS_ICONS: Record<ArtifactStatus, string> = {
	submitted: "…",
	approved: "✓",
	rejected: "✗",
};

export type ArtifactKind =
	| "brief"
	| "script"
	| "visual-bible"
	| "shot-list"
	| "storyboard"
	| "image"
	| "video"
	| "audio"
	| "music"
	| "final-cut"
	| "report"
	| "other";

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
	brief: "创意简报",
	script: "剧本",
	"visual-bible": "美术设计",
	"shot-list": "镜头阐述",
	storyboard: "分镜表",
	image: "设定图",
	video: "镜头视频",
	audio: "配音",
	music: "配乐",
	"final-cut": "成片",
	report: "制作报告",
	other: "其他",
};

/** A registered production artifact with quality state. */
export interface Artifact {
	id: string;
	taskId: string;
	/** Producing role id */
	role: string;
	/** Display name */
	name: string;
	/** Path relative to the project directory */
	path: string;
	kind: ArtifactKind;
	summary?: string;
	/** Provider URL of the generated media (for remote vision review) */
	sourceUrl?: string;
	status: ArtifactStatus;
	/** Latest review comments (from 审校 or lead) */
	reviewComments?: string;
	submittedAt: string;
}

// ============================================================================
// Message bus (mesh collaboration)
// ============================================================================

export interface TeamMessage {
	id: string;
	/** Role id, "lead", or "system" */
	from: string;
	/** Role id or "all" */
	to: string;
	content: string;
	taskId?: string;
	sentAt: string;
	/** Role ids that have read this message */
	readBy: string[];
}

// ============================================================================
// Blackboard (shared project facts)
// ============================================================================

export interface BlackboardEntry {
	key: string;
	value: string;
	updatedBy: string;
	updatedAt: string;
}

// ============================================================================
// Media generation
// ============================================================================

export type MediaKind = "video" | "image" | "tts" | "music";

// ============================================================================
// Run results
// ============================================================================

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** Live event streamed from a role session (for dispatch progress display). */
export type RoleRunEvent =
	| { type: "text"; text: string }
	| { type: "message"; text: string }
	| { type: "tool_call"; name: string; args: Record<string, unknown> };

/** Result of one role session run. */
export interface RoleRunResult {
	/** Role id */
	role: string;
	/** Task board id when dispatched from the plan */
	taskId?: string;
	/** Whether the session finished without error/abort */
	ok: boolean;
	/** Final assistant text (the role's report to the lead) */
	output: string;
	usage: UsageTotals;
	error?: string;
}

export type ReviewDecision = "approved" | "rejected";

/** Snapshot of one role session, for live progress display. */
export interface RoleActivity {
	role: string;
	label: string;
	status: "idle" | "running";
	/** Current task id when running */
	taskId?: string;
	/** Last activity line (tool call or text preview) */
	activity: string;
	usage: UsageTotals;
}

/** Board snapshot for UI rendering. */
export interface StudioSnapshot {
	project: StudioProject;
	tasks: PipelineTask[];
	artifacts: Artifact[];
	messages: TeamMessage[];
	blackboard: BlackboardEntry[];
	media: {
		queued: number;
		running: number;
		done: number;
		failed: number;
	};
	roles: RoleActivity[];
}
