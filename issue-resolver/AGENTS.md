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

Which document answers which question:

- `README.md` — Russian, for the human running it: how to start it, env vars, the
  API table.
- `docs/FEATURES.md` — what the system does, in the present tense.
- `docs/DESIGN-NOTES.md` — why, and the invariants the code cannot express.
- `CODING_STANDARDS.md` — the code doctrine; `docs/REVIEW-EXCEPTIONS.md` — the
  decisions a review must not reopen.

## Working rules

- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) is the code doctrine: no magic
  strings for closed sets, statuses declared once as frozen objects in
  `shared/src/status.ts`. Read it before adding a status, a kind or a mode — and
  before reporting a file-size finding: [`docs/REVIEW-EXCEPTIONS.md`](docs/REVIEW-EXCEPTIONS.md)
  lists the files that are at the ceiling on purpose.
- `shared/` is a contract: change it only with the backend and frontend in the
  same commit.
- Tests are the specification of behaviour: a change lands with a test that
  fails without it.
- Verification before reporting done: `npx tsc --noEmit` in `shared/`,
  `backend/`, `frontend/`, then `npx vitest run` in each.

## Language

Code, comments, `docs/`, `prompts/` and this file are English. Russian is
allowed in user-facing strings and test titles, and in `README.md`, which is the
human-facing manual. A rule half-translated between the two reads differently to
the next agent than it was meant.