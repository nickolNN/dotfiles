---
name: issue-resolver-ops
description: >
  Runtime ops/debugging for the issue-resolver backend — live
  SQLite DB, iteration/step status, restart safety, which prompt reached a
  step agent, a report that did not improve. Use when it misbehaves:
  empty/stale report, stuck step, wrong DB, prompt edit with no effect, tests.
---

# issue-resolver ops

`<task>` = `/home/agent/workspace/.issue-resolver/workspaces/<id>`.

## Live DB and restart safety

No `sqlite3`; use `python3`. Live DB = the absolute path below (default when
`ISSUE_RESOLVER_DATA_DIR` unset); env `<dir>` holds `<dir>/issue-resolver.db` +
`<dir>/workspaces`; `…/.issue-resolver/issue-resolver.db` is a 0-table trap.

On restart `reconcileInterruptedRuns` (`backend/src/db/reconcile.ts`) fails
`step_runs` pending/running/needs_input, `iterations` running/preparing
(pending too, under a preparing issue), `issues` running/preparing/question.
`iterations.draft`/`step_runs.aborted` are inert — "non-terminal" ≠ active.

```bash
python3 - <<'PY'
import sqlite3
live = "/home/agent/workspace/issue-resolver/backend/data/issue-resolver.db"
c = sqlite3.connect(f"file:{live}?mode=ro", uri=True)
for t, s in [("step_runs", "('pending','running','needs_input')"),
             ("iterations", "('running','preparing','pending')"),
             ("issues", "('running','preparing','question')")]:
    rows = c.execute(f"select id,status from {t} where status in {s}")
    print(t, rows.fetchall())
PY
```

Empty lists = safe. `tsx watch` watches `backend/src/**`, not `prompts/**`.

## Report artifacts

Post-iteration, fire-and-forget (`spawnReportAgent` in
`workflow/run-iteration.service.ts`); `POST /api/issues/:id/report` →
`202 {ok, reportRunId}`. The agent writes `report.md` + `report.json` at
`<task>/` root (`report-<n>.md` = engine summaries); **`report.html` is
rendered by the engine** from those two (`workflow/report-render`) right after
the agent exits, so the page always exists when the markdown does. SSE
`step_status`/`log`/`step_event`
carry `stepRunId = '{issueId}/report'` (`reportRunId` in the POST reply).
The live section a user watches is fed by those SSE events + the run's
session jsonl; files (`/result`, snapshot, archive) are the durable copy.

Before each run `archiveReportArtifacts` moves the pair into
`<task>/reports/<stamp>/` (`toISOString()`, `-1` on collision); a failure
aborts the run (`step_status failed`). `/result` serves the snapshot, copy
flagged via `x-artifact-source`/`x-artifact-mtime` (mtime is ISO-Z, no
milliseconds: `toISOString().replace(/\.\d{3}Z$/, 'Z')`, the shape D16 pins;
404 only if neither).

**Status** (`GET /api/issues/:id/report/status`): `running` while a run is
active (`isReportRunActive`); else `success` if `report.md` exists, `failed`
if `lastReportFailed`, else `idle`. `activeReportRuns`/`lastReportFailed` are
process-local: a restart resets `failed` to `idle`. The archive empties the
root, so `running` is the only in-flight signal; corroborate via the log
(`report agent started: … trigger=… [origin=…] archived=<dir|none>
files=[…] at=<ISO>` / `report agent finished: … trigger=… durationMs=…
artifacts: …`; a silent caller logs `trigger=unknown`) or the newest session
jsonl.

`warnings`/`x-artifact-warning` come from `detectModelLeak`: exact
(needle = `observedModelFor` — the model the session reported, else
`input.model`; plus a ≥6-char `/`-tail) and a narrow pattern layer that
runs even with no model, so a foreign id is still flagged (`model-like id
leaked into …`). Pattern layer is derived **on read** (`reportWarningsFor`)
⇒ survives a restart; only the exact-id layer is process-local; max one
warning per file (`warningFile` dedupe, exact wins). `/report/status` adds
`observedModel` (additive, absent after a restart → UI "no telemetry"),
and a `running` `step_status {model: null}` honestly means "none
requested, system model" — never the model that actually ran.
`report.md` precedes the page: mid-run `/result` serves the previous HTML
(`iteration-snapshot`, `text/html`), md-fallback if none.

**The page is built, never authored.** `renderReportArtifacts(hostDir)` reads
`report.md`, optional `report.json` (verdict/metrics/diagrams; a broken file
degrades to a warning, never to a lost page) and `screenshots/`, then writes
`report.html`: inline CSS with light+dark, markdown rendered through an
escaping subset (raw HTML stays text, `javascript:` links are neutralized),
`<dialog>` lightbox.

Composition is code, not authoring (`workflow/report-render/layout.ts`):
whatever section, metric, diagram or metrology line smells like the run
(`execution`, `итерац`, `шаг`, `timeline`, `change set`, `findings`,
`reproduction`) is collected into one collapsed `<details>` at the end, the
leading `<h1>` and the `Status/Generated/Iterations` line are dropped, merge/
pull-request links are lifted into the header (the section that mentions them
stays in the details), and diagrams land after the answer text.

