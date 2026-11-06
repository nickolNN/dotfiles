# Coding standards

These rules exist because a wrong string is a silent bug: `'Failed'` compiles,
matches nothing at runtime, and no test fails until someone reads the database
weeks later. Every rule below is enforceable by reading the diff.

## Machine-checked rules

Some rules are decided by a tool, not by a reviewer. `eslint.config.mjs` is the
single source of truth for **which** rules run and at what severity; this
document is the source of truth for **why** a rule exists and what to write
instead. Do not restate the mechanics here — a rule that changes in the config
would leave a second, stale description behind.

`npm run lint` runs the config over the whole repo and must exit clean.

| rule | forbids | reasoning |
| --- | --- | --- |
| `no-nested-ternary` | a ternary in either arm of another | Control flow stays linear |
| `max-len` | a line longer than 100 characters, counting code only (URLs, strings, templates, regexes and comments are exempt) | Files stay small enough to read |
| `no-lonely-if` | `else { if … }` where `else if` reads the same | Control flow stays linear |
| `no-else-return` | `else` after a returning branch | Control flow stays linear |
| `no-useless-return` | a trailing `return;` that does nothing | Control flow stays linear |
| `no-dupe-else-if` | a branch that can never be reached | Control flow stays linear |
| `no-unreachable-loop` | a loop body that always exits on the first pass | Control flow stays linear |
| `no-constant-binary-expression` | `a ?? b` where one side is always truthy/defined | Control flow stays linear |
| `no-self-compare` | `x === x` used as a null check | Control flow stays linear |
| `no-var` | function-scoped `var` | Control flow stays linear |
| `no-param-reassign` | mutating a parameter instead of a local | One implementation, reused everywhere |

Policy for adding a rule: it lands together with a clean tree — either the rule
is already satisfied everywhere, or the violations are fixed in the same change.
A rule that needs cross-file or project knowledge (`tsc` already answers it, or it
depends on intent) stays a review item and does not enter the config.

- **Do not silence a rule on your own.** Any `eslint-disable` comment — for a
  line, a block or a whole file — needs the owner's agreement before it is
  written, and the default answer is no: fix the code, or narrow the rule in
  `eslint.config.mjs` if the pattern is genuinely legitimate everywhere, or
  leave the failure standing and say why. A suppression hides exactly the defect
  the rule exists to catch, and it outlives the reason it was added.

## No magic strings for closed sets — statuses above all

A **closed set** is a value domain the compiler can enumerate: a status, a kind,
a role, a mode. Never write its members as bare string literals. Declare one
frozen object, derive the type from it, and reference the member everywhere.

Every status domain lives in `shared/src/status.ts`:

```ts
export const StepRunStatus = Object.freeze({
  pending: 'pending',
  running: 'running',
  success: 'success',
  failed: 'failed',
  needs_input: 'needs_input',
  skipped: 'skipped',
  aborted: 'aborted',
} as const);
export type StepRunStatus = (typeof StepRunStatus)[keyof typeof StepRunStatus];
```

`as const` makes the members literal types; `Object.freeze` makes the object
immutable at runtime; the type alias keeps every existing `StepRunStatus`
annotation working. The value and the type share a name deliberately — one
concept, one identifier.

### What the rule covers

- **Comparisons and branches**: `status === StepRunStatus.failed`, never
  `status === 'failed'`.
- **Assignments and payloads**: `{ status: StepRunStatus.running }`,
  `eq(iterations.status, TaskStatus.pending)`, SSE `status:` fields, DB writes.
- **Arrays and sets**: `[StepReportStatus.pass, StepReportStatus.fail]`,
  `new Set([StepRunStatus.skipped])`.
- **Switch labels**: `case StepRunStatus.needs_input:`.
- **Object keys that double as values** must map from the constant, not from a
  repeated literal: `Record<StepRunStatus, string>` keyed by `StepRunStatus.x`.

