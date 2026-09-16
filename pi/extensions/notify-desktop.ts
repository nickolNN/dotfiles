// @ts-nocheck
/**
 * Desktop notifications for Pi.
 *
 * Host session:  auto-loaded from ~/.config/pi/extensions/, posts to the
 *                loopback bridge (127.0.0.1).
 * Container:     baked from pi/extensions/ into the dotfiles-agent image,
 *                posts to the host bridge via Docker Desktop's
 *                `host.docker.internal` (forwards to the host loopback).
 *
 * Every notification is labelled with its source: the room name (folder
 * basename) inside a container, or "host" for a host session. Override with
 * PI_NOTIFY_LABEL, PI_NOTIFY_URL, and PI_NOTIFY_PORT.
 *
 * "Pi needs you" is sent as a persistent alert (stays until dismissed; the
 * bridge can offer an "Attach" button to hop back to the room's tmux
 * session). "Pi finished" is an auto-dismissing banner with no buttons.
 *
 * Message bodies are flattened from markdown to plain text BEFORE trimming,
 * so truncation can never strand a `**bold**`, `[link]`, `]`, `)`, or other
 * markdown fragment.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";

const PORT = Number(process.env.PI_NOTIFY_PORT || 49151);
const IN_CONTAINER = existsSync("/.dockerenv");

function baseUrl(): string {
  const env = process.env.PI_NOTIFY_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const host = IN_CONTAINER ? "host.docker.internal" : "127.0.0.1";
  return `http://${host}:${PORT}`;
}

function sourceLabel(): string {
  const env = process.env.PI_NOTIFY_LABEL?.trim();
  if (env) return env;
  if (!IN_CONTAINER) return "host";
  try {
    const cfg = JSON.parse(
      readFileSync(
        `${process.env.HOME || "/home/agent"}/.pi/agent/rooms/config.json`,
        "utf8",
      ),
    );
    if (typeof cfg?.defaultRoom === "string" && cfg.defaultRoom.trim()) {
      return cfg.defaultRoom.trim();
    }
  } catch {
    /* no persisted room */
  }
  return "container";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof (block as { text?: unknown } | null)?.text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join(" ").trim();
  }
  return "";
}

/**
 * Flatten common markdown to plain text. macOS notifications can't render
 * rich text, so this removes the syntax rather than trying to map it. Runs
 * on the FULL body before trimming.
 */
function toPlainText(md: string): string {
  return md
    .replace(/```[^\n]*[\s\S]*?```/g, " ")
    .replace(/(^|[\s(])`([^`]+)`/g, "$1$2")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^\s*\|?[\s\-:|]+\|?\s*$/gm, " ")
    .replace(/^\s*\|/gm, "")
    .replace(/\|\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Trim to a word boundary without leaving dangling punctuation/quotes/
 * brackets at the cut, then append an ellipsis.
 */
function truncatePlain(plain: string, max = 140): string {
  const flat = plain.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const atBoundary = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  const cleaned = atBoundary.replace(/[\s,;:.!?()[\]{}<>"'«»…–—-]+$/u, "");
  return `${cleaned}…`;
}

function summarize(md: string, max = 140): string {
  return truncatePlain(toPlainText(md), max);
}

async function notify(
  title: string,
  message: string,
  style: "notification" | "alert" = "notification",
  room = "",
): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    await fetch(`${baseUrl()}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, message, style, room }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    // Best-effort only; a notification failure must never affect the agent.
  }
}

export default function (pi: ExtensionAPI): void {
  const label = sourceLabel();
  let lastAssistantText = "";

  pi.on("message_end", (event: any) => {
    if (event?.message?.role === "assistant") {
      const text = extractText(event.message.content);
      if (text) lastAssistantText = text;
    }
  });

  pi.on("agent_settled", async () => {
    const title = `${label} · Pi finished`;
    await notify(
      title,
      summarize(lastAssistantText) || "Pi is idle.",
      "notification",
      label,
    );
    lastAssistantText = "";
  });

  pi.on("ui_prompt_start", async (event: any) => {
    const reason = summarize(
      [event?.title, event?.kind].filter(Boolean).join(" · "),
      120,
    );
    const title = `${label} · Pi needs you`;
    await notify(title, reason || "Waiting for input…", "alert", label);
  });
}
