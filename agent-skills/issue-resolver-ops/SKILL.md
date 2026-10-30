---
name: issue-resolver-ops
description: >
  Runtime ops/debugging for the issue-resolver backend — live
  SQLite DB, iteration/step status, restart safety, which prompt reached a
  step agent, a report that did not improve, DevOps run and run-instructions
  status. Use when it misbehaves:
  empty/stale report, stuck step, wrong DB, prompt edit with no effect, tests.
---

# issue-resolver ops

`<task>` = `<workspaceRoot>/<issueId>`. `workspaceRoot` is
`$ISSUE_RESOLVER_DATA_DIR/workspaces` when that env is set, otherwise the
hard-coded local default
`/home/agent/workspace/.issue-resolver/workspaces`
(`backend/src/deps.ts:65-66`). In the container image the same tree is
`/workspaces` (`backend/src/workspace/paths.ts:3`).

## Live DB and restart safety

No `sqlite3` CLI, but Node 24 ships `node:sqlite` — use it. The DB is
`backend/data/issue-resolver.db` (`DEFAULT_DB_PATH`,
`backend/src/db/client.ts:8-11`), or `$ISSUE_RESOLVER_DATA_DIR/issue-resolver.db`
when set (`dbPathFromEnv`, same file, lines 13-16). That env moves the **DB
only**; workspaces keep their own root (above). A same-named file elsewhere
(`…/.issue-resolver/issue-resolver.db`) can exist with zero tables — it is a
trap, not the live store.

On restart `reconcileInterruptedRuns` (`backend/src/db/reconcile.ts`) fails
`step_runs` pending/running/needs_input, `iterations` running/preparing
(pending too, under a preparing issue), `issues` running/preparing/question.
`iterations.draft`/`step_runs.aborted` are inert — "non-terminal" ≠ active.

```bash
cd /home/agent/workspace/issue-resolver/backend && node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/issue-resolver.db', { readOnly: true });
const left = (t, s) =>
  console.log(t, db.prepare('select id, status from ' + t + ' where status in ' + s).all());
left('step_runs', "('pending','running','needs_input')");
left('iterations', "('running','preparing','pending')");
left('issues', "('running','preparing','question')");
"
```

Empty lists = safe. `bin/service.sh` starts `npm run start` = `tsx src/server.ts`
— **no watch**: `backend/src/**` edits need `./bin/service.sh restart`. Only
`npm run dev` (`tsx watch src/server.ts`) reloads sources. `prompts/**` is in
neither watch set, but needs no restart: `readPrompt` re-reads on mtime+size
change (`backend/src/workflow/prompts.ts:17-27`), so the text ships on the next
spawn of any step agent.

## API prefix

Every route lives under `/issue-resolver/api/v1` — declared per router, not in
one place: `routes/issues.ts:75`, `routes/repos.ts:29`, `routes/admin.ts:12`,
`routes/models.ts:8`, `routes/settings.ts:6`, `routes/stream.ts:13-20`. There is
**no `/api/...` alias**: `GET /api/issues` → 404 while `GET /ping` → 200 (health
is `/ping`, unprefixed). A 404 on a remembered `/api/...` path is a prefix
mistake, not a missing feature — re-read the `API_PATH` constant of that router
before concluding anything is unimplemented.

## DevOps run (workspace preparation)

Issue-level, like report, and **not** a pipeline step: `PIPELINE_STEPS` stays
`refine, resolve, review, test, pr` (`backend/src/validation.ts:3-8`); `'devops'`
exists in `shared` `PipelineStep` only so the run has a step label.

- `POST /issue-resolver/api/v1/issues/:id/devops` → `202 {ok, devopsRunId}`
  (`routes/issues.ts:749`), id = `<issueId>/devops`
  (`SessionAddress.forIssueRun(issueId, 'devops')`); while a run is active the
  second POST gets `409 {error:'devops run already active'}`.
- `GET …/devops/status` (`:783`) → `running` (`isDevopsRunActive`) else the
  newest `devops` `step_runs` row: `success` / `failed` / `idle`.
- `GET …/devops/run` (`:834`) → that row with stdout, stderr, session events and
  per-model stats (`getStepRunWithLog`); `404 {error:'issue not found'}` or
  `{error:'devops run not found'}`.