### What it does not cover

- **Type positions.** `(status: 'question' | 'running') => void` is a type, not
  a value; `TaskStatus.question` cannot appear there. Use the domain type
  (`TaskStatus`) or leave the literal union — the compiler still checks it.
- **Wire data in test fixtures.** A mocked API payload may keep
  `{ status: 'failed' }` when the point of the fixture is the JSON a server
  actually sent. Fixtures that build domain objects (typed as `StepRun`,
  `Iteration`, …) follow the rule.
- **Unions that are not shared.** A screen-local status (`RepoPrepStatus`:
  `'pending' | 'cloning' | 'cloned'`) may keep its literals until it is used in
  more than one module; then it earns its own frozen object next to its
  consumer.

### Adding a domain

1. Add the frozen object and the type derived from it in one module, and
   reference the members everywhere. Status domains both sides read live in
   `shared/src/status.ts`; a domain whose type already lives in its own module
   (`types/pipeline.ts`, `types/repo.ts`, `control.ts`) stays there, because a
   pipeline step is not a status and splitting the type from its values is
   worse than the split this rule exists for.
2. Mirror the wire value exactly as the key (`needs_input`, not `needsInput`):
   a constant you cannot grep for is a constant you cannot migrate.
3. Check the consumers before you add it: a domain both sides read belongs in
   `shared`; one that only a single screen compares stays beside that screen.
   If you keep it local, the same freeze-and-key rules apply.

## Untrusted input keeps three states

A parser that reads JSON, a DB column, an RPC line or a model reply is looking
at data it did not produce. On that input a total function returns **absent**,
**valid**, or **malformed**, and the difference is carried out in the primary
type — a marker such as `decompositionMalformed`, a `{ doc, warnings }` pair, a
discriminated union — never in a dropped field. Silently filtering an element
out is the failure mode this rule exists for: the caller can no longer tell
"not declared" from "declared and unusable", and the dropped value changes the
outcome.

- `tryParseJson` returns `unknown`: a generic `JSON.parse(raw) as T` is a lie
  the compiler cannot check. Callers narrow the value themselves (`asRecord`,
  `Array.isArray`, `typeof`). `readJsonFile` keeps the same contract and takes a
  parser that accepts `unknown`.
- `as` may narrow `unknown` to `Record<string, unknown>` after an object check.
  It may not assign a parsed value to a ready domain type — validate with a
  predicate (`value is StepReportStatus`) and let the guard do the work.
- A malformed value with a single legal spelling (a status enum member) may be
  rejected outright, provided the rejection carries the reason; a malformed
  collection of declared items must keep the marker, because dropping one item
  changes the count the caller reasons about.
- An HTTP body is the same untrusted input: `await response.json()` yields
  `unknown`, and the client narrows it with `requireRecord` / `requireArray` /
  `requireString` / `requireNumber` (`backend/src/util/records.ts`) before any
  value reaches a domain type. A body that fails those checks raises an error
  naming the field, on the same path as an HTTP failure — it is not folded into
  a default, because a missing `clone_url` or PR `id` is not something the
  caller can act on. Validate the fields the client reads, not the rest of the
  provider's envelope, reviewed 2026-11-06.

## Files stay small enough to read

A source file is a unit of reading, not a unit of shipping. Past a few hundred
lines nobody holds the whole thing in their head, the diff of any change is
buried in noise, and every edit risks a region you never looked at. The cap is
part of the standard because "it works" does not survive a 4000-line view.

- **300 lines is the target, 400 is the ceiling.** Measure with `wc -l` before
  and after a split; a refactor that leaves the file over the ceiling is not
  finished.
- **One reason to change per file.** A file that loads data, formats it, holds
  UI state and renders four panes has four. Split along the responsibility
  boundary, not along line count alone: an arbitrary half of one component is
  still one component.
- **Extract bottom-up.** Pure helpers, constants, types and formatting go first
  — they need no props and cannot break behaviour. Only then split components,
  and only then the state.

