# Coding standards

These rules exist because a wrong string is a silent bug: `'Failed'` compiles,
matches nothing at runtime, and no test fails until someone reads the database
weeks later. Every rule below is enforceable by reading the diff.

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

1. Add the frozen object and derived type to `shared/src/status.ts` — nowhere
   else. `shared/` is the contract: backend and frontend read the same members.
2. Mirror the wire value exactly as the key (`needs_input`, not `needsInput`):
   a constant you cannot grep for is a constant you cannot migrate.
3. Update this file's list if the domain is new to the codebase.

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