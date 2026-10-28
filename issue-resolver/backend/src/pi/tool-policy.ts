/**
 * Tool selection per run shape.
 *
 * Deny, never allow: an allowlist replaces Pi's whole selection, so any tool
 * added later (another MCP server, a new extension) would silently disappear
 * from every step. Denying what a run shape cannot use keeps that door open.
 */

/** Declarations only agents that run side by side need: they talk to siblings. */
export const ROOM_TOOL_PATTERNS: string[] = ['room_*'];

/** Extra tools of a single-agent run (no siblings to coordinate with). */
export function soloRunExcludeTools(): string[] {
  return [...ROOM_TOOL_PATTERNS];
}
