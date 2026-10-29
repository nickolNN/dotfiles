# Design notes — invariants the code cannot express

Comments in this repository were removed on purpose: the code is expected to be
self-documenting. What is left here is the knowledge that **cannot** be derived
from reading a function — ordering rules, protocol quirks, race guards and
failure semantics that exist because of a specific bug or constraint.

Read this before changing the areas listed below. If you add a rule that a
future reader could break without noticing, add it here instead of a comment.

---

## 1. Pipeline and step order

- Canonical step order is `refine → resolve → review → test → pr`
  (`backend/src/workflow/engine.ts`, mirrored in `frontend/src/views/TaskDetail.tsx`
  and `frontend/src/components/IssueForm.tsx`). The engine always executes in
  this order no matter what order the API received (`iteration.steps`,
  `issue.pipelineSteps`); `resolve` must never run before `refine`.
- The form order is presentation only: it must not change launch semantics.
- `git add -A` is excluded via `.git/info/exclude` (never committed). This is
  best-effort and idempotent; a failure must not abort workspace preparation.
- A step is `timeout` (not `fail`) when the error text/report says so — the
  distinction is textual, because the runner reports both through one channel.
  See `backend/src/workflow/run-iteration.service.ts`.
- A step's report is persisted even when writing it fails (disk, permissions):
  report persistence is logging and must not take the iteration down.

## 2. Iterations, queue, statuses

- One agent at a time per iteration is an invariant of the queue and of the
  concurrency accounting (`backend/test/iteration-queue.test.ts`).
- An iteration only becomes terminal through `completed`/`failed`; anything else
  leaves `startNextPendingIteration` never firing.
- `refine` runs before `resolve` because the planner must not ask the user for
  what the task already states.
- After a terminal status the backend spawns the report agent fire-and-forget;
  such a run must never take the iteration down (`backend/src/workflow/run-iteration.service.ts`).

## 3. pi processes and sessions

- `--session-id` **resumes** a session if the id exists. Every report attempt
  therefore uses `reportPiSessionId(runId, stepRunId)` (`` `${runId}.try-${stepRunId}` ``)
  so a new report never starts from the previous attempt's near-full context.
  The control/SSE address stays `SessionAddress.forIssueRun(id, 'report')` —
  those are two different ids and must not be conflated.
- Session addresses are dot-separated (`run.<stepRunId>.s2.w1`), never slashes
  (`shared/src/session-address.ts`).
- Room name is per task: `issue-<issueId>`; otherwise the default room applies.
  Without an explicit room an agent must not join the caller's room.
- Tool policy is deny-by-default: an allowlist replaces pi's whole tool
  selection, so a forgotten entry is a lost capability, not an extra one
  (`backend/src/pi/tool-policy.ts`).
- Timeout handling is a ladder of attempts, each with its own grace window. A
  live but silent run must be killed (no output bumps the counter), while an
  attempt in flight must not let the window fire twice; the guard moves down the
  ladder instead of holding the run (`backend/src/workflow/timeout.ts`).
- Abort closes the session, then produces an `aborted` result — waiting for a
  process that will never settle is not an option.
- Every run must terminate: a crashed or hung pi must never leave a step
  `running` forever.

## 4. Database

- SQLite `NULL` does not conflict in a `UNIQUE` index, so iteration-level and
  issue-level step runs need **two** partial indexes
  (`step_runs_iteration_step_attempt_unique`, `step_runs_issue_step_attempt_unique`).
  One combined index would not catch duplicates.
- The `step_runs` rebuild runs with `foreign_keys = OFF`: `DROP TABLE` with FKs
  enabled would cascade into `step_outputs`. Indexes are created after the
  migration, `issue_id` is backfilled from `iterations`.
- `step_outputs` holds stdout; the live log is SSE only. Do not read stdout
  back from memory after a restart.
- Timestamps that go to the API are ISO-Z without milliseconds
  (`toISOString().replace(/\.\d{3}Z$/, 'Z')`) — one shape everywhere.
- Tag run instructions are not invalidated by `updateTagRunInstructions`;
  otherwise analysis would rerun every iteration, because that file contains
  ports and volatile output.
- A millisecond-precision timestamp plus one row per millisecond means two
  repositories created in the same millisecond need a tiebreaker.

## 5. SSE

- The event-type union in the frontend must cover the **whole** shared union;
  a missing member silently drops live events (`frontend/src/api/sse.ts`).
- The SSE envelope and `SessionEvent` are different shapes. Flat parsing of one
  as the other produces events that look valid and render nothing.
- The response flushes its first byte explicitly: without it a proxy buffers
  headers and `EventSource` never opens.
- A room event must not leak into another agent's stream; the stream is filtered
  by agent/session id.
- `stream: 'mr'` and `stream: 'stdout'|'stderr'` are separate channels from the
  session events; devops/report use synthetic step run ids
  (`{issueId}/devops`, `{issueId}/report`).

## 6. Report artifacts

- The agent authors **`report.md` + `report.json`**. `report.html` is rendered
  by the engine (`backend/src/workflow/report-render/`) after the agent exits,
  so the page exists whenever the markdown does. Never ask the agent to write
  HTML.
