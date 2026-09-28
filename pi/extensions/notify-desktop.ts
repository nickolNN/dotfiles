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
 * "Pi needs you" is a persistent alert (stays until dismissed). It is
 * sent with `deferIfFocused`, so the bridge shows it right away only when the
 * room is NOT on screen; a focused room gets a grace period
 * (PI_NOTIFY_ALERT_DELAY_MS, default 2 min) and is alerted only if the user
 * hasn't answered by then (`ui_prompt_end` cancels the pending alert).
 * "Pi finished" is an auto-dismissing banner with no buttons.
 *
 * On the host, the tmux session owning this Pi is recorded under
 * ~/.pi-notify so the bridge can attach and judge focus (containers record it
 * from spawn-pi-agent.sh instead).
 *
 * Message bodies are flattened from markdown to plain text BEFORE trimming,
 * so truncation can never strand a `**bold**`, `[link]`, `]`, `)`, or other
 * markdown fragment.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PI_NOTIFY_PORT || 49151);
const IN_CONTAINER = existsSync("/.dockerenv");
const ALERT_DELAY_MS = Math.max(
  0,
  Number(process.env.PI_NOTIFY_ALERT_DELAY_MS || 120_000),
);

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

/**
 * On the host, record the tmux session that owns this Pi so the bridge can
 * offer Attach and judge focus. A no-op when not inside tmux; containers
 * record their session from spawn-pi-agent.sh instead.
 */
function recordHostTmuxSession(label: string): void {
  if (IN_CONTAINER || !process.env.TMUX) return;
  try {
    const session = execFileSync(
      "tmux",
      ["display-message", "-p", "#{session_name}"],
      { encoding: "utf8", timeout: 2000 },
    ).trim();
    if (!session) return;
    const dir = `${process.env.HOME || ""}/.pi-notify`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${label}.attach`, `${session}\n`);
  } catch {
    /* not in tmux / tmux absent — Attach and focus simply stay unavailable */
  }
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

/**
 * Post to the bridge. Returns the reply body ("shown"/"deferred" for alerts,
 * "" otherwise, including on any failure) — best-effort, never throws.
 */
async function notify(
  title: string,
  message: string,
  style: "notification" | "alert" = "notification",
  room = "",
  extra: Record<string, unknown> = {},
): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${baseUrl()}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, message, style, room, ...extra }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (await res.text()).trim();
  } catch {
    // A notification failure must never affect the agent.
    return "";
  }
}

export default function (pi: ExtensionAPI): void {
  const label = sourceLabel();
  recordHostTmuxSession(label);

  let lastAssistantText = "";
  let alertTimer: ReturnType<typeof setTimeout> | null = null;

  const clearAlertTimer = () => {
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = null;
  };

  const prefixed = (t: string): string =>
    label && label !== "host" && label !== "container" ? `${label} · ${t}` : t;

  // Multi-line detail for the blocking alert: what Pi is asking, the tail of
  // its last message (the context that led here), and where it's waiting.
  const alertMessage = (heading: string, waitedMs: number): string => {
    const lines = [heading];
    const context = summarize(lastAssistantText, 160);
    if (context) lines.push(context);
    const waited =
      waitedMs >= 60_000 ? `${Math.round(waitedMs / 60_000)}m` : "now";
    lines.push(`cwd ${path.basename(process.cwd())} · waiting ${waited}`);
    return lines.join("\n");
  };

  pi.on("message_end", (event: any) => {
    if (event?.message?.role === "assistant") {
      const text = extractText(event.message.content);
      if (text) lastAssistantText = text;
    }
  });

  pi.on("agent_settled", async () => {
    const title = prefixed("Pi finished");
    await notify(
      title,
      summarize(lastAssistantText) || "Pi is idle.",
      "notification",
      label,
    );
    lastAssistantText = "";
  });

  pi.on("ui_prompt_start", async (event: any) => {
    clearAlertTimer();
    const heading =
      summarize([event?.title, event?.kind].filter(Boolean).join(" · "), 120) ||
      "Waiting for input";
    const title = prefixed(heading || "Pi needs you");
    const startedAt = Date.now();

    const outcome = await notify(
      title,
      alertMessage(heading, 0),
      "alert",
      label,
      {
        deferIfFocused: true,
      },
    );
    // "deferred" means the room was on screen: retry after the grace period
    // unless the user answers first (ui_prompt_end).
    if (outcome === "deferred") {
      alertTimer = setTimeout(() => {
        alertTimer = null;
        notify(
          title,
          alertMessage(heading, Date.now() - startedAt),
          "alert",
          label,
        );
      }, ALERT_DELAY_MS);
      alertTimer.unref?.();
    }
  });

  pi.on("ui_prompt_end", () => clearAlertTimer());
}
