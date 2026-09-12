// Desktop-notification bridge for Pi running in containers.
//
// Host macOS process. `POST /notify` renders:
//   - style "notification" (default): a Notification Center banner that
//     auto-dismisses (used for "Pi finished").
//   - style "alert": a persistent modal alert that stays until the user
//     clicks OK (used for "Pi needs you").
//
// Accepted requests are logged to stdout (→ /tmp/pi-notify.log under
// launchd) so extension-fired notifications are observable.
//
// Env: PI_NOTIFY_PORT (default 49151), PI_NOTIFY_BIND (default 127.0.0.1).

import http from "node:http";
import { execFile } from "node:child_process";

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

function scriptFor(title, message, style) {
  if (style === "alert") {
    return (
      `display alert "${appleSafe(title, 120)}" ` +
      `message "${appleSafe(message)}" ` +
      `buttons {"OK"} default button "OK"`
    );
  }
  return (
    `display notification "${appleSafe(message)}" ` +
    `with title "${appleSafe(title, 200)}"`
  );
}

function show(title, message, style) {
  const script = scriptFor(title, message, style);
  // Banners return immediately; alerts block until dismissed, so alerts get
  // no timeout and persist for as long as the user needs.
  const options = style === "alert" ? {} : { timeout: 5000 };
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], options, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
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
      try {
        ({
          title = "Pi",
          message = "",
          style = "notification",
        } = JSON.parse(body || "{}"));
        title = String(title);
        message = String(message);
        style = String(style);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad request");
        return;
      }

      console.log("notify", JSON.stringify({ style, title }));

      if (style === "alert") {
        // Acknowledge immediately; the blocking osascript keeps the alert
        // alive on its own without holding the HTTP reply open.
        res.writeHead(204);
        res.end();
        show(title, message, style).catch((err) =>
          console.error("osascript(alert) failed:", err.message),
        );
        return;
      }

      show(title, message, style)
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
