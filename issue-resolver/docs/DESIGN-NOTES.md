# Design notes — invariants the code cannot express

Comments in this repository were removed on purpose: the code is expected to be
self-documenting. What is left here is the knowledge that **cannot** be derived
from reading a function — ordering rules, protocol quirks, race guards and
failure semantics that exist because of a specific bug or constraint.

Read this before changing the areas listed below. If you add a rule that a
future reader could break without noticing, add it here instead of a comment.

---

## 1. Pipeline and step order

- Every step is optional: a pipeline may run `resolve` alone, `refine →
  resolve → pr`, or any other subset in canonical order. No step may assume a
  neighbour exists — a prompt that hands work to “the `review` step” or “the
  `test` step” is dead advice when that step is not in the pipeline; name the
  condition or say it in `summary` instead.
- Canonical step order is `refine → resolve → review → test → pr`
  (`backend/src/workflow/iteration/pipeline-order.ts`, mirrored in
  `frontend/src/views/task-detail/constants.ts` and
  `frontend/src/components/IssueForm.tsx`). The engine always executes in
  this order no matter what order the API received (`iteration.steps`,
  `issue.pipelineSteps`); `resolve` must never run before `refine`.
- The form order is presentation only: it must not change launch semantics.
- `git add -A` is excluded via `.git/info/exclude` (never committed). This is
  best-effort and idempotent; a failure must not abort workspace preparation.
- A step is `timeout` (not `fail`) when the error text/report says so — the
  distinction is textual, because the runner reports both through one channel.
  See `stepOutcome` in `backend/src/workflow/iteration-report.ts`.
- A step's report is persisted even when writing it fails (disk, permissions):
  report persistence is logging and must not take the iteration down.

## 2. Iterations, queue, statuses

- One agent at a time per iteration is an invariant of the queue and of the
  concurrency accounting (`backend/test/iteration-queue.test.ts`).
- Queue slots are one `running`, one `pending` and one `draft` per issue, and the
  checks do not depend on a `running` row existing: creating or repeating while a
  `pending`/`draft` is queued answers `409` (`A pending iteration already
exists…`). Without that rule an idle issue accepted a second `pending` and the
  execution order drifted away from the numbering (`#2 → #4 → #3` in a real run).
- An iteration only becomes terminal through `completed`/`failed`; anything else
  leaves `startNextPendingIteration` never firing.
- `refine` runs before `resolve` because the planner must not ask the user for
  what the task already states.
- Stage outcomes survive a restart only inside one iteration and one plan:
  `backend/src/workflow/stage-run.ts` writes `.issue-stage-manifest.json`
  (`iterationId` + plan-shape signature) and deletes every `.issue-stage-*.json`
  when the manifest disagrees, so a previous iteration's file is never read as
  the current result. Resume decisions live in that module only.
- After a terminal status the backend spawns the report agent fire-and-forget;
  such a run must never take the iteration down (`backend/src/workflow/report-spawn.ts`).
- Starting an iteration has exactly one implementation:
  `backend/src/workflow/start-iteration.ts` (`startIteration` + `iterationPrepareDeps`).
  Issue create, issue start, iteration repeat and the pending queue all call it;
  a fourth hand-rolled prepare→run copy is how the four call sites drifted apart
  (different failure marking, different fire-and-forget) before.
- Status values are declared once in `shared/src/status.ts` as frozen objects and
  never written as literals in code (see `CODING_STANDARDS.md`). Three statuses
  coexist here and are easy to mix: `TaskStatus` on an issue or iteration,
  `StepRunStatus` on one step run, `StepReportStatus` on the report a step
  writes. The wire values are the keys, so a value is greppable
  (`StepRunStatus.needs_input` ↔ `"needs_input"`); `StepRunOutcome`
  (`shared/src/step-result.ts`) is the only place that maps evidence to a
  status, and `aborted` outranks everything else in it.
- **A blocker is a `major` or `critical` finding; a cycle ends when none is
  left.** `blockingFindings` (`shared/src/step-result.ts`) decides the move:
  `fail` with only `minor`/`low`/`info` advances like a pass, and a `pass` is
  never overridden by severity. The safe side is explicit — `fail` with no
  findings, an unreadable severity, and a `findingsMalformed` report are all
  blocking. `MAX_PIPELINE_ATTEMPTS` is the last line, not the only exit: its
  `needs_input(max_attempts)` fires only when blockers remain after the budget.
  Without the severity gate the loop was unbounded in practice — five review
  rounds, each honestly closing the previous list and finding a fresh one,
  because a fix is new code and the prompt put the whole change set in scope.
