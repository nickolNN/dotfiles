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

Issue-level, not a pipeline step: `PIPELINE_STEPS` stays
`refine, resolve, review, test, pr` (`backend/src/validation.ts:3-8`); `'devops'`
exists in `shared` `PipelineStep` only so the run has a step label.

- `POST …/issues/:id/devops` → `202 {ok, devopsRunId}`, id = `<issueId>/devops`
  (`SessionAddress.forIssueRun(issueId, 'devops')`); a second start while one is
  active → `409 {error:'devops run already active'}`.
- `GET …/devops/status` and `GET …/devops/run` behave exactly like their report
  twins (below): the newest issue-level `step_runs` row, then `StepRunWithLog`
  with stdout, stderr, session events and per-model stats.
- What it does: for every issue repository with `bootstrap_enabled` (NULL counts
  as enabled) whose clone exists (`<task>/<repo>/.git`) it deletes the old
  `RUN_INSTRUCTIONS.md` + `DEV_SERVER.sh`, runs the agent, and writes
  `repositories.run_instructions` + `run_instructions_status` =
  `generated | failed`. Those two columns are the only record: there is **no
  `issues.bootstrap_error` column**. Diagnose via the status column, the
  `devops` step run, and `<task>/WORKSPACE_INSTRUCTIONS.md` (the port map).
- Ports: `allocateDevPort` (`backend/src/port-allocator.ts`, 5100–5299) → the
  entry script gets it as `PORT`, so it must honour `"${PORT:-<written port>}"`.
  `{{DEV_SERVER_PORT}}` in `prompts/devops.md` is always a concrete number.
- `<task>/pw-browsers.sh` is copied into every task workspace by
  `installWorkspaceHelpers`; prompts call it by name, never by a host path.

## Report artifacts

Post-iteration, fire-and-forget (`spawnReportAgent` in
`workflow/run-iteration.service.ts`); `POST …/issues/:id/report` →
`202 {ok, reportRunId}`. The agent writes `report.md` + `report.json` at
`<task>/`; **`report.html` is rendered by the engine** from those two right after
the agent exits (`workflow/report-render`), then the screenshots are inlined.
Composition rules live in `prompts/step-report.md` and `docs/FEATURES.md` — this
file only needs the operational facts:

- Before each run `archiveReportArtifacts` moves the pair into
  `<task>/reports/<stamp>/`; a failed archive aborts the run.
- `/result` serves the snapshot while the root is empty, flagged via
  `x-artifact-source`/`x-artifact-mtime` (mtime is ISO-Z without milliseconds);
  `404` only when neither exists.
- `GET …/report/status` — see above. `GET …/report/run` → `StepRunWithLog`, which
  is how the UI restores the output panel after a reload.
- Warning channels: `warnings` in `/report/status` and the
  `x-artifact-warning` header (non-ASCII percent-encoded, else Node rejects the
  header). Two detectors feed them: a model id in the authored files, and
  reading a previous `reports/**`/`.iteration-results/**` copy
  (`anchored on previous report: <path>`).
- A run whose pi process is gone is closed as `failed` by `failOrphanReportRun`;
  `POST …/report/reembed` rebuilds the page from the existing markdown.

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