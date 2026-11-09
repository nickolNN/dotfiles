# Reviewed exceptions — decisions a review must not reopen

A file at the ceiling because it is pure wiring has already been written the way
[`CODING_STANDARDS.md`](../CODING_STANDARDS.md) asks; re-splitting it produces
props factories and indirection, not readable code. The same holds for a
"duplication" that is two different things sharing a name. Each entry records one
such decision, with the reason and the date it was taken.

This file is a record, not doctrine — the rules live in `CODING_STANDARDS.md`.
Add an entry when a review flags something that is right; delete an entry when
the code behind it changes, rather than amending it.

- `frontend/src/views/TaskDetail.tsx` — **the shell stays above the target,
  accepted 2026-11-05.** Everything left is composition: imports, one call per
  stateful hook from `views/task-detail/use*.ts`, and two component calls
  (`TaskIsland`, `TaskDetailModals`) with grouped props. The only logic is a few
  one-liners derived from those hooks (`statusOf`, `activeIterationId`,
  `anyActiveStep`); extracting them would mean passing one opaque `detail={…}`
  object, which hides what the child needs. **If it grows, extract the new
  concern into `views/task-detail/` — do not split the shell, and do not count
  this file's size as a review finding.**
- `backend/src/routes/issues/*.ts` — the repeated `'issue not found'` guards are
  **not** to be folded into one helper or a `preHandler`, reviewed 2026-11-05.
  Some are pure guards; the rest bind `const issue` and several of those use the
  value (`issue.jira_issue_url`, `issue.status`, one handler returns it). A
  scope-level `preHandler` would pay two DB reads wherever the value is used;
  avoiding that needs `request.issue` typed `Issue` while being `undefined` on
  routes without `:id`, i.e. a type that lies. A five-parameter helper returning
  `FastifyReply | null` reads worse than three explicit lines. The literal and
  the 404 body already live once, in `notFound`.

- **active-run registries stay separate.** `devops-session.ts` keeps a `Set` keyed
  by `issueId` where a second start logs and returns; `report-run/tracking.ts`
  keys the same way but answers skip/409 *and* keeps `lastReportOutcome` next to
  it; `retro/active-runs.ts` keys by `runId` and exposes
  `activeRetroRunId()`/`abortRetroRun`, with no "second start" rule at all. One
  shared `Set` would make a devops run count as an active *report* run for the
  same issue, reviewed 2026-11-05. Share the shape when the keys and the
  duplicate-start rule agree; they do not here.

- **The `422` bodies stay raw.** `unprocessable()` sends `{ error }`, while
  `report.ts` sends `{ error, warnings }` and `repos.ts` sends
  `{ error, repository }`. Widening the helper to carry an arbitrary payload
  would move the response shape of those routes into `params.ts`, reviewed
  2026-11-05. Only the plain-body site uses the helper.

- **`RepositoryCard` and `TagCard` keep their own prop types.** Three members
  coincide (`busy`, `onEdit`, `onDelete`); everything else differs — the
  repository card carries `repo`, `index`, `onValidate`, the tag card `tag`,
  `expanded`, `onToggleExpanded`. A shared base type would tie two unrelated
  views together and still leave both interfaces, reviewed 2026-11-05. Share a
  type when the *shape* is the same, not when three names happen to match.

- **`RefineGate.kind` is a frozen object next to the gate, not bare literals.** It crosses one module boundary (`refine-gate.ts` → `runner.ts`), and its members are not a shared status domain: `failed` here means "the planner produced nothing usable", not `TaskStatus.failed`. That is exactly why it cannot stay a bare literal union: at `gate.kind === 'failed'` the reader cannot tell which domain the string belongs to, and the three names also exist on `StepRunStatus`/`TaskStatus`. `RefineGateKind` lives in `refine-gate.ts` (its owner), the values stay the wire words, and every comparison names the owner, revised 2026-11-06. The same rule applies to `PromptDisposition` (`shared/src/control.ts`, next to the pi control protocol) and `SlashOutcomeKind` (`slash-commands.ts`), which used to share the literal `'handled'` in one request path.

- **`response.json()` casts in the Jira, repo-resolver and MR clients were
  removed, not granted the `requestJson<T>` exception.** That exception covers
  one declaration for a whole frontend; ten copies in ten clients are exactly
  the repetition it exists to avoid. Each client now decodes the fields it
  reads with the `require*` helpers and raises on a malformed body, reviewed
  2026-11-06.

- **`requestJson<T>` keeps one unchecked cast at the HTTP boundary.**
  `frontend/src/api/endpoints/http.ts` returns `data as T` so every caller gets
  a typed envelope without repeating the same narrowing twenty times. The cast
  is safe only because call sites validate the fields they read — see
  `api/guards.ts` and the per-endpoint guards — and because the alternative is
  the same check written at every call site. One declared boundary beat twenty
  local ones, reviewed 2026-11-06. Its backend counterpart is `PageShape` in
  `pr/paged-http.ts`: the envelope is cast once inside the pagination engine all
  three list endpoints go through, so the alternative is three decoders for the
  same shape.

- **Reading back our own data does not re-validate its shape.**
  `db/step-runs.repo.ts` casts the events column to `SessionEvent[]` and
  `issues/artifacts.ts` casts `desired_result` to `DesiredResult`. Both are
  columns this process wrote itself; a full 18-variant re-validation on read
  belongs to the parser that consumes untrusted input, not to a projection that
  copies a row to its caller, reviewed 2026-11-06.