- **`review` proves from `file:line`, `test` proves from a reproduction.**
  Neither fills the other's role: review runs nothing, test judges no names,
  structure or duplication. The rule is `prompts/step-scope.md`, appended to
  every step prompt; the missing-test severity lives in `prompts/severity.md`.
  Why it exists: a defect filed by both verifiers costs two development cycles.

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
- A step's status is derived from evidence, never from silence
  (`stepRunOutcome` in `shared/src/step-result.ts`). Two absences are failures:
  the model never answered, and the step left no **fresh**
  `.issue-step-result.json`. Exit code 0 with a missing report used to read as
  `success`, which is how a task whose agent could not reach pi at all ended as
  «Completed» with nothing done. A run that produces artifacts instead of a step
  report says so explicitly with `requiresStepReport: false` (the report agent);
  no other caller may relax the default. `aborted` is part of the same input and
  outranks every other signal: an aborted run is `aborted`, never `failed` or
  `success`, whatever the exit code or the report says.
- `modelReplied` means "some evidence the model answered": an assistant stream
  event from the parser (`sawAssistantReply`) **or** `stats.assistantMessages >
  0`, since either alone can be missing while the other is present. `undefined`
  means unknown and is never treated as silence — a fake runner, an older pi or
  a stats payload without that field must not turn into a failure
  (`backend/src/pi/rpc-session.ts`).
- The `answer_model` session event names the model and the effort level that
  actually produced an answer, not the ones we asked for: `responseModel` (the
  concrete model the provider reports) and `providerThinkingLevel` (the
  provider-native effort) come from the authoritative `message_end` message.
  The event is emitted on change only — a fingerprint of the four fields — so a
  step that answers forty times at the same level contributes one line. Without
  it a virtual model that resolves to another one, and a provider that clamps
  an effort level, both look exactly like the request.
- Cost carries its own provenance: `SessionCost.fromProvider` and
  `SessionStats.costFromProvider` are true only when every contributing usage
  report was billed (`usage.cost.totalFromProvider`); absent means the number
  is a catalog estimate, and the frontend prints those with `≈`. The flag is
  sticky-false across an agent's session
  (`backend/src/pi/registry/usage.ts`), and an aggregate is provider-reported
  only when every part is (`sumSessionStats`, `shared/src/step-result.ts`). A
  total nobody billed must not read as an invoice.
- A failed run without a report persists a synthesized `fail` report carrying
  the reason (`STEP_FAILURE_TEXT` / `failureReportOverride` in
  `backend/src/workflow/step-failure.ts`) and publishes it as an error notice.
  An empty report field is what made these failures invisible to the step card,
  the retry feedback and the report agent. A `pass` report from a run whose
  model never answered is overwritten the same way: the verdict cannot be
  trusted when the writer never spoke. Any other failure keeps the report the
  agent wrote — only the agent can say what it found.

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
- Row coercion helpers live in `db/rows.ts` (`nowIso`, `parseJsonColumn`) and
  JSON state files go through `util/json-file.ts#readJsonFile`, which has the
  same lenient contract: unreadable or malformed content reads as empty instead
  of throwing, and the caller's parser decides whether the shape is acceptable.
  `tryParseJson` returns `unknown`, not a caller-chosen `T`: the JSON text does
  not know the type, so every call site narrows the value itself (see
  `CODING_STANDARDS.md`, "Untrusted input keeps three states").
  Neither is a `utils.ts` grab bag: a new helper belongs next to the concept it
  serves, not there.
- Tag run instructions are not invalidated by `updateTagRunInstructions`;
  otherwise analysis would rerun every iteration, because that file contains
  ports and volatile output.
- Timestamps carry second precision (see above), so two rows written in the same
  second share `created_at` and the tiebreaker decides the order. Chronological
  lists therefore tiebreak on `rowid` (insertion order) — `step_runs`, `tags`,
  `tag_repositories`, `repositories` — never on the row's uuid, which is random.

