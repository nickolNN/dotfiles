/**
 * Skill Tool — model-invoked skills for Pi.
 *
 * Pi advertises skills as name + description + path and tells the model to
 * `read` the file "when the task matches". Nothing makes that call happen:
 * there is no tool, no consequence, and the skills' own text says "call the
 * Skill tool", which does not exist here.
 *
 * This extension adds the missing tool, mirroring the shape other harnesses
 * use (OpenCode/Kilo: `skill({ id })` returning the instructions; Claude Code:
 * the `Skill` tool):
 *   - the tool description enumerates the skills, so the choice is a tool call;
 *   - an id may also be one the user named explicitly, which is how people
 *     actually invoke skills in prose;
 *   - the returned text names the skill directory, so relative references work;
 *   - a skill already loaded in this session is not pasted twice.
 *
 * PI_SKILL_ALLOW=name:name limits the list to those ids (the pipeline passes
 * its per-step allowlist; an empty value means no skills at all). Unset -
 * every discovered skill is offered. PI_SKILL_ROOTS=/a/skills:/b/skills adds
 * directories to the discovery roots.
 *
 * A limit that only shrinks the advertised list is not a limit: a step could
 * still `read` or `cat` any SKILL.md by path (one did, for a skill outside its
 * list). So while PI_SKILL_ALLOW is set, a tool call whose arguments name
 * `skills/<id>/` for an id that is not on the list is blocked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MAX_ADVERTISED_DESCRIPTION = 220;

interface Skill {
	id: string;
	name: string;
	description: string;
	filePath: string;
	dir: string;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function discoveryRoots(): string[] {
	const extra = (process.env.PI_SKILL_ROOTS ?? "")
		.split(":")
		.map((p) => p.trim())
		.filter(Boolean);
	return [
		join(agentDir(), "skills"),
		join(homedir(), ".agents", "skills"),
		join(homedir(), ".claude", "skills"),
		join(agentDir(), "npm", "node_modules", "pi-lens", "skills"),
		join(process.cwd(), ".pi", "skills"),
		join(process.cwd(), ".agents", "skills"),
		...extra,
	];
}

function frontmatterValue(head: string, key: string): string | null {
	const match = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	if (!match) return null;
	return match[1].trim().replace(/^["']|["']$/g, "");
}

function readSkill(filePath: string): Skill | null {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	if (!text.startsWith("---")) return null;
	const end = text.indexOf("\n---", 3);
	const head = end === -1 ? text : text.slice(0, end);
	if (head.includes("\ndisable-model-invocation: true")) return null;
	const dir = resolve(filePath, "..");
	const id = dir.split("/").pop() as string;
	return {
		id,
		name: frontmatterValue(head, "name") ?? id,
		description: frontmatterValue(head, "description") ?? "",
		filePath,
		dir,
	};
}

function discoverSkills(): Skill[] {
	const byId = new Map<string, Skill>();
	for (const root of discoveryRoots()) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const filePath = join(root, entry, "SKILL.md");
			try {
				if (!statSync(filePath).isFile()) continue;
			} catch {
				continue;
			}
			const skill = readSkill(filePath);
			if (skill && !byId.has(skill.id)) byId.set(skill.id, skill);
		}
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function allowList(): string[] | null {
	const raw = process.env.PI_SKILL_ALLOW;
	if (raw === undefined) return null;
	return raw
		.split(/[:,]/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function referencedSkillIds(input: Record<string, unknown>): string[] {
	const ids: string[] = [];
	const scan = (value: unknown): void => {
		if (typeof value === "string") {
			for (const match of value.matchAll(/skills\/([A-Za-z0-9_.-]+)\//g)) ids.push(match[1]);
		} else if (Array.isArray(value)) {
			for (const item of value) scan(item);
		}
	};
	for (const value of Object.values(input)) scan(value);
	return ids;
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function describeTool(skills: Skill[]): string {
	const lines = [
		"Load a specialized skill's instructions and resources into the conversation when the task at hand matches its description.",
		"",
		"The id must match an available skill or a skill the user explicitly named. Prefer calling this over reading a SKILL.md with read.",
	];
	if (skills.length === 0) {
		lines.push("", "No skills are currently available.");
		return lines.join("\n");
	}
	lines.push("", "Available skills:");
	for (const skill of skills) {
		lines.push(`- ${skill.id} — ${truncate(skill.description, MAX_ADVERTISED_DESCRIPTION)}`);
	}
	return lines.join("\n");
}

function resolveId(skills: Skill[], raw: string): Skill | null {
	const wanted = raw.trim().toLowerCase().replace(/^skills\//, "").replace(/\/+$/, "");
	const exact = skills.find((skill) => skill.id.toLowerCase() === wanted);
	if (exact) return exact;
	const byName = skills.find((skill) => skill.name.toLowerCase() === wanted);
	if (byName) return byName;
	const partial = skills.filter((skill) => skill.id.toLowerCase().includes(wanted));
	return partial.length === 1 ? partial[0] : null;
}

export default function skillTool(pi: ExtensionAPI) {
	const discovered = discoverSkills();
	const allow = allowList();
	const skills =
		allow === null ? discovered : discovered.filter((skill) => allow.includes(skill.id));
	const loaded = new Map<string, { name: string; dir: string }>();

	pi.on("tool_call", (event) => {
		if (allow === null) return;
		const denied = referencedSkillIds(event.input as Record<string, unknown>).find(
			(id) => !allow.includes(id) && discovered.some((skill) => skill.id === id),
		);
		if (denied === undefined) return;
		return {
			block: true,
			reason: `Skill "${denied}" is not available to this step. Available: ${allow.join(", ") || "(none)"}. Call skill(<id>) for those instead of opening another skill's file.`,
		};
	});

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: describeTool(skills),
		promptSnippet: "Load a skill's instructions into the conversation by id",
		promptGuidelines: [
			"Call skill before starting work that matches one of its listed skills — before the first edit or test, not after it.",
			"Do not open a SKILL.md with read: call skill with that id, which also records that the skill was used.",
		],
		parameters: Type.Object({
			id: Type.String({
				description: "Id of an available skill, or one the user named explicitly",
			}),
		}),

		async execute(_toolCallId, params) {
			const skill = resolveId(skills, params.id);
			if (!skill) {
				const ids = skills.map((s) => s.id).join(", ");
				return {
					content: [
						{
							type: "text" as const,
							text: `No skill matches "${params.id}". Available: ${ids || "(none)"}.`,
						},
					],
					details: { error: "unknown-skill" },
					isError: true,
				};
			}
			const already = loaded.get(skill.id);
			if (already) {
				return {
					content: [
						{
							type: "text" as const,
							text: `The instructions of "${skill.id}" are already in this conversation (skill directory: ${skill.dir}). Follow them; do not load it again.`,
						},
					],
					details: { id: skill.id, dir: skill.dir, already: true },
				};
			}
			let body: string;
			try {
				body = readFileSync(skill.filePath, "utf8");
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Unable to load skill ${skill.id}: ${String(error)}` }],
					details: { error: "read-failed" },
					isError: true,
				};
			}
			const end = body.indexOf("\n---", 3);
			const instructions = end === -1 ? body : body.slice(body.indexOf("\n", end + 1) + 1);
			loaded.set(skill.id, { name: skill.name, dir: skill.dir });
			return {
				content: [
					{
						type: "text" as const,
						text: `<skill_content name="${skill.name}" id="${skill.id}" directory="${skill.dir}">\n${instructions.trim()}\n</skill_content>\n\nPaths inside this skill resolve against ${skill.dir}.`,
					},
				],
				details: { id: skill.id, name: skill.name, dir: skill.dir },
			};
		},
	});
}