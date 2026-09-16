// Desktop-notification bridge for Pi running in containers.
//
// Host macOS process. `POST /notify` renders:
//   - style "notification" (default): a Notification Center banner that
//     auto-dismisses (used for "Pi finished") — no buttons, no click action.
//   - style "alert": a persistent modal (used for "Pi needs you"). It gains
//     an "Attach" button that hops back to the room's tmux session, but only
//     when tmux + alacritty exist and the room was launched inside tmux (a
//     `<room>.attach` file under ~/.pi-notify records the session name).
//     Otherwise it silently falls back to a single OK button.
//
// Accepted requests are logged to stdout (→ /tmp/pi-notify.log under launchd).
//
// Env: PI_NOTIFY_PORT (default 49151), PI_NOTIFY_BIND (default 127.0.0.1).

import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.PI_NOTIFY_PORT || 49151);
const HOST = process.env.PI_NOTIFY_BIND || "127.0.0.1";
const MAX_BODY = 64 * 1024;

function appleSafe(value, max = 500) {
  return String(value ?? "")
    .slice(0, max)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

function scriptFor(title, message, style, buttons) {
  if (style === "alert") {
    const list = buttons.map((b) => `"${b}"`).join(", ");
    return (
      `display alert "${appleSafe(title, 120)}" ` +
      `message "${appleSafe(message)}" ` +
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
    execFile("osascript", ["-e", script], options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || "");
    });
  });
}

const VER_FLAG = { tmux: "-V", alacritty: "--version" };
function binExists(cmd) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/env",
      [cmd, VER_FLAG[cmd] || "-V"],
      { timeout: 3000 },
      (err) => resolve(!err),
    );
  });
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

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function openAttach(attach) {
  const shell = process.env.SHELL || "/bin/zsh";
  const inner = `tmux new-session -A -s ${shq(attach.session)}`;
  execFile(
    "alacritty",
    ["msg", "create-window", "--command", shell, "-lc", inner],
    (err) => {
      if (err) console.error("alacritty attach failed:", err.message);
      else process.stdout.write(`attach opened (${attach.session})\n`);
    },
  );
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
      try {
        ({
          title = "Pi",
          message = "",
          style = "notification",
          room = "",
        } = JSON.parse(body || "{}"));
        title = String(title);
        message = String(message);
        style = String(style);
        room = String(room);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad request");
        return;
      }

      console.log("notify", JSON.stringify({ style, title, room }));

      if (style === "alert") {
        // Acknowledge immediately; the blocking osascript keeps the alert
        // alive on its own without holding the HTTP reply open.
        res.writeHead(204);
        res.end();
        (async () => {
          try {
            const attach = await attachFor(room);
            const buttons = attach ? ["Attach", "OK"] : ["OK"];
            const out = await show(title, message, "alert", buttons);
            if (attach && out.includes("Attach")) openAttach(attach);
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