### DDL vs drizzle schema

`backend/src/db/ddl.ts` (raw `CREATE TABLE`) is the source of truth for databases
that already exist, `backend/src/db/schema.ts` is the drizzle typed surface; when
the two disagree, the DDL wins and `schema.ts` is corrected — never the other way
round, and never through a migration. Three columns are missing from the DDL on
purpose: `devops_model`, `devops_thinking_level` and `worker_count` exist in
`schema.ts` and are added by `ensureIssueColumns`/`ensureIterationColumns`, so a
fresh database converges through migrations and a diff there is not a bug. What
*was* real drift is now aligned in `schema.ts`: the `ON DELETE CASCADE` foreign
keys on `issue_repositories.issue_id` and `iterations.issue_id`, plus the
`issue_files_issue_id_idx`, `issue_files_iteration_id_idx` and
`retro_runs_created_at_idx` indexes that only the DDL had. `step_runs_*_unique`
looks like it is missing from the DDL too, but it is created from
`STEP_RUN_UNIQUE_INDEXES` (re-applied by the `step_runs` rebuild) — not drift.

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
  session events; devops/report use synthetic step run ids built by
  `SessionAddress.forIssueRun` — `issue.<issueId>.devops` and
  `issue.<issueId>.report`, not `{issueId}/devops`. The run id and the SSE
  filter key must match exactly or live events land in no buffer at all.

## 6. Report artifacts

- The agent authors **`report.md` + `report.json`**. `report.html` is rendered
  by the engine (`backend/src/workflow/report-render/`) after the agent exits,
  so the page exists whenever the markdown does. Never ask the agent to write
  HTML.
- `/report/status` answers from the newest `step_runs` row of the issue
  (`iteration_id IS NULL`), never from the files: `statusFromRun`
  (`routes/issues/latest-run.ts`) maps an active or non-terminal run to
  `running`, a terminal one to its own `success`/`failed`. `report.md` presence,
  then `lastReportFailed`, then `idle` are the fallbacks for an issue that never
  ran, and only those are process-local. `/devops/status` has the same shape. A
  `running` row whose session is gone and which stayed quiet for the window is
  closed as `failed` by `abortStaleRun` — the DB row is what survives a restart,
  a live badge is not.
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
  shortening the brief. Two more guards keep the prompt's rules observable
  instead of trusted: a missing `plan.md` and a brief that cites `file.ts:335`
  both surface as warnings in the run log (`planShapeWarnings`) — the planner's
  boundary is prose, so its violation has to be visible somewhere mechanical. Sizing comes before the plan:
  `single` is the default, and a split has to be earned by independent parts or
  by an ordering constraint.
