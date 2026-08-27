/**
 * Studio project context: production plan (task DAG), artifact registry,
 * message bus, and blackboard — mirrored atomically to .pi-studio/<projectId>/.
 *
 * Layout of a project directory:
 *
 *   .pi-studio/<projectId>/
 *   ├── project.json        # project meta + task DAG
 *   ├── artifacts.json      # artifact registry
 *   ├── blackboard.json     # shared project facts
 *   ├── messages.jsonl      # append-only message bus
 *   ├── media-queue.json    # managed by media/queue.ts
 *   └── assets/             # all submitted/generated files
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
	Artifact,
	ArtifactKind,
	ArtifactStatus,
	BlackboardEntry,
	PipelineStage,
	PipelineTask,
	ProjectStatus,
	ReviewDecision,
	StudioProject,
	StudioSnapshot,
	TaskStatus,
	TeamMessage,
} from "./types.ts";
import { ARTIFACT_KIND_LABELS, STAGE_LABELS, TASK_STATUS_ICONS } from "./types.ts";

export const STUDIO_DIR_NAME = ".pi-studio";

// ============================================================================
// Small utilities
// ============================================================================

export function nowIso(): string {
	return new Date().toISOString();
}

export function newId(prefix: string): string {
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function slugify(text: string, maxLength = 24): string {
	const slug = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength);
	return slug || "project";
}

export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return cleaned || "artifact";
}

/** Atomic write: write to a temp file then rename. */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
		await fs.promises.writeFile(tmp, content, "utf-8");
		try {
			await fs.promises.rename(tmp, filePath);
		} catch (error) {
			// Windows rename can fail if the target is briefly locked; fall back to copy+unlink.
			try {
				await fs.promises.copyFile(tmp, filePath);
				await fs.promises.unlink(tmp);
			} catch {
				try {
					await fs.promises.unlink(tmp);
				} catch {
					/* ignore */
				}
				throw error;
			}
		}
	});
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		return JSON.parse(content) as T;
	} catch {
		return fallback;
	}
}

// ============================================================================
// Project plan input
// ============================================================================

export interface TaskPlanInput {
	id: string;
	stage: PipelineStage;
	role: string;
	title: string;
	brief: string;
	acceptance?: string;
	dependsOn?: string[];
}

export interface ArtifactSubmitInput {
	taskId: string;
	role: string;
	name: string;
	kind: ArtifactKind;
	/** Inline text content; written to assets/ when provided */
	content?: string;
	/** Existing file inside the project dir (e.g. media output) to register */
	sourcePath?: string;
	/** Provider URL of the generated media (kept for vision review) */
	sourceUrl?: string;
	summary?: string;
}

// ============================================================================
// Studio context
// ============================================================================

export class StudioContext {
	readonly projectDir: string;
	readonly assetsDir: string;

	private project: StudioProject;
	private tasks: Map<string, PipelineTask> = new Map();
	private artifacts: Artifact[] = [];
	private messages: TeamMessage[] = [];
	private blackboard: Map<string, BlackboardEntry> = new Map();
	/** Change listeners (for UI refresh). */
	private listeners = new Set<() => void>();

	private constructor(projectDir: string, project: StudioProject) {
		this.projectDir = projectDir;
		this.assetsDir = path.join(projectDir, "assets");
		this.project = project;
	}

	// --------------------------------------------------------------------------
	// Creation / loading
	// --------------------------------------------------------------------------

	static studioRoot(cwd: string): string {
		return path.join(cwd, STUDIO_DIR_NAME);
	}

	/** Create a fresh project directory with empty state. */
	static async create(cwd: string, title: string, request: string): Promise<StudioContext> {
		const id = `${nowIso().slice(0, 10)}-${slugify(title)}`;
		let projectDir = path.join(StudioContext.studioRoot(cwd), id);
		let suffix = 2;
		while (fs.existsSync(projectDir)) {
			projectDir = path.join(StudioContext.studioRoot(cwd), `${id}-${suffix++}`);
		}
		await fs.promises.mkdir(path.join(projectDir, "assets"), { recursive: true });
		const project: StudioProject = {
			id: path.basename(projectDir),
			title,
			request,
			status: "planning",
			createdAt: nowIso(),
			updatedAt: nowIso(),
		};
		const context = new StudioContext(projectDir, project);
		await context.persistAll();
		return context;
	}

