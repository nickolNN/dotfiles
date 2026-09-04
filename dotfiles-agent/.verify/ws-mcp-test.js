// Minimal stdio MCP client: initialize -> tools/call web-search search
const { spawn } = require("child_process");
const p = spawn("node", ["/opt/web-search-mcp/dist/index.js"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
const pending = new Map();
p.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)(m);
  }
});
let nextId = 1;
function call(method, params) {
  return new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    p.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    setTimeout(() => rej(new Error(`timeout: ${method}`)), 90000);
  });
}
(async () => {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify", version: "1.0" },
  });
  p.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const r = await call("tools/call", {
    name: "web-search_get-web-search-summaries",
    arguments: { query: "Bodrum rent a car" },
  });
  const text = (r.result?.content || []).map((c) => c.text || "").join("\n");
  console.log("--- tool result ---");
  console.log(text.slice(0, 2000));
  const none = /Search engine: None/i.test(text);
  console.log("--- verdict ---");
  console.log(
    none
      ? "FAIL: Search engine: None"
      : "PASS: search returned without engine-None",
  );
  p.kill();
  process.exit(none ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e.message);
  p.kill();
  process.exit(2);
});