- The refine step's three outputs have three different readers and none repeats
  another: `plan.md` (the executor's brief, overwritten every iteration),
  `iterations/<n>/.refine.md` (this iteration's delta for the report agent) and
  long-term memory (only what a later task could not read from the code). A
  decision copied into two of them becomes two sources that disagree after the
  next iteration.
- The planner decides **what** changes and why; the executor decides **how**.
  The boundary and its reasons are `prompts/step-refine.md` §1a; file paths stay
  allowed for one purpose only — the ownership map that keeps parallel workers
  off each other's files.
- `refine` is the single decision point for topology. The engine follows it
  deterministically: a staged plan with `mode: stages` whose declared stages are
  all well-formed, otherwise one agent. `parseExecutionPlan` keeps every declared
  stage — only its fields are normalised, a missing or non-numeric `index`
  becomes `0`, and a present but unusable `executors` becomes a `NaN` marker —
  so the gate can reject the plan and name the malformed stage instead of
  executing it minus that stage or with a different executor count. The mode is
  `single` or `stages` and nothing else: any other mode makes the plan
  unreadable, and an unreadable plan is a planner error — the same path as a
  malformed stage, never a silent single-agent run. Declared stages are checked
  before
  the plan is counted as staged, so a plan whose stages are all malformed still
  names the first one. One stage with several executors is a parallel
  wave and skips the stage coordinator — the final lead integrates the workers
  itself, so a wave costs N+1 agents, not N+2. One stage with one executor is
  `single` and is rejected as a planner error.
- `worker_count` is a scheduling limit, not a plan limit: it is how many
  agents may run at the same moment. It never shrinks a plan — the number of
  stages is unlimited, and a plan that declares more parallel executors than
  the limit is rejected rather than clamped. The engine re-runs `refine` with
  the exact cause (`executionPlanProblem` returns one specific reason — too many
  executors, no valid stages, a malformed stage with its position, a stage whose
  decomposition entry count differs from its executor count, top-level executors
  on a staged plan, a one-stage-one-executor plan, or a `single` plan that
  declares more
  than one executor). A plan that is present but unreadable — an unknown mode, a
  value where an object belongs — is rejected on the same path by the refine
  gate, which turns the report's unreadable-plan marker into a plan problem, and
  spends
  refine's own self-retry budget on it (`MAX_SELF_RETRIES.refine`, shared with
  refine crashes); once that budget is spent, the iteration fails and `resolve`
  never starts. A cap of 1 therefore means "one stage at a time", not "one agent for
  the whole task".
- Stages are renumbered to 1..N; strict order is stage executors → stage
  coordinator → next stage.
- If **all** wave/stage agents returned `pass`, `resolve` is never `aborted` —
  otherwise the iteration would be marked `cancelled`.
- The coordinator is not started when there is nothing to coordinate; it would
  append to the report and leave the iteration half-open.
- If every worker fails for its own reason (push rejected vs network/token vs
  branch conflict), the failure reasons are reported per repository instead of
  collapsing into one.

## 8. Frontend

- `views/TaskDetail.tsx` is composition only (~400 lines): the header card,
  modals, iteration launcher and each stateful concern live in
  `views/task-detail/` — one `use*.ts` hook per concern (live SSE buffers,
  subscription, step-runs, result artifacts, question feed, step-log modal,
  devops, files, dev servers, jira preview). Add state to the hook that owns
  the neighbouring state; do not grow the view.
- `TaskDetail` mounts directly in tests, so it guarantees a `QueryClient`;
  otherwise any `useQuery` throws `No QueryClient set`.
- `src/index.css` is the hand-written stylesheet (Tailwind 4 `@import` plus the
  session/editor rules); `src/animations.css` holds the shared keyframes and
  animation utilities. `frontend/dist/assets/*.css` is generated — never edit it.
- All HTTP imports go through `api/client.ts`; the `api/endpoints/*` modules are
  internal and are not a second public surface.
- Modals close on Escape through `hooks/useEscapeKey`; do not hand-roll a window
  listener per modal. The card frame itself — overlay, `role="dialog"`,
  `z-50`, close button, Escape — lives once in `components/ModalShell.tsx`
  (`layout="card"` for centred dialogs, `layout="full"` for the full-bleed
  viewers such as the step log and the report). A modal that draws its own
  overlay is a bug, not a variant.
- A run's result renders through one component: `components/RunOutcome.tsx`
  (live box, aborted, empty, or the parsed step report inside a shared frame)
  plus `RunStatsLine` below it. `prefix` (`step | report | devops | retro`)
  both names the `data-testid` family and nothing else, so any new run kind is a
  prefix, never a fourth renderer. Where a run's payload is not a step report
  (retro's markdown), it goes into `body` and keeps the same frame. A run's
  transcript is never a permanent block above the frame: it sits behind the
  «Развернуть» action, and retro's inline disclosure uses that same label.
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
- Deep links (`/tasks/<id>/result`) fire once per mount; a ref suppresses
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
  changes. A mutating request whose `Origin` matches the `Host` header is
  accepted as same-origin: the browser sends `Origin` on its own POSTs, so
  without that rule the UI is usable only on `localhost`, and opening it on a LAN
  address or a forwarded port turns every action into `403 origin not allowed`
  while reads keep working. The frontend dev-server proxy therefore sets
  `changeOrigin: false` — rewriting `Host` to the proxy target breaks exactly
  that comparison.
- The entry port belongs to the system, never to the agent: `allocateDevPort`
  hands out one port per issue from `5100–5299` and stores it on
  `issues.dev_server_port`, a new iteration reuses it (`reserveDevPort`) and only
  moves when the old one is genuinely busy — a moving URL is one the human has to
  open again. A run that produced no `RUN_INSTRUCTIONS.md` gives the port back
  and clears the column, because the UI must not offer an address where nothing
  listens. Upstream repositories take their own ports outside that range and
  record them in `WORKSPACE_INSTRUCTIONS.md`.
- Dev-server ownership is proven, never assumed. `pidServesDir` reads
  `/proc/<pid>/cwd` (falling back to the `ISSUE_RESOLVER_WORKSPACE` env the
  engine passes to `DEV_SERVER.sh`), and `.dev-server.pid` is trusted only while
  the pid is alive *and* that cwd sits inside the repo
  (`readOwnedDevServerPid`): a reused pid must never let a workspace adopt — or
  `stopDevServerProcess` kill — an unrelated process. A stored port is reused
  only when it is free or held by that same issue's process; otherwise the run
  takes a fresh port from `allocateDevPort` before the prompt is rendered, so
  `--strictPort` never hands the agent an `EADDRINUSE` to "fix". Killing is not
  the agent's tool at all: the devops prompt forbids `pkill`/`killall`/`fuser -k`
  outright — one `pkill -f node_modules/.bin/vite` in this shared container took
  down the issue-resolver's own UI and the agent's shell with it (`exit 143`) —
  and the only permitted signal is `DEV_SERVER.sh` through its own pid file. The
  engine also starts `DEV_SERVER.sh` itself after the run when nothing answers
  on the port, so a server that never detached is a reported detail, not a failed
  step.
- Run instructions are a cache with three consumers: the later steps read
  `RUN_INSTRUCTIONS.md` in the clone, the human edits that text by hand, and the
  DevOps agent reuses it as its own starting point for the next task on the same
  repository. So the cache never skips the step: `prepare-workspace/instructions.ts`
  always runs the agent and passes the stored text as `{{CACHED_INSTRUCTIONS}}`,
  and the agent verifies and updates its own notes instead of re-deriving the
  setup. The start script `DEV_SERVER.sh` is deliberately *not* part of the cache
  — every run produces it, because it lives on the disk of one clone:
  `startRepoDevServer` answers `null` without the file and the allocated port
  stays unbound, which is how a cached repo used to arrive at the `test` step
  with no server at all. When that still happens the devops step keeps
  `success` but its summary and `feedback` name the missing script; the earlier
  canned «DevOps completed during workspace preparation» made a skipped step
  look like finished work.
- The test account is a per-repository, human-owned value
  (`repositories.test_credentials`, written through
  `PUT /repositories/:id/credentials`). Agents only read it: it reaches the
  `devops` and `test` prompts as `{{CREDENTIALS}}` so the tester logs into the
  real stand instead of inventing a mock backend, and both prompts forbid copying
  the password or token into the step result, the narrative, a screenshot, the
  report or `RUN_INSTRUCTIONS.md`/`WORKSPACE_INSTRUCTIONS.md`. An empty value is
  not "try harder": with an account the tester must log in and verify against
  the real stand, and a mock is then not an option; without one a mock or stub
  server is allowed but has to be declared in `summary`, its dependent scenarios
  named, and findings that only the mock could produce stay at `low`/`info`.
  When nothing else can judge the change, the verdict is `blocked`. Empty string
  clears the field to `NULL`, so removing an account never leaves a stale secret
  behind.
- The `test` step drives the browser through `agent-browser`, not a harness the
  agent writes for itself: the CLI ships in the image and carries its own guide
  (`agent-browser skills get core`), while a hand-rolled Puppeteer/Playwright
  script pays a browser cold start on every attempt. That, plus the old 25 s
  default action timeout, is what turned a test round into 30 minutes: 65 tool
  calls, 48 of them `bash`, median 21.7 s. The prompt now pins
  `AGENT_BROWSER_DEFAULT_TIMEOUT=10000` and treats a missing element as a finding
  after two attempts instead of a retry loop. Batching matters as much as the
  driver: with the CLI in place the tool time fell from 18.4 min to 3.1 min, but
  the step still ran 25 minutes because 148 tool calls each cost a model turn
  (~8.5 s) — so the prompt now requires one `agent-browser batch` invocation per
  scenario (JSON array of commands on stdin) instead of one command per turn. Prompts are read through an
  mtime-keyed cache (`prompts/loader.ts`), so a prompt edit lands on the next
  step without a backend restart.
- `review` must not execute anything, and the rule is a tool gate, not a prompt
  sentence. Observed: reviews ran `npx vitest run` (the whole suite, twice),
  `npx vite build`, `npx tsc --noEmit`, `npx eslint` — rounds of 682 s and
  344 s on one issue, `pnpm exec eslint` on another — while the prompt said
  "code-only, no runtime" and "you have no execution". A model trusts the tool
  it has over a sentence in a long prompt, so `readOnlyStep`
  (`pi/tool-policy.ts`) marks `review` and `sessionArgs` (`pi/rpc-spawn.ts`)
  spawns that session with `--extension …/pi/read-only-extension.ts`. The
  extension answers `{block: true, reason}` on `tool_call` when a `bash`
  command's first word is a package manager, runtime, build/lint/test runner,
  container, network fetch, or a mutating `git` subcommand (`sed -i`,
  `find -exec` included), and for `ast_grep_replace` and any browser-driving
  tool (`agent-browser`, `chrome_devtools`, `playwright`, `puppeteer`).
  `codemode` is not a hole: a nested `tools.bash(...)` is a real `tool_call`
  with `parentToolCallId`, so the same handler blocks it and the script fails
  with the reason (`docs/codemode.md`: a blocked call rejects). Verified live,
  not assumed: a `--print` session with the extension got a blocked
  `tools.bash` inside `codemode`, a blocked direct `bash`, a working `ls`, and
  no file written.`write`/`edit` stay open:
  `.issue-step-result.json` and `iterations/<n>/.review.md` are the deliverable,
  and blocking them would trade a slow round for a failed one. Inspection stays
  open — `git status|diff|log|show|blame`, `cat|grep|sed -n|find|ls|wc|jq` —
  because the reviewer reads the whole file, not just the hunk. The ways around
  a first-word check are closed too, each found by probing the matcher rather
  than by argument: running a file (`./scripts/check.sh` — a path head whose
  name is neither an inspector nor a linter is a script), command substitution
  (`$(…)`, backticks, `<(`), redirection into anything but `/dev/null` (`>`,
  `>>` — the tree must come out unchanged), and git config injection (`-c`,
  `--config-env`, `--exec-path`, a `!` argument, which turn `git` into an
  arbitrary runner). Text inside single quotes is stripped before the
  substitution test and both quote kinds before the redirect test, so
  `grep -n ">" src/app.ts` still passes. Static analysis is the one execution
  the step keeps, since a linter finds defects reading cannot: `eslint`,
  `stylelint`, `prettier --check`, `biome check`, `dprint check`, `ruff`,
  `mypy`, `shellcheck`, `tsc --noEmit` run directly or through `npx` /
  `pnpm exec`, while `--fix`/`--write`/`fmt` stay blocked so the review cannot
  rewrite the code it judges (`--fix-dry-run` passes — it writes nothing). The
  allowance resolves by target, not by runner: `npx eslint` passes because
  `eslint` is the target, `npx vitest` does not; `tsc` passes only with
  `--noEmit`, since an emitting build is a build. `npm run <script>` is not
  accepted at all: a script name proves nothing about what the script runs, so
  `lint` naming a suite would have been a hole — call the binary instead. A
  missing extension file is not a warning but a refusal: `sessionArgs` throws
  `read-only step has no guard extension` and the step fails visibly, because a
  gate that degrades to a log line is a gate that silently disappears. A
  blocked call returns its reason to the agent, so it names the scenario for
  the `test` step instead of retrying; the prompt repeats the ban list for
  planning, but a rule that costs ten minutes to break cannot live there alone.
  The standards half of the review is a prompt fragment of its own
  (`prompts/review-standards.md`, wired through `review`'s `STEP_FRAGMENTS`):
  two passes, spec then standards; the repository's own rule files named as the
  source (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/`,
  `REVIEW-EXCEPTIONS.md`); machine-enforced rules excluded, since the linters
  already report them; and the twelve smell names as a judgement vocabulary with
  a ceiling of `minor`. The ceiling is the point: `blockingFindings`
  (`shared/src/workflow.ts:92`) sends the change back only on `critical`/`major`,
  so a standards campaign graded upwards would buy rounds that teach the author
  nothing — the fragment says a style observation leaves the verdict a `pass`,
  and the extra-key warning keeps a malformed finding from turning the whole
  list blocking (`shared/src/step-result.ts:333`).
- Every step spawns with `--no-skills` plus one `--skill` per entry of
  `STEP_SKILLS` (`backend/src/pi/tool-policy.ts`): refine 6, resolve 10, review 3,
  test 5, report 2, pr 0, devops 1. The inventory is why: pi advertises every
  discovered skill in the system prompt — 25 skills, ~10.5 KB, in *every*
  session, including the ones that never open one (review 0 of 42 sessions,
  report 0 of 27, over the whole pipeline history; even `refine`, whose prompt
  names its skill outright, is read in 12 of 43). `skills: []` still emits
  `--no-skills`: a step without an allowlist must not silently inherit the
  machine's set. Undefined keeps discovery, for runs outside the pipeline.
  Two rules keep the table honest. A skill a prompt names must be in that step's
  allowlist — `backend/test/step-skills.test.ts` reads the step's prompt files
  and fails on any `the "x" skill` mention outside it. And a rule is not a
  skill: `tdd` is allowlisted as the method *and* injected as
  `prompts/resolve-tdd.md` as the obligation, because a lazily-read skill is
  obeyed in 9% of sessions and "tests are the spec" cannot be optional. The
  asymmetry with the guard extension is deliberate: a missing skill directory
  degrades a step, a missing guard refuses to spawn.
- The pi-lens tools (`symbol_search`, `module_report`, `read_symbol`,
  `lsp_navigation`, `lens_diagnostics`, `ast_grep_*`) were in every step session
  all along, and across 263 pipeline sessions they were called **zero** times,
  against 12,148 `bash` calls — a `grep`/`read` workflow where the lenses answer
  in one call. The reason is placement, not value: the only description of those
  tools lived in the `pi-lens-*` skills, and a skill is a file nobody opens (the
  same 9%). So the rule went where the codemode directive already works — the
  always-injected `prompts/lens.md` fragment, wired for refine, resolve, review
  and test: name → `symbol_search` → `read_symbol`; no name → `project_report`
  → `module_report`; callers → `lsp_navigation`; after multi-file edits →
  `lens_diagnostics` on the touched batch before the build. The two pi-lens
  skills stay allowlisted as the parameter tables to read when a call comes back
  empty, which is the division of labour between a rule and a reference: the
  rule is injected, the table is optional. Their directories sit in the pi
  package, not in `~/.agents/skills`, so `SKILL_PATHS` overrides the root.
- `codemode` is offered to every step through the shared `capabilities.md`
  fragment (`withSharedFragments`), together with the rule to prefer it over a pile
  of single calls. Observed reason: across nine sessions of one issue the step
  agents made ~800 tool calls and used `codemode` zero times — a test round spent
  148 turns on one `bash` command each, and it is the turn count, not the command
  time, that costs the half hour. The fragment also names the limits: no timers, no
  network of its own, and a plain tool stays right for a single call. Placement
  matters and is deliberate: the shared fragments are appended *after* the step
  body, so in a `test` prompt the mechanics sit at 80% of 14.3k characters with the
  memory rules behind them. The decision itself therefore also rides in
  `STEP_SYSTEM_APPEND`/`DEVOPS_SYSTEM_APPEND` (`--append-system-prompt`), where it is
  read before the task and cannot be buried by a long step body. Two sentences with
  different jobs — directive at the top, mechanics at the end — not the same text
  pasted twice. Fragments come in three tiers and `withSharedFragments(prompt,
  extra, values)` appends `extra` first so the shared rules stay last:
  `SHARED_FRAGMENTS` (every step and every stage role), step fragments
  (`STEP_FRAGMENTS`: `severity.md` for review and test, `review-standards.md`
  for review, `resolve-tdd.md` for resolve, `lens.md` for the four steps that
  read code — a severity ladder is not resolve's job, and a review has no test
  to write) and stage fragments (`stage-outcome.md` — the stage roles that
  write one). A rule with two homes drifts; a rule with one home needs no copy.
- Jira uses API v2: v3 breaks on Server with 404.
- Bitbucket auth: Bearer for a PAT, Basic for an app password.
- Bitbucket Server (8.x) PR review comments are read from
  `/pull-requests/{id}/activities`, and three details of that payload are easy to
  get wrong, each with a silent failure mode
  (`backend/src/pr/bitbucket-server-mr.ts`):
  1. A comment activity is `action: "COMMENTED"`, not `"COMMENT"` — a filter on
     the latter drops every comment and the review reads as empty, which looks
     exactly like a clean review. `OPENED`, `RESCOPED`, `APPROVED`, `MERGED` in the
     same feed are PR history and must stay out.
  2. The diff attachment is `commentAnchor` on the **activity**
     (`{path, line, lineType, fileType}`), not `anchors.line` or a flat `anchor`
     on the comment; without it every comment loses its file and line.
  3. Replies are nested in `comment.comments` (one level, inherited anchor), so
     walking only the top-level feed loses the answers — often the part that
     says a defect is still there.
  The author is `comment.author.displayName` when present, else `author.name`.
- The Bitbucket **project** id and the pull-request id are different numbers on
  the same wire: `GET /rest/api/1.0/projects/KOS` answers `id: 2859` for project
  `KOS` (`KVADRA OS`). A number scraped out of a `409 DuplicatePullRequest`
  body (`existingPullRequest.id`, `pullRequestId`) is therefore not necessarily
  a PR id, and publishing it built `.../pull-requests/2859` in `result.json`,
  which then 404'd every later review-comment fetch for that task. The scrape is
  only used after a `GET` of that PR confirms it exists.
- `?direction=OUTGOING&at=refs/heads/<base>&state=OPEN` on the PR list answers
  `200` with an **empty page** on Server 8 while the unfiltered `?state=OPEN`
  list holds the PR (measured on b.yadro.com). Because "empty page" and "no PR
  yet" are indistinguishable, an open PR was never found and the engine created
  a duplicate. The Server lookup therefore lists `state=OPEN` (paged through
  `collectPagedValues`) and matches `fromRef.id` + `toRef.id` on the client, as
  the Cloud path already did. A failure to list must stay non-fatal: returning
  `null` lets the caller try to create, which is what the pre-existing fallback
  assumed.
- An empty repository (no commits) is a state, not an error: the remote listing
  returns zero branches, so `RepoInfo.defaultBranch` is `''` and
  `SavedRepo.defaultBranch` is `NULL`. Bitbucket Server answers
  `/branches/default` with `204` and an empty body — `response.json()` on that
  throws `Unexpected end of JSON input` and used to make such a repo impossible
  to add; every remote branch read now goes through `readJson`/`fetchBranchList`,
  which return `null` for empty or non-JSON bodies. A declared default branch is
  only trusted when the branch list is unavailable: a successfully read empty
  list wins over it. Such a repo can be registered and shown (the UI marks
  «нет веток — пустой репозиторий»), but a task needs a real base branch, and
  the write-access probe is skipped because there is no start point to create a
  test branch from.

## 10. Tooling notes

- `bin/pw-browsers.sh <repo>` makes Playwright work for an arbitrary repo: it
  tries the repo's own Playwright first and only then installs the matching
  chromium. A repo that pins none (a CSS/docs package with `node:test`) does not
  need one installed into its manifest: the image's own Playwright is on `PATH`
  (`playwright screenshot`), importable via
  `NODE_PATH=/opt/bun/install/global/node_modules`, and resolves browsers from
  `/opt/ms-playwright`. The substitution ban applies to a *different version of
  the repo's own* Playwright, not to a repo that has none.
- The retry `feedback` carries the failed step's `findings`, not only its
  `summary` (`previousAttemptFeedback` in `workflow/prompts/feedback.ts`). The next
  `resolve` overwrites `.issue-step-result.json`, so without that list a later
  `test` round can only recover the previous defects by reading
  `iterations/<n>/.test.md` — a whole agent turn spent rebuilding what the
  engine already had.
- `{{VERIFICATION_MODE}}` in the test prompt is a function of the attempt
  number, not a static paragraph: on attempt 1 the matrix is the full sweep, on
  later rounds the previous findings and the paths they name come first. The
  number lives in `attemptLimitBlock`/`verificationModeBlock`, so
  `MAX_PIPELINE_ATTEMPTS` never appears as a literal in markdown.
- `bin/embed-screenshots.mjs` is idempotent and exits 1 when placeholders or a
  screenshot file survive — the caller turns that into a warning, not a failure.