	/** Load an existing project from disk. */
	static async load(projectDir: string): Promise<StudioContext> {
		// project.json stores the project meta plus the task DAG under "tasks".
		const state = await readJsonFile<(StudioProject & { tasks?: PipelineTask[] }) | null>(
			path.join(projectDir, "project.json"),
			null,
		);
		if (!state) throw new Error(`Not a studio project directory: ${projectDir}`);
		const { tasks: taskList, ...project } = state;
		const context = new StudioContext(projectDir, project);
		for (const task of taskList ?? []) context.tasks.set(task.id, task);

		context.artifacts = await readJsonFile<Artifact[]>(path.join(projectDir, "artifacts.json"), []);
		context.blackboard = new Map(
			(await readJsonFile<BlackboardEntry[]>(path.join(projectDir, "blackboard.json"), [])).map((entry) => [
				entry.key,
				entry,
			]),
		);
		context.messages = await StudioContext.readMessages(projectDir);
		return context;
	}

	private static async readMessages(projectDir: string): Promise<TeamMessage[]> {
		const messagesPath = path.join(projectDir, "messages.jsonl");
		try {
			const content = await fs.promises.readFile(messagesPath, "utf-8");
			const messages: TeamMessage[] = [];
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					messages.push(JSON.parse(trimmed) as TeamMessage);
				} catch {
					/* skip corrupt line */
				}
			}
			return messages;
		} catch {
			return [];
		}
	}

	/** Discover resumable projects under a cwd (newest first). */
	static async listProjects(cwd: string): Promise<Array<{ dir: string; project: StudioProject }>> {
		const root = StudioContext.studioRoot(cwd);
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(root, { withFileTypes: true });
		} catch {
			return [];
		}
		const projects: Array<{ dir: string; project: StudioProject }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const project = await readJsonFile<StudioProject | null>(path.join(root, entry.name, "project.json"), null);
			if (project) projects.push({ dir: path.join(root, entry.name), project });
		}
		projects.sort((a, b) => b.project.createdAt.localeCompare(a.project.createdAt));
		return projects;
	}

	// --------------------------------------------------------------------------
	// Accessors
	// --------------------------------------------------------------------------

	getProject(): StudioProject {
		return { ...this.project };
	}

	get projectId(): string {
		return this.project.id;
	}

	getTask(id: string): PipelineTask | undefined {
		const task = this.tasks.get(id);
		return task ? { ...task } : undefined;
	}

	getTasks(): PipelineTask[] {
		return Array.from(this.tasks.values()).map((task) => ({ ...task }));
	}

	getArtifacts(): Artifact[] {
		return this.artifacts.map((artifact) => ({ ...artifact }));
	}

	getArtifact(id: string): Artifact | undefined {
		const artifact = this.artifacts.find((a) => a.id === id);
		return artifact ? { ...artifact } : undefined;
	}

	/** Artifacts produced by a task (latest first). */
	artifactsForTask(taskId: string): Artifact[] {
		return this.artifacts.filter((a) => a.taskId === taskId).reverse();
	}

	/** Artifacts of the given kinds, newest first. */
	artifactsOfKind(...kinds: ArtifactKind[]): Artifact[] {
		return this.artifacts.filter((a) => kinds.includes(a.kind)).reverse();
	}

	/** Absolute path for a project-relative path. */
	resolve(relPath: string): string {
		return path.resolve(this.projectDir, relPath);
	}

	// --------------------------------------------------------------------------
	// Planning
	// --------------------------------------------------------------------------

	/** Replace the task DAG. Validates ids/dependencies before applying. */
	async plan(
		title: string,
		brief: string,
		taskInputs: TaskPlanInput[],
	): Promise<{ tasks: PipelineTask[]; errors: string[] }> {
		const errors: string[] = [];
		const ids = new Set(taskInputs.map((t) => t.id));
		if (taskInputs.length === 0) errors.push("计划为空：至少需要一个任务");
		for (const input of taskInputs) {
			if (!input.id) errors.push(`任务缺少 id: ${input.title}`);
			if (!input.role) errors.push(`任务 ${input.id} 缺少角色`);
			if (!input.brief) errors.push(`任务 ${input.id} 缺乏工作说明 (brief)`);
			for (const dep of input.dependsOn ?? []) {
				if (!ids.has(dep)) errors.push(`任务 ${input.id} 依赖了不存在的任务 ${dep}`);
			}
		}
		// Dependency cycles would deadlock dispatch; reject them here.
		const depsMap = new Map(taskInputs.map((t) => [t.id, t.dependsOn ?? []]));
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string, stack: string[]) => {
			if (visited.has(id)) return;
			if (visiting.has(id)) {
				errors.push(`依赖成环: ${[...stack, id].join(" → ")}`);
				return;
			}
			visiting.add(id);
			for (const dep of depsMap.get(id) ?? []) visit(dep, [...stack, id]);
			visiting.delete(id);
			visited.add(id);
		};
		for (const id of ids) visit(id, []);

		if (errors.length > 0) return { tasks: this.getTasks(), errors };

		this.tasks = new Map(
			taskInputs.map((input) => [
				input.id,
				{
					id: input.id,
					stage: input.stage,
					role: input.role,
					title: input.title,
					brief: input.brief,
					acceptance: input.acceptance?.trim() || "产物完整、符合创意简报与角色规范",
					dependsOn: input.dependsOn ?? [],
					status: "pending" as TaskStatus,
					attempts: 0,
					reviewFeedback: [],
				},
			]),
		);
		this.project.title = title || this.project.title;
		this.project.brief = brief || this.project.brief;
		this.project.status = "in_production";
		await this.persistProject();
		this.notifyChanged();
		return { tasks: this.getTasks(), errors: [] };
	}

	/** Tasks whose dependencies are all completed and that are dispatchable. */
	readyTasks(): PipelineTask[] {
		return this.getTasks().filter((task) => {
			if (task.status !== "pending" && task.status !== "reopened" && task.status !== "failed") return false;
			return task.dependsOn.every((dep) => this.tasks.get(dep)?.status === "completed");
		});
	}

	/** Tasks grouped into topological waves (for display only). */
	waves(): PipelineTask[][] {
		const waves: PipelineTask[][] = [];
		const done = new Set<string>();
		let remaining = this.getTasks();
		while (remaining.length > 0) {
			const wave = remaining.filter((task) => task.dependsOn.every((dep) => done.has(dep)));
			if (wave.length === 0) {
				waves.push(remaining); // cycle guard (plan() rejects cycles anyway)
				break;
			}
			waves.push(wave);
			for (const task of wave) done.add(task.id);
			remaining = remaining.filter((task) => !done.has(task.id));
		}
		return waves;
	}

	async updateTask(id: string, patch: Partial<PipelineTask>): Promise<PipelineTask | undefined> {
		const task = this.tasks.get(id);
		if (!task) return undefined;
		Object.assign(task, patch);
		if (patch.status === "running") task.dispatchedAt = nowIso();
		if (patch.status === "completed") task.completedAt = nowIso();
		await this.persistProject();
		this.notifyChanged();
		return { ...task };
	}

	// --------------------------------------------------------------------------
	// Artifacts
	// --------------------------------------------------------------------------

	async submitArtifact(input: ArtifactSubmitInput): Promise<Artifact> {
		const kindDir = path.join("assets", input.kind);
		await fs.promises.mkdir(path.join(this.assetsDir, input.kind), { recursive: true });

		let relPath: string;
		if (input.sourcePath) {
			const absoluteSource = path.resolve(this.projectDir, input.sourcePath);
			if (!absoluteSource.startsWith(path.resolve(this.projectDir))) {
				throw new Error(`产物路径越界: ${input.sourcePath}`);
			}
			relPath = path.relative(this.projectDir, absoluteSource);
		} else {
			const fileName = `${sanitizeFileName(input.name)}-${newId("a")}${
				input.kind === "storyboard" || input.kind === "visual-bible" || input.kind === "report"
					? ".md"
					: input.kind === "script" || input.kind === "brief"
						? ".md"
						: ".txt"
			}`;
			relPath = path.join(kindDir, fileName);
			const absolute = path.join(this.projectDir, relPath);
			await atomicWriteFile(absolute, input.content ?? "");
		}

		const artifact: Artifact = {
			id: newId("art"),
			taskId: input.taskId,
			role: input.role,
			name: input.name,
			path: relPath.split(path.sep).join("/"),
			kind: input.kind,
			summary: input.summary,
			...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
			status: "submitted",
			submittedAt: nowIso(),
		};
		this.artifacts.push(artifact);
		await this.persistArtifacts();
		this.notifyChanged();
		return { ...artifact };
	}

	async setArtifactStatus(id: string, status: ArtifactStatus, comments?: string): Promise<Artifact | undefined> {
		const artifact = this.artifacts.find((a) => a.id === id);
		if (!artifact) return undefined;
		artifact.status = status;
		if (comments !== undefined) artifact.reviewComments = comments;
		await this.persistArtifacts();
		this.notifyChanged();
		return { ...artifact };
	}

	/** Read an artifact's text content (media files return a path note). */
	async readArtifact(id: string): Promise<string> {
		const artifact = this.artifacts.find((a) => a.id === id);
		if (!artifact) throw new Error(`产物不存在: ${id}`);
		const absolute = this.resolve(artifact.path);
		const stat = await fs.promises.stat(absolute).catch(() => undefined);
		if (!stat) throw new Error(`产物文件缺失: ${artifact.path}`);
		if (stat.size > 200_000) {
			return `产物 ${artifact.name}（${artifact.path}，${Math.round(stat.size / 1024)}KB）过大，请用 read 工具按需读取。`;
		}
		const content = await fs.promises.readFile(absolute, "utf-8").catch(() => undefined);
		if (content === undefined) {
			return `产物 ${artifact.name} 是二进制文件: ${artifact.path}`;
		}
		return content;
	}

	// --------------------------------------------------------------------------
	// Message bus
	// --------------------------------------------------------------------------

	async postMessage(from: string, to: string, content: string, taskId?: string): Promise<TeamMessage> {
		const message: TeamMessage = {
			id: newId("msg"),
			from,
			to,
			content,
			taskId,
			sentAt: nowIso(),
			readBy: from === "system" ? [] : [from],
		};
		this.messages.push(message);
		await withFileMutationQueue(path.join(this.projectDir, "messages.jsonl"), async () => {
			await fs.promises.appendFile(
				path.join(this.projectDir, "messages.jsonl"),
				`${JSON.stringify(message)}\n`,
				"utf-8",
			);
		});
		this.notifyChanged();
		return { ...message };
	}

	/** Unread messages addressed to a role (marks them read). */
	async readMessagesFor(role: string): Promise<TeamMessage[]> {
		const unread = this.messages.filter(
			(m) => (m.to === role || m.to === "all") && m.from !== role && !m.readBy.includes(role),
		);
		if (unread.length === 0) return [];
		for (const message of unread) message.readBy.push(role);
		await this.persistMessages();
		return unread.map((m) => ({ ...m }));
	}

	getMessages(limit?: number): TeamMessage[] {
		const messages = [...this.messages];
		return limit === undefined ? messages : messages.slice(-limit);
	}

	private async persistMessages(): Promise<void> {
		const lines = this.messages.map((m) => JSON.stringify(m)).join("\n");
		await atomicWriteFile(path.join(this.projectDir, "messages.jsonl"), `${lines}\n`);
	}

	// --------------------------------------------------------------------------
	// Blackboard
	// --------------------------------------------------------------------------

	getBlackboard(): BlackboardEntry[] {
		return Array.from(this.blackboard.values());
	}

	async writeBlackboard(role: string, key: string, value: string): Promise<BlackboardEntry> {
		const entry: BlackboardEntry = { key, value, updatedBy: role, updatedAt: nowIso() };
		this.blackboard.set(key, entry);
		await this.persistBlackboard();
		this.notifyChanged();
		return { ...entry };
	}

	// --------------------------------------------------------------------------
	// Status / snapshot
	// --------------------------------------------------------------------------

	async setProjectStatus(status: ProjectStatus): Promise<void> {
		this.project.status = status;
		this.project.updatedAt = nowIso();
		await this.persistProject();
		this.notifyChanged();
	}

	/**
	 * Record a review verdict: updates the artifact, reopens the task when
	 * rejected (feedback is replayed in the next dispatch brief).
	 */
	async applyReview(
		artifactId: string,
		decision: ReviewDecision,
		comments: string,
	): Promise<{ artifact?: Artifact; task?: PipelineTask }> {
		const artifact = await this.setArtifactStatus(
			artifactId,
			decision === "approved" ? "approved" : "rejected",
			comments,
		);
		let task: PipelineTask | undefined;
		if (artifact && decision === "rejected") {
			task = await this.updateTask(artifact.taskId, {
				status: "reopened",
				reviewFeedback: [...(this.tasks.get(artifact.taskId)?.reviewFeedback ?? []), `审校意见: ${comments}`],
			});
		}
		return { artifact, task };
	}

	/** Compact text board for the lead tools and /studio fallback display. */
	progressSummary(): string {
		const lines: string[] = [];
		const project = this.getProject();
		lines.push(`项目「${project.title}」（${project.id}，${project.status}）`);
		if (project.brief) lines.push(`需求：${project.brief.slice(0, 160)}`);
		lines.push("");

		const tasks = this.getTasks();
		if (tasks.length === 0) lines.push("（任务板为空）");
		for (const wave of this.waves()) {
			for (const task of wave) {
				const deps = task.dependsOn.length > 0 ? `（依赖 ${task.dependsOn.join(",")}）` : "";
				const feedback = task.reviewFeedback.length > 0 ? ` ⚠ 反馈×${task.reviewFeedback.length}` : "";
				lines.push(
					`${TASK_STATUS_ICONS[task.status]} ${task.id} [${STAGE_LABELS[task.stage]}] ${task.title} → ${task.role}${deps}${feedback}`,
				);
			}
		}

		const artifacts = this.getArtifacts();
		if (artifacts.length > 0) {
			lines.push("");
			lines.push("产物：");
			for (const artifact of artifacts) {
				const review = artifact.reviewComments ? `（审校：${artifact.reviewComments.slice(0, 80)}）` : "";
				lines.push(
					`${artifact.status === "approved" ? "✓" : artifact.status === "rejected" ? "✗" : "…"} ${artifact.id} ${ARTIFACT_KIND_LABELS[artifact.kind]}《${artifact.name}》→ ${artifact.path}${review}`,
				);
			}
		}
		const ready = this.readyTasks();
		if (ready.length > 0) {
			lines.push("");
			lines.push(`可分派：${ready.map((t) => t.id).join(", ")}`);
		}
		return lines.join("\n");
	}

	/** Board snapshot (media + roles filled in by the runtime). */
	snapshot(): Omit<StudioSnapshot, "media" | "roles"> {
		return {
			project: { ...this.project },
			tasks: this.getTasks(),
			artifacts: this.getArtifacts(),
			messages: this.getMessages(),
			blackboard: this.getBlackboard(),
		};
	}

	// --------------------------------------------------------------------------
	// Change notification
	// --------------------------------------------------------------------------

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notifyChanged(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* listener errors must not break state updates */
			}
		}
	}

	// --------------------------------------------------------------------------
	// Persistence
	// --------------------------------------------------------------------------

	private async persistProject(): Promise<void> {
		this.project.updatedAt = nowIso();
		const payload = { ...this.project, tasks: this.getTasks() };
		await atomicWriteFile(path.join(this.projectDir, "project.json"), `${JSON.stringify(payload, null, "\t")}\n`);
	}

	private async persistArtifacts(): Promise<void> {
		await atomicWriteFile(
			path.join(this.projectDir, "artifacts.json"),
			`${JSON.stringify(this.artifacts, null, "\t")}\n`,
		);
	}

	private async persistBlackboard(): Promise<void> {
		await atomicWriteFile(
			path.join(this.projectDir, "blackboard.json"),
			`${JSON.stringify(this.getBlackboard(), null, "\t")}\n`,
		);
	}

	private async persistAll(): Promise<void> {
		await Promise.all([this.persistProject(), this.persistArtifacts(), this.persistBlackboard()]);
	}
}
