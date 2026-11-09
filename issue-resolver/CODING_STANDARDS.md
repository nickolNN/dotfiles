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
| `issue-resolver/closed-set-literals` | comparing a field against a literal that is a member of a domain declared in `shared/src` (`status === 'failed'`) | The literal is a silent copy of the domain (see the next section) |
| `issue-resolver/untrusted-json-cast` (`warn` until the four remaining sites are decoded) | `as X` on an HTTP `response.json()`; widening to `unknown` is fine | An HTTP body is untrusted input (see "Untrusted input keeps three states") |

`closed-set-literals` reads its value list from the `Object.freeze({…} as const)`
declarations in `shared/src` at config load, so a new domain is covered without
touching the config. Comparisons that are legitimately not domain reads (wire
discriminants, env values, a screen-local union) are listed in the config's
exception table **with a reason**; that table is the record of the decision, not
a place to park a failure.

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
`issue-resolver/closed-set-literals` reports the comparisons the compiler would
otherwise accept silently.

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
- **Wire discriminants.** A `SessionEvent.type` (`'question'`, `'text'`) is
  compared inline on purpose — a frozen object would be a third copy of the same
  18 names. Those sites sit in the linter's exception table with the reason, so
  they are a decision and not an accident.

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
indirection, not readable code. Those decisions — and the duplications that are
deliberate — are recorded in
[`docs/REVIEW-EXCEPTIONS.md`](docs/REVIEW-EXCEPTIONS.md) so a review does not
reopen them. Add an entry there when a review flags something that is right, and
read it before reporting a file-size or a duplication finding here.

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