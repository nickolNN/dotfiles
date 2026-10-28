# issue-resolver — agent notes

## Comments

Code here carries **no comments**. The code is expected to be
self-documenting. The knowledge that cannot be derived from reading a function
(ordering rules, protocol quirks, race guards, failure semantics) lives in
[`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md) — read it before touching
pipelines, pi sessions, the report path, SSE or the DB.

When you add a rule a future reader could break without noticing:

- add it to `docs/DESIGN-NOTES.md`, not as a comment;
- keep directive comments only (`eslint-disable`, `@ts-expect-error`,
  `@vite-ignore`, `@vitest-environment`, shebangs).

## Repository layout

`backend/` Fastify API + pipeline engine (`src/workflow`), `frontend/` React UI,
`shared/` the contract both sides compile against, `prompts/` step prompts,
`bin/` operational scripts, `docs/` design notes.

## Working rules

- `shared/` is a contract: change it only with the backend and frontend in the
  same commit.
- Tests are the specification of behaviour: a change lands with a test that
  fails without it.
- Verification before reporting done: `npx tsc --noEmit` in `shared/`,
  `backend/`, `frontend/`, then `npx vitest run` in each.
- Russian is allowed only in user-facing strings and test titles, never in code
  or documentation.