- `report.json` is optional and small: a broken companion degrades to a warning,
  never to a lost page.
- The renderer is split by job: `schema.ts` validates `report.json`, `markdown.ts`
  renders the md subset and remembers cited screenshots and ASCII figures,
  `diagrams.ts` draws SVG, `layout.ts` is the single pass that decides what goes
  to the hero, the answer and the collapsed block (headings, metrology, MR
  links, metric kinds, ASCII duplicates), `page.ts` assembles the document.
- Page composition is the renderer's decision, not the author's: the leading
  markdown `<h1>` and the metrology line (`Status`/`Generated`/`Iterations`/
  `Repositories`) are lifted out of the body, every `<h2>` section whose title
  matches an execution pattern (`execution`, `итерац`, `шаг`, `timeline`,
  `change set`, `findings`, `reproduction`, …) moves into the single collapsed
  `<details>` at the end, together with iteration-ish metrics, and diagrams are
  appended after the answer text — a diagram whose own title looks like process
  ("Шаг × итерация", "Iteration timeline") is routed into the collapsed block
  instead. Links to merge/pull requests are lifted into the header, so the MR is
  reachable from the first screen while the section that mentions it stays in
  the details. The first screen is the answer: verdict,
  metrics, contents, answer body.
- Execution details do not replay the run: no iteration timeline, no
  step-by-step retelling. Step narratives, session transcripts and the
  per-step events live in the engine (`step_runs`, `step_outputs`, sessions) and
  on the task page; the report keeps only what outlives the run — change set,
  open findings with provenance, MR links, reproduction recipe, metrology.
- Diagrams explain the answer, never the process. Kinds are `flow` (architecture
  as-is → to-be, data flow, control flow; nodes may carry a status, edges may
  carry a label), `bars` (measurements backing the answer), `matrix`
  (criterion × option, module × responsibility) and the sanitized `svg` escape
  hatch. There is deliberately no timeline kind: iteration timing is on the task
  page and inside the collapsed block, and a process diagram above the answer
  hides the answer.
- Screenshots are cited where they prove something: a markdown image
  (`![caption](screenshots/x.png)`) or a plain mention of the file name in a
  paragraph, list or table cell. The renderer turns a mention into a figure at
  that spot, marks the file as used and inlines it as WebP at full resolution
  (`bin/embed-screenshots.mjs`); only files nobody cited reach the closing
  gallery. Base64 must never pass through a tool call — the argument gets
  truncated and generation costs minutes per image.
- Inlining is a step of the run, not a manual repair: `runReportAgent` renders
  the page, then calls `embedReportScreenshots` on the same workspace (Node, no
  Python), and records a warning if placeholders survive. A page that still has
  `data-slot` after the run is a bug in the pipeline, never in the operator. The
  same file mentioned twice yields two figures: a citation marks the file as
  used (so it leaves the gallery), it does not forbid a second placement.
- Screenshots are not lazy: `loading="lazy"` on an image with unknown intrinsic
  size gives it a zero-height box, and the browser never starts loading it —
  the reader scrolls past empty space. The page is self-contained, so there is
  nothing to save by deferring.
- The output stays a single self-contained file that opens from `file://`.
  External fonts/CDN/scripts are forbidden, inline negative-test scan lives in
  `backend/test/report-render.test.ts`.
- Before each run the previous pair is archived into `<task>/reports/<ISO-ts>/`:
  the archive empties the root, so an agent can only write a fresh report, and
  `running` is the only in-flight signal.
- `activeReportRuns` is an issue-keyed `Set`; the check and the `add` are
  synchronous, so a second concurrent run is refused explicitly (`409`).
- A report run whose pi process is gone can never settle on its own — the abort
  route drives it to `failed` (`failOrphanReportRun`), otherwise the `running`
  badge and its heartbeat stay forever.
- Warnings reach the UI two ways: the JSON body of `/report/status` and the
  `x-artifact-warning` header of `/result`. Header values are ASCII by protocol,
  and engine warnings are written in the user's language, so a non-ASCII value
  is percent-encoded — otherwise Node rejects the header and the whole result
  endpoint answers `500`, which reads to the user as «отчёта нет».
- The report run is shown by the **same card component as a pipeline step**
  (`RunOutcome` / `RunStatsLine`): live transcript while it runs, one-line
  verdict plus a stats line once it ends, and the transcript behind «Развернуть».
  Two separate renderings of the same thing is how the report kept a live-looking
  block after a finished run. The report step's own `report` field holds artifact
  flags, not a step verdict, so the card synthesizes PASS/FAIL from the run
  status and only falls back to the stored payload when it is a real step report.
- `POST /report/reembed` rebuilds `report.html` from the existing `report.md` +
  `report.json` and inlines the screenshots again — the manual repair path when
  inlining or the page build failed. It refuses without `report.md` (409) and
  while a run is active, never touches the authored files, and records its
  warnings so `/report/status` shows them.