Diagrams are opt-in and drawn from numbers: `flow` (nodes may carry a status,
edges may carry a label), `bars`, `matrix`, plus a sanitized `svg` escape
hatch. There is no `timeline` kind — a process chart above the answer hides the
answer, and iteration timing already lives on the task page. A diagram whose
title duplicates an ASCII figure in `report.md` is dropped with a warning.

**Screenshots are inlined as the last step.** A screenshot is cited where it
proves something — a markdown image, or the file name mentioned in a
paragraph, list or table cell — and rendered as a `<figure>` right there; only
files nobody cited reach the closing gallery. Every figure carries a
`data-slot="01-board.png"` placeholder; `bin/embed-screenshots.mjs` (Node,
no Python) rewrites them into WebP-q85 data URIs at full resolution
(`--lossless`, `--keep-png` for alternatives; no encoder → original bytes).
`runReportAgent` renders, then inlines, then re-reads sizes, so the DB keeps
the final byte counts. Idempotent: no placeholders → no-op, exit 0. Exit 1
means placeholders or a missing screenshot file survived — that lands in the
step `feedback` (`report.html без всех скриншотов: …`), not in `failed`.
`report.md` itself no longer replays the run: `## Execution details` keeps the
change set, the findings table with provenance, MR links and the reproduction
recipe — not an iteration timeline nor a step-by-step retelling of narratives.

Base64 in a tool-call argument is the failure mode this replaces: it gets
truncated, and even when it survives it costs minutes of generation per
image.

Model-leak detection scans authored files only (`report.md`, `report.json`):
the page inherits the markdown, so scanning it would report one defect twice.

## Did the prompt edit reach the agent?

`readPrompt` caches by `(mtimeMs, size)`; `prompts/` is outside `tsx watch`,
so an edit applies on the next spawn with no restart — but never assume it
shipped. Read the delivered text and tool mix from the agent's own session:

```bash
ISSUE=<id>
f=$(ls -t /home/agent/.pi/agent/sessions/\
--home-agent-workspace-.issue-resolver-workspaces-"$ISSUE"--/*.jsonl|head -1)
jq -s -r '[.[]|select(.type=="message" and .message.role=="user")][0]
  | .message.content
  | if type=="array" then map(.text//"")|join("\n") else . end' "$f" \
  | python3 -c 'import sys;t=sys.stdin.read();print(len(t),
    {k:t.count(k) for k in ["Rebuild, never patch","Final self-check"]})'
jq -r 'select(.type=="message" and .message.role=="assistant")
  | .message.content[]? | select(.type=="toolCall").name' "$f" | sort | uniq -c
```

The first `role=user` message is the full prompt — judge it by LENGTH + a
marker, not mtime: stale cache and ignored rule look alike. Heavy
`bash`/`read`/`edit` + `write` 0–1 ⇒ patched; same size, new hash ⇒ edit.

## Inspecting generated HTML

```bash
python3 - <<'PY'
from html.parser import HTMLParser
n, ext = {}, []
def h(tag, attrs):
    n[tag] = n.get(tag, 0) + 1
    d = dict(attrs)
    if tag == "a" and (d.get("href") or "").startswith("http"): ext.append(d)
p = HTMLParser(); p.handle_starttag = h
path = "/home/agent/workspace/.issue-resolver/workspaces/<id>/report.html"
p.feed(open(path, encoding="utf-8").read())
print({k: n.get(k, 0) for k in ("svg", "table", "details")}, ext)
PY
```

## Tests and the quiet window

Run each suite from its own workspace — no root vitest config; frontend
specs need `jsdom` from `frontend/vite.config.ts`; root `npx vitest run`
fails ~60 files (`document is not defined`). One run per room.

An "X is absent" claim needs a self-test of that pattern on a known-present
line: without `-E` alternation is BRE and its silence proves nothing.
Quote a `:line` with `stat -c '%y %s' <file>` beside it: `src/**` changes
every few minutes here, and a citation without mtime starts a staleness
argument instead of a code one.

```bash
cd /home/agent/workspace/issue-resolver/backend && npx vitest run
cd /home/agent/workspace/issue-resolver/frontend && npx vitest run
pgrep -af '[v]itest|[t]inypool|[c]ustom-esbuild|[n]g build' || echo quiet
```

## Security contract

`isAllowedOrigin` (`backend/src/http/origin.ts`): absent `Origin` (curl/e2e)
allowed; `null` rejected; localhost/127.0.0.1/[::1] any port; exact
`ISSUE_RESOLVER_ALLOWED_ORIGINS` strings allowed; `*` dropped. Foreign
`Origin` on a mutation → `403 {error:'origin not allowed'}` in `app.ts`
`preHandler` (a bare 403 can also be body validation — compare the body);
html sandboxed (`allow-scripts allow-popups` → opaque origin). `app.ts`
`onResponse` logs every mutation (no bodies/headers beyond `Origin`):
`mutate <METHOD> <url> origin=<…|none> status=<code> at=<ISO>`.

## Room conventions

`PI_AGENT_ROOM` = basename of the launched folder, overriding the global
`defaultRoom`; state/handoff: `~/.pi/agent/rooms/<room>/_shared/` (no secrets).