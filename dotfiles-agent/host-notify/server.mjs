// Desktop-notification bridge for Pi running in containers.
//
// Host macOS process. `POST /notify` renders:
//   - style "notification" (default): a Notification Center banner that
//     auto-dismisses (used for "Pi finished") — no buttons, no click action.
//   - style "alert": a persistent modal (used for "Pi needs you").
//
// Alerts may carry `deferIfFocused: true`: when the room's tmux session is
// on screen (Alacritty frontmost AND the session has an attached client) the
// bridge replies "deferred" and shows nothing, so the caller can re-send
// (force) after a grace period. That keeps a session the user is actively
// watching from getting a modal the instant Pi asks a question, while an
// unfocused room still warns immediately. The reply body is "shown" or
// "deferred"; banners just reply 204.
//
// Accepted requests are logged to stdout (→ /tmp/pi-notify.log under launchd).
//
// Env: PI_NOTIFY_PORT (default 49151), PI_NOTIFY_BIND (default 127.0.0.1).

import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.PI_NOTIFY_PORT || 49151);
const HOST = process.env.PI_NOTIFY_BIND || "127.0.0.1";
const MAX_BODY = 64 * 1024;

// launchd starts agents with a minimal PATH that (on Apple Silicon) omits
// Homebrew, so resolving tmux/alacritty by name would fail. Probe the usual
// install dirs (+ PATH) once per binary.
const BIN_DIRS = [
  ...(process.env.PATH || "").split(":").filter(Boolean),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];
const BIN_CACHE = new Map();
function binPath(name) {
  if (BIN_CACHE.has(name)) return BIN_CACHE.get(name);
  let found = name;
  for (const dir of BIN_DIRS) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      found = candidate;
      break;
    }
  }
  BIN_CACHE.set(name, found);
  return found;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000, ...opts }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout).trim()),
    );
  });
}

function appleEscape(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function appleSafe(value, max = 500) {
  return appleEscape(value)
    .slice(0, max)
    .replace(/[\r\n]+/g, " ");
}

// `display alert` message as an AppleScript expression: line breaks become
// `& return &` so multi-line detail survives (AppleScript string literals
// can't contain raw newlines).
function appleAlertMessage(value, max = 700) {
  const parts = String(value ?? "")
    .slice(0, max)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (parts.length === 0) return '""';
  return parts.map((line) => `"${appleEscape(line)}"`).join(" & return & ");
}

function scriptFor(title, message, style, buttons) {
  if (style === "alert") {
    const list = buttons.map((b) => `"${b}"`).join(", ");
    return (
      `display alert "${appleSafe(title, 120)}" ` +
      `message (${appleAlertMessage(message)}) ` +
      `buttons {${list}} default button "OK"`
    );
  }
  return (
    `display notification "${appleSafe(message)}" ` +
    `with title "${appleSafe(title, 200)}"`
  );
}

function show(title, message, style, buttons) {
  const script = scriptFor(title, message, style, buttons);
  // Banners return immediately; alerts block until dismissed, so alerts get
  // no timeout and persist for as long as the user needs.
  const options = style === "alert" ? {} : { timeout: 5000 };
  return new Promise((resolve, reject) => {
    // Alerts resolve with the clicked button name (osascript stdout);
    // banners resolve with "".
    execFile(binPath("osascript"), ["-e", script], options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || "");
    });
  });
}

const VER_FLAG = { tmux: "-V", alacritty: "--version" };
const BIN_EXISTS = new Map();
function binExists(cmd) {
  if (!BIN_EXISTS.has(cmd)) {
    BIN_EXISTS.set(
      cmd,
      new Promise((resolve) => {
        execFile(
          binPath(cmd),
          [VER_FLAG[cmd] || "-V"],
          { timeout: 3000 },
          (err) => resolve(!err),
        );
      }),
    );
  }
  return BIN_EXISTS.get(cmd);
}

async function attachFor(room) {
  const label = String(room ?? "").trim();
  if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) return null;
  const file = path.join(homedir(), ".pi-notify", `${label}.attach`);
  let session;
  try {
    session = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  if (!session) return null;
  if (!(await binExists("tmux"))) return null;
  if (!(await binExists("alacritty"))) return null;
  return { session };
}

// Is the room's terminal the one the user is looking at? Heuristic: Alacritty
// must be the frontmost app AND the room's tmux session must have an attached
// client. Unknown (no attach file / no tmux) counts as focused, which errs
// toward deferring rather than interrupting.
async function frontmostApp() {
  try {
    const asn = await run(binPath("lsappinfo"), ["front"]);
    if (!asn) return "";
    const info = await run(binPath("lsappinfo"), [
      "info",
      "-only",
      "name",
      asn,
    ]);
    const name = info.match(/"([^"]+)"/);
    return name ? name[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

async function roomFocused(room) {
  const attach = await attachFor(room);
  if (!attach) return true;
  if ((await frontmostApp()) !== "alacritty") return false;
  try {
    const clients = await run(binPath("tmux"), [
      "list-clients",
      "-t",
      attach.session,
      "-F",
      "#{client_tty}",
    ]);
    return clients.length > 0;
  } catch {
    return true;
  }
}

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/notify") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      let title = "Pi";
      let message = "";
      let style = "notification";
      let room = "";
      let deferIfFocused = false;
      try {
        ({
          title = "Pi",
          message = "",
          style = "notification",
          room = "",
          deferIfFocused = false,
        } = JSON.parse(body || "{}"));
        title = String(title);
        message = String(message);
        style = String(style);
        room = String(room);
        deferIfFocused = Boolean(deferIfFocused);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad request");
        return;
      }

      console.log(
        "notify",
        JSON.stringify({ style, title, room, deferIfFocused }),
      );

      if (style === "alert") {
        (async () => {
          if (deferIfFocused && (await roomFocused(room))) {
            res.writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
            });
            res.end("deferred");
            return;
          }
          // Acknowledge before displaying; the blocking osascript keeps the
          // alert alive on its own without holding the HTTP reply open.
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end("shown");
          try {
            await show(title, message, "alert", ["OK"]);
          } catch (err) {
            console.error("osascript(alert) failed:", err.message);
          }
        })();
        return;
      }

      show(title, message, style, ["OK"])
        .then(() => {
          res.writeHead(204);
          res.end();
        })
        .catch((err) => {
          console.error("osascript(notification) failed:", err.message);
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("notification failed");
        });
    });
  })
  .listen(PORT, HOST, () => {
    process.stdout.write(`pi-notify listening on ${HOST}:${PORT}\n`);
  });