- **`getStepRun` and `listStepRunsByIteration` stay exported and tested.** Production reaches step runs through `listStepRunsWithLog`/`getLatestStepRunForIssue`, but the ordering contract (`created_at`, `rowid` tiebreak) is only observable through the plain list functions; deleting them would delete the tests that pin the tiebreak. They stay as the repository seam, reviewed 2026-11-05.

- **`TaskHeaderCard`, `AgentComposer` and `ReportSection` sit above the target and below the ceiling.** Each is one card: a header with actions, a composer with its own toolbar, a report block with its own action row and a transcript. Splitting them would cut through a single piece of state (`expanded`, `draft`, `report view`) and hand the parent a prop bag, which the size rule explicitly calls worse than a long file, reviewed 2026-11-05.

- **`views/tasks-list/constants.ts` stays one file.** It holds the table lookups for one screen — labels, icons, colors and the readiness order — plus the delete-timeout copy and the status sets. Splitting each table into its own file would scatter four lookups that are read together, reviewed 2026-11-05.

- **`lib/format.ts` stays one file.** Seven formatters over the same inputs (tokens, speed, cost, bytes, paths) that call sites import as a group; a `format/` folder for a handful of functions buys a directory and an index, reviewed 2026-11-05.

- **`IssueStats.tsx` and `ArtifactPreview.tsx` keep their fetch in the component.** Each has exactly one call site, and the cancel flag is three lines next to the state it guards. Extracting a hook used once is the "extract bottom-up" case the standard asks to *not* do until a second consumer appears, reviewed 2026-11-05.

- **`useStepAgentData.ts` keeps its own `loading → ready|empty` transition.** `collectionState` recomputes from the query on every render, while this hook must not clobber an already-loaded list when a background refetch lands — the guard on the current status is the difference, not a copy, reviewed 2026-11-05.

- **`FooterData`/`resolveFooter` stay in `components/SessionStatsBar.tsx`.** Four modules import them, which reads like a domain helper living in a component, but the function is four private helpers (`lastLiveUsage`, `lastStatsEvent`, `finiteOrNull`) plus the type, and the component is their only renderer. Extracting them would move the helpers into a module that no component can explain, to save one import path, reviewed 2026-11-05.

- **`SessionEvent` discriminants stay inline literal types.** The union in `shared/src/types/session.ts` is the single source (`type: 'question'`, `'usage'`, …); `frontend/src/api/sse/parsers.ts` keeps a runtime `Set` of those names because a compiled type union cannot be enumerated at runtime. A frozen object would add a *third* place listing the same names and drift on the next event kind, and the parser's `Set` is the only value-side consumer, reviewed 2026-11-05.

- **`ExecutionMode.single|stages` and the coordinator's `kind: 'wave'|'stages'` stay two vocabularies.** They name the same thing at different layers: the plan decides topology, the coordinator decides shape. The mapping is `stages.length === 1` (a single stage with several executors), it lives in `staged-resolve.ts` and is written down in `DESIGN-NOTES` §3. Collapsing them would put an execution-only distinction into the plan type, reviewed 2026-11-05.

- **`report-render` keeps its own status vocabulary.** `DiagramStatus` (frozen) in `report-render/schema.ts` enumerates `pass|fail|blocked|running|na`: the first three are `StepReportStatus`, the last two exist only in a rendered report diagram, so the set is wider than the domain on purpose. Everything that *is* the domain references the domain — the `report.json` verdict enum is `Object.values(StepReportStatus)`, reviewed 2026-11-05.

- **`DevopsRunDeps` and `PrepareIssueWorkspaceDeps` keep separate bases.** The
  run deps extend `DevopsModelSettings` (model plus thinking level, needed to
  start an agent), the prepare deps extend `DevopsSettings` (no model: that path
  never spawns one). Merging the bases would hand the prepare path a model it
  must not use, reviewed 2026-11-05.

- **`RunStatsLine` keeps its own token cells.** `SessionStatsBar` shows the same
  counters in a different frame: a live session-wide status bar versus one run's
  line inside a card, with different labels and no per-session switching. The
  shared part is the number formatting, and that is already `formatTokens`; a
  shared cell would take a render prop per difference, reviewed 2026-11-06.

- **`useStepAgentData` keeps its own timer.** It is not a second `useStatusPoll`:
  the interval only advances a tick, while the data itself arrives through an
  event subscription with its own per-agent cache, and `useNow` decides whether
  the timer runs at all. The polling protocol `useStatusPoll` owns (fetch,
  cancellation, retry-after) does not appear here, reviewed 2026-11-06.

- **Test files are not source files for the size rule.** A large spec file is a
  flat list of cases that a reader searches, not a module a reader follows; its
  length grows with coverage, and splitting it by `describe` block scatters the
  fixtures shared between cases. The rule applies to what ships, reviewed
  2026-11-06.

- **`pr/bitbucket-mr.ts` stays a dispatch layer over the cloud and server
  modules.** Its four exported functions only branch cloud-versus-server, which
  reads like a middle man, but the split needs `repositoryUrl` unpacked before
  anything else runs. Pushing that unpack into every handler would put the same
  first two lines into two files per operation. The handler table itself lives
  in `pr/http-mr-client.ts`, which owns the choice of implementation, reviewed
  2026-11-06.

- **`planExecutionStages` keeps its clamp even though no caller can reach
  it.** The gate is the single rejection point, so by the time a plan is
  expanded every executor count already sits in range and the clamp is a no-op.
  Removing it would make the function total only for validated input: one future
  call site that skips the gate would then execute a plan with zero executors
  instead of one it cannot run. The invariant the spec forbids is a *silent
  reshape of a valid plan*, and this is not that, reviewed 2026-11-06.
