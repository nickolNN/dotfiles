import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, relative } from "node:path";

const CONFIG_ROOT = resolve(process.env.HOME || "/home/agent", ".config");

/**
 * Host Pi permissions — only allow:
 * 1. Reading files anywhere
 * 2. Writing/editing files inside ~/.config
 * 3. Web-search MCP tools
 * 4. Asking the user questions
 * 5. Bash (write/edit guard already covers file damage)
 */
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName;

    // ── Always allowed ──────────────────────────────────────────
    const alwaysAllowed = new Set([
      "read",
      "question",
      "web_search",
      "web_fetch",
      "mcp",
      "mcpScript",
    ]);
    if (alwaysAllowed.has(name)) return;

    // ── Write/Edit — only in ~/.config ──────────────────────────
    if (name === "write" || name === "edit") {
      if (isToolCallEventType(name, event)) {
        const path = (event.input as { path?: string }).path;
        if (path && isInsideConfig(path)) return;
      }
      return {
        block: true,
        reason: `Host Pi can only write/edit files inside ~/.config`,
      };
    }

    // ── Bash — warn, but allow (write/edit guard already protects) ──
    if (name === "bash") return;

    // ── Everything else blocked ─────────────────────────────────
    return {
      block: true,
      reason: `Host Pi is restricted to .config file changes + web-search. Tool "${name}" is blocked.`,
    };
  });
}

function isInsideConfig(filePath: string): boolean {
  try {
    return !relative(CONFIG_ROOT, resolve(filePath)).startsWith("..");
  } catch {
    return false;
  }
}
