/**
 * Role discovery: loads the 10 studio role definitions from roles/*.md.
 *
 * Each role file uses YAML frontmatter:
 *
 *   ---
 *   name: art-director          # stable role id
 *   label: 艺术总监              # display label
 *   description: 创意简报与风格定调
 *   tools: read, write, bash    # optional built-in tool whitelist
 *   model: anthropic/claude-... # optional model binding override
 *   ---
 *
 * The markdown body is the role system prompt (职责 / 产物模板 / 协作协议).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { RoleConfig } from "./core/types.ts";

export const ROLES_DIR = path.join(dirname(fileURLToPath(import.meta.url)), "roles");

type RoleFrontmatter = {
	name?: unknown;
	label?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Load all role definitions from a directory (silently skips invalid files). */
export function loadRolesFromDir(dir: string): RoleConfig[] {
	const roles: RoleConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return roles;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<RoleFrontmatter>(content);
		const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
		if (!name || !body.trim()) continue;
		roles.push({
			name,
			label: typeof frontmatter.label === "string" ? frontmatter.label : name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : `studio role ${name}`,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body.trim(),
			filePath,
		});
	}
	return roles;
}

/** Discover all studio roles (extension-shipped roles directory). */
export function discoverRoles(_cwd: string): RoleConfig[] {
	return loadRolesFromDir(ROLES_DIR);
}

export function findRole(roles: RoleConfig[], name: string): RoleConfig | undefined {
	return roles.find((role) => role.name === name);
}

/** Format the role roster for the lead's planning prompt. */
export function roleListText(roles: RoleConfig[]): string {
	return roles.map((role) => `- ${role.name}（${role.label}）: ${role.description}`).join("\n");
}