- The report section derives «идёт прогон» from the server status, not from a
  local flag: the poll retries, and after three consecutive failures it stops
  claiming a run and says the status is unknown. A stuck «Генерируется» with a
  live spinner is the symptom of the opposite (trusting a sticky local flag), so
  `getReportStatus` also validates the payload shape — a foreign object is an
  error, not a silent `running`: the payload must carry the `artifacts` object,
  which the real endpoint always sends. `getReportRun` is validated the same way
  — a foreign body must not be drawn as a run card.
- Model-leak detection scans the **authored** files (`report.md`,
  `report.json`) only: the generated page inherits the markdown, so scanning it
  would report one defect twice.
- Report model/thinking resolution has one source for both entry points
  (terminal iteration and manual `POST /report`): `step_models.report`, else the
  iteration model. Otherwise «Обновить» would build on pi's default while the
  terminal run used the iteration model.

## 7. Execution topology

- The planner's primary output is a decision, not a document: how big the task
  is, and how many executors/stages it takes. `plan.md` is the executor's brief —
  it reaches the execution step as `Task brief` (read from `plan.md`, capped at
  12 000 characters, falling back to `summary`), so decisions settled in the
  interview are not re-litigated downstream. Past the cap the prompt carries the
  leading part plus a pointer to `plan.md`, which the executor can read in full;
  the truncation is announced as a warning in the live log rather than silently
  shortening the brief. Sizing comes before the plan:
  `single` is the default, and a split has to be earned by independent parts or
  by an ordering constraint.
- The planner decides **what** changes and why; the executor decides **how**.
  `plan.md` carries the behaviour before/after, the owning area, acceptance
  criteria, invariants and risks — not line numbers, quoted code, or diffs. A
  plan written at edit level duplicates the executor's own discovery and goes
  stale after its first edit, while pushing the planner to read implementation
  it never needs. File paths stay allowed for one purpose only: the ownership
  map that keeps parallel workers off each other's files.
- `refine` is the single decision point for topology. The engine follows it
  deterministically: a room only with an explicit `mode: room` and a meaningful
  executor count, a staged plan with `mode: stages` and 2+ valid stages,
  otherwise one agent.
- Room/stage executor caps exist to avoid "20 agents" and to keep parallelism
  real: a cap below 2 cannot produce parallel work, so it degrades to a single
  agent.
- Stages are renumbered to 1..N; strict order is stage executors → stage
  coordinator → next stage.
- If **all** room/stage agents returned `pass`, `resolve` is never `aborted` —
  otherwise the iteration would be marked `cancelled`.
- The coordinator is not started when there is nothing to coordinate; it would
  append to the report and leave the iteration half-open.
- If every worker fails for its own reason (push rejected vs network/token vs
  branch conflict), the failure reasons are reported per repository instead of
  collapsing into one.

## 8. Frontend

- `TaskDetail` mounts directly in tests, so it guarantees a `QueryClient`;
  otherwise any `useQuery` throws `No QueryClient set`.
- Live step status from SSE wins over the `stepRuns` snapshot; the snapshot is
  not updated while a step runs.
- A question is eligible not only for active statuses but also for
  `needs_input` — a step that finished with a blocked report still has to
  surface its question, otherwise the task sits in `question` showing nothing.
- A question of a finished run must not open the modal, even unanswered —
  persistent refine questions would pop up during resolve.
- The `/result` HEAD probe distinguishes HTML from markdown and root from
  `iteration-snapshot` (`x-artifact-source`); a stale snapshot must never be
  presented as the current report, and markdown must not be fed into an iframe.
- Server answers are authoritative for questions: after a reload, already
  answered questions must not resurface; the union with local optimistic ids
  degrades to the previous behaviour when the request fails.
- `report.md` presence is not report readiness: the endpoint serves the last
  completed iteration's report, so readiness is "at least one completed
  iteration".
- Deep links (`#/tasks/<id>/result`) fire once per mount; a ref suppresses
  re-renders.
- Deletion subscribes to SSE **before** issuing `DELETE`, otherwise the fast
  phases and `issue_deleted` are missed; a timeout drops the placeholder and
  warns that the task may be partially deleted.

## 9. Workspace, files, security

- Attachment reads are confined to the task's `attachments/` folder (path
  traversal guard, also in `bin/embed-screenshots.mjs`).
- The workspace root lives on the host bind mount so artifacts survive container
  and room re-creation; `/home/agent/.issue-resolver` would sit on the
  ephemeral overlay layer.
- Archive order is deterministic (by `relPath`), so archives are reproducible.
- The origin allow-list is one source of truth for CORS reads and mutating
  routes: wildcard is never propagated (a local API must not be opened by an
  accidental `*`), and the env is re-read on every call so tests and runtime see
  changes.
- Jira uses API v2: v3 breaks on Server with 404.
- Bitbucket auth: Bearer for a PAT, Basic for an app password.

## 10. Tooling notes

- `bin/pw-browsers.sh <repo>` makes Playwright work for an arbitrary repo: it
  tries the repo's own Playwright first and only then installs the matching
  chromium. Never substitute another Playwright copy for the repo's pinned one.
- `bin/embed-screenshots.mjs` is idempotent and exits 1 when placeholders or a
  screenshot file survive — the caller turns that into a warning, not a failure.