- What it does: for every issue repository with `bootstrap_enabled` (NULL counts
  as enabled) whose clone exists (`<task>/<repo>/.git`), it deletes the old
  `RUN_INSTRUCTIONS.md` + `DEV_SERVER.sh`, runs the agent, and writes
  `repositories.run_instructions` + `run_instructions_status` =
  `generated` | `failed` — a run that inherits a previous `generated` would be a
  lie. Those are the only records of the outcome: there is **no
  `issues.bootstrap_error` column** (grep finds none in the whole repo).
   Diagnose via the status column, the `devops` step run, and
  `<task>/WORKSPACE_INSTRUCTIONS.md` (the port map the agent writes).
- `<task>/pw-browsers.sh` is copied into every task workspace by
  `installWorkspaceHelpers` (`backend/src/workflow/run-iteration.service.ts`).
  A step agent sees only the `/workspaces/<issueId>` bind, so prompts call it by
  name (`bash pw-browsers.sh <repo-dir>`), never by the host path under
  `/home/agent/…`.
- The entry port belongs to the system, never to the agent: `allocateDevPort`
  (`backend/src/port-allocator.ts`, range 5100–5299) → `issues.dev_server_port`.
  A manual run allocates when the row is empty and releases the port + clears the
  column if the run generated nothing. The backend starts `DEV_SERVER.sh` with
  `PORT` in its environment, so the entry script must honor
  `"${PORT:-<written port>}"`; `{{DEV_SERVER_PORT}}` in `prompts/devops.md` is
  always a concrete number (there is no `AUTO` any more). Repositories other than
  the entry point are upstreams on their own ports, outside 5100–5299.
- Template: `prompts/devops.md` with `{{REPO_DIR}} {{REPO_NAME}}
  {{DEV_SERVER_PORT}} {{TAG_INSTRUCTIONS}} {{REPOS_NAMES}}
  {{REPOS_REQUIRE_DEV_SERVER}} {{REPOS_INSTRUCTIONS}}` —
  `renderDevOpsPrompt` (`backend/src/workflow/devops.ts`).
- Frontend: the `DevOps задачи` card on the task page
  (`frontend/src/views/TaskDetail.tsx`, `data-testid="devops-section"`) polls
  `/devops/status` and opens the saved run in a modal.

## Report artifacts

Post-iteration, fire-and-forget (`spawnReportAgent` in
`workflow/run-iteration.service.ts`); `POST
/issue-resolver/api/v1/issues/:id/report` →
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

**Status** (`GET /issue-resolver/api/v1/issues/:id/report/status`): `running` while a run is
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

Diagrams — the doctrine lives in exactly one place: `prompts/step-report.md`,
the block **“Drawing a shape”**. This skill does not restate it on purpose: a
second copy is how the “opt-in” and “one per section” wordings ended up
contradicting each other. When a report has too few or too many diagrams, read
that section. What the engine does regardless of the doctrine: kinds are
`flow | bars | matrix | svg` (`report-render/schema.ts:19-61`), there is no
`timeline`; a declared diagram is dropped when `duplicatesAscii` (`layout.ts:166`)
finds `max(2, ⌈half the title words⌉)` of them inside an ASCII figure of
`report.md`, warning
`report.json: диаграмма "<title>" пропущена — та же схема уже нарисована ASCII в report.md`
(`page.ts:185-189`) — so a shape drawn twice loses its picture on the page; a
diagram whose title or labels match `EXECUTION_LABEL` (`layout.ts:20-21`,`diagramIsExecution:124`)
goes to the collapsed block instead of the answer (`page.ts:192`).

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
  | node -e "let t='';process.stdin.on('data',d=>t+=d).on('end',()=>{
      console.log(t.length, ['Rebuild, never patch','Final self-check']
        .map(k=>k+':'+(t.split(k).length-1)));
    })"
jq -r 'select(.type=="message" and .message.role=="assistant")
  | .message.content[]? | select(.type=="toolCall").name' "$f" | sort | uniq -c
```

The first `role=user` message is the full prompt — judge it by LENGTH + a
marker, not mtime: stale cache and ignored rule look alike. Heavy
`bash`/`read`/`edit` + `write` 0–1 ⇒ patched; same size, new hash ⇒ edit.

## Inspecting generated HTML

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync(process.argv[1], 'utf8');
const count = (tag) => (html.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length;
console.log(
  'svg', count('svg'), 'table', count('table'), 'details', count('details'),
  'links', (html.match(/href="http/g) || []).length,
);
" /home/agent/workspace/.issue-resolver/workspaces/<id>/report.html
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