### Frontend

`views/<view>.tsx` stays a shell. Everything else lives in a sibling folder
named after the view:

```text
views/task-detail/
  constants.ts     labels, colours, literals, thresholds
  types.ts         local types and prop interfaces
  format.ts        pure formatting/lookup helpers
  status.ts        derived-status helpers
  useReportState.ts    one hook per concern, named after what it owns
  InlineQuestion.tsx   one component per file
  IterationList.tsx
  IterationCard.tsx
  StepRunLog.tsx
```

- **One exported component per file**, and it is the default export. Private
  helpers of that component stay in the same file only if they are used by
  nothing else.
- **The old path keeps its exports.** Tests import `./TaskDetail`; a split must
  not force a single test edit. Re-export the helpers the module used to own:
  `export { formatStepDuration, stepChangedFiles } from "./task-detail/format";`,
  and a helper that turned out generic is re-exported from where it moved
  (`export { shortPath } from "../lib/format";`).
- **Group cohesive props instead of flattening them.** A card that needs
  abort/repeat/queue state takes `actions={…}`; its files take `files={…}`; the
  live feed takes `live={…}`. Twenty flat props is the smell that the
  component is doing more than one thing — split it, don't widen it.
- **Pass data, not closures built per render.** Derive inside the child when it
  is one line over props (`liveStatusByRun[run.id] ?? run.status`).

### Hooks carry the state

Once the view is a shell, its remaining bulk is state: fetch, poll, subscribe,
scroll, chat. Each of those is a hook in the view's folder, and the shell calls
it.

- **Cut by state, not by JSX.** The unit is "what changes together" — the
  question that is being answered plus the ids already answered, not the
  `<div>` that happens to wrap both. A JSX-shaped cut leaves the state behind.
- **A hook owns its effects, its refs and its cleanups.** If the caller still
  passes `clearTimeout` callbacks back in, the boundary is wrong. Timers,
  `cancelled` flags and `addEventListener`/`removeEventListener` pairs move
  with the state they guard.
- **Keep the call-site names.** Return fields named exactly as the locals they
  replace (`deleting`, `devopsPhase`, …) and a destructuring call site needs no
  other edit; renaming during extraction is how JSX attributes get rewritten
  by accident.
- **Order is behaviour.** A hook call must keep the effect's position relative
  to the data it depends on: passing a value defined later in the render body
  is a `TS2448`, and hiding that behind an `await` or an extra render changes
  when callbacks fire. Fire-and-forget spawns and "same microtask" guarantees
  documented in tests are part of the contract — a refactor that inserts one
  `await` before the first real call breaks them.
- **Type grouped props off the child.** `ComponentProps<typeof Child>["prop"]`
  beats re-declaring a view-local type in the new module, and it cannot drift
  when the child changes.

### Backend

- A service orchestrates; it does not also parse, format and persist. Pure
  helpers move to a sibling module, the service keeps the sequence.
- Routes are grouped by resource, not by verb count: one module per resource
  area, wired in one place.
- Prompts are data: one module per prompt family, small render functions,
  shared fragments in one place.

### Reviewed exceptions

A file that sits at the ceiling because it is pure wiring has already been
written the way this standard asks; re-splitting it produces props factories and
indirection, not readable code. Record it here so a review does not reopen the
same discussion.

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
- **`# Prompt:` stays duplicated on purpose.**
  `backend/src/workflow/prompts/loader.ts:readPrompt`
  strips the `# Prompt:` header; the devops and retro loaders never did, so those
  prompts reach pi with the header intact. Unifying the behaviour changes the
  prompt text, which is a product decision, not a dedupe, reviewed 2026-11-05.
  What *is* shared is the `{{KEY}}` rendering in `backend/src/prompt-render.ts`.
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
### What is not a split

- Moving code into a `utils.ts` grab bag. A module named after nothing is a
  module nobody finds. Name it after the concept (`format.ts`, `status.ts`,
  `staged-resolve.ts`).
- A file split that keeps the same function, just shorter lines.
- Splitting a file whose export surface then has to be re-assembled by hand at
  three call sites — fix the seam instead.
- Two pollers that differ only in endpoint and how they store the result. The
  rule is worth sharing, the wrapper is not: `views/task-detail/useStatusPoll.ts`
  owns the *protocol* — interval, channel, cancellation, "run again now" ref,
  and the guard that drops answers arriving after the owner went away — while
  each site keeps its own status semantics in `apply`/`onError` (the report
  side counts consecutive failures, the devops side does not). A single generic
  hook that also owned the meaning of the status would have to take a callback
  per distinction and read worse than either original.

## Control flow stays linear

- **No nested ternaries.** `a ? b : c ? d : e` is not a compact `if/else`; it is
  a parse tree the reader has to rebuild before they can read the condition. A
  ternary in either arm of another one is a violation, including one buried in a
  template literal or a JSX child (`no-nested-ternary` in `eslint.config.mjs`).
  Write an `if`/`else`, a `switch`, a named helper or a lookup object instead. A
  single ternary whose two arms are plain values stays fine.

## One implementation, reused everywhere

- `AsyncState<T>` (`frontend/src/lib/async-state.ts`) is the load-state
  vocabulary: `empty` (nothing to show, including a loaded-but-blank list),
  `loading`, `error{message}`, `ready{data}`. Derive list states with
  `collectionState(query, items)` and render them with `CollectionState`.
  Do not force it where the meaning differs: `task-detail/types.ts:StepRunsState`
  needs an `idle` — no iteration selected, so there is nothing to load yet —
  and that is not `empty` (loaded, blank). Merging them would leave the caller
  unable to tell "nothing to fetch" from "fetched nothing".

A second copy of working code is not a variant, it is a future bug with two
fix sites and one of them forgotten. Before writing anything, look for the
thing that already does it — a formatter, a status helper, an endpoint client,
a list row, a modal shell. If it exists, use it.

- **Search before you write.** The repo already owns formatters, status
  domains, API clients, hooks and UI primitives. Reuse them even when the call
  site is awkward; awkward is cheaper than divergent.
- **No forks, no "simplified versions", no parallel twins.** A local copy of a
  shared helper is a bug, not a shortcut. If the shared one is missing a
  capability, extend the shared one — every caller then benefits from the fix.
- **Do not clone to avoid a conversation.** Copying because moving the
  original is "risky" or "not my file" is how three near-identical modals
  appear. If the original sits in the wrong module, move the original and
  re-export from the old path so imports keep working.
- **Duplication found during a refactor gets deleted in the same change.**
  Extraction that leaves the old copy behind has doubled the maintenance cost,
  not halved the file. This is the moment the duplicate is cheapest to kill:
  the new module is being wired anyway.
- **Reuse applies to the shape, not just the name.** Two components that
  differ only in labels, ids or which fields they render are one component
  with props. Two services that differ in one step are one service with a
  parameter.
- **Shared code lives where both callers can reach it.** If frontend and
  backend need the same rule, it belongs in `shared/`; if two views need it,
  it belongs in `components/` or the folder they both already import from.

## Contracts change with both consumers

`shared/` is imported by `backend/` and `frontend/`. A change there lands with
the backend and the frontend in the same commit, or it does not land.

## Tests come with the change

Every change lands with a test that fails without it. A guard clause, a
precedence rule, a fallback — if no test breaks when you delete the line, the
line is unverified.

## Knowledge goes in docs, not comments

Code carries no comments. The reason a non-obvious invariant exists belongs in
`docs/DESIGN-NOTES.md`, next to the decision it explains — see that file's
opening rule.

## Language

Russian only in user-facing strings and test titles. Code, identifiers, commit
messages, and these docs are English.