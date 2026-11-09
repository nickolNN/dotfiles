# Features — what the system does

Behaviour, in the present tense. The rules that cannot be read off the code are
in [`DESIGN-NOTES.md`](DESIGN-NOTES.md); this file is the map between them.

## Pipeline

Steps run in the canonical order `refine → resolve → review → test → pr`
(`backend/src/workflow/iteration/pipeline-order.ts`), whatever order the API
received. Every step is optional, and the default set is `refine` + `resolve`;
`review` and `test` are chosen independently of each other, and `pr` is added by
`desired_result: 'pr'` (or by `create_mr` on a repository). The engine executes
in canonical order regardless of how the form ordered the checkboxes.

Each step writes `.issue-step-result.json` at the working-folder root
(`status`, `summary`, `scenarios`, `findings`; shape in
`prompts/output-contract.md`). The engine reads it after the step and maps
`pass → success`, `fail → failed`, `blocked → needs_input`. The file counts only
when it was written **during** the step — the engine snapshots the candidates'
mtime before the run, so an untouched file is the previous step's verdict. A copy
left inside a repository clone is read as a fallback and logged as a warning.
With no file at all the exit code decides: `0 → success` (with an empty report
field), otherwise `failed`; the run never crashes on a missing report.

**Feedback loop.** A `fail` from `review` or `test` rolls the pipeline back to
`resolve` with `attempt + 1`, but only when a finding is `major` or `critical`
(`blockingFindings` in `shared/src/step-result.ts`). A `fail` made of
`minor`/`low`/`info` advances like a pass, and a `pass` is never overridden by
severity. The safe side is explicit: a `fail` with no findings, an unreadable
severity or a `findingsMalformed` report is blocking. `MAX_PIPELINE_ATTEMPTS`
(`shared/src/workflow.ts`) is the last line, not the only exit — its
`needs_input(max_attempts)` fires only when blockers remain after the budget.
`{{ATTEMPT_LIMIT}}` and `{{VERIFICATION_MODE}}` carry the number and the round
into the prompts, so no limit is written as a literal in markdown.

**Who proves what.** `review` reads source and proves a defect from `file:line`;
`test` runs the app and proves it from a reproduction. Whoever can prove a defect
files it, and the other mentions it in `summary` — one defect, one development
cycle. A prompt that hands work to a step that may not be in the pipeline is
dead advice; name the condition instead. The rule is `prompts/step-scope.md`,
appended to every step prompt.

**Read-only is enforced, not requested.** The `review` session is spawned with a
pi extension (`backend/src/pi/read-only-extension.ts`) that rejects `bash` calls
which execute code — package managers, language runtimes, build/lint/test
runners, containers, network fetches, mutating `git` (`sed -i`, `find -exec`
included) — and `ast_grep_replace` or a browser-driving tool (`agent-browser`,
`chrome_devtools`, `playwright`). `codemode` stays available but is not a way
around the rule: its nested tool calls go through the same hook, so
`tools.bash(…)` inside a script is blocked and the script fails with the reason.
`write`/`edit` stay available, because the
verdict file is the step's deliverable; inspection commands
(`git status|diff|log|show|blame`, `cat|grep|sed -n|find|ls|wc|jq`) pass. A
blocked call comes back to the agent with the reason, so a round cannot
"verify by running" a suite or a build: anything only running can show belongs
to `test`. The ways around the first-word check are closed too: running a file
(`./scripts/check.sh`), command substitution (`$(…)`, backticks), redirecting
into anything but `/dev/null`, and git config injection (`git -c`, `!` alias).
The tree must come out of the step unchanged, so the mutating file commands
(`rm`, `mv`, `cp`, `touch`, `tee`, `sed -i`) are blocked for the same reason as
`--fix`.
Static analysis is the one execution the step keeps: the linters (`eslint`,
`stylelint`, `prettier --check`, `biome check`, `dprint check`, `ruff`, `mypy`,
`shellcheck`, `tsc --noEmit`) run directly or through `npx` / `pnpm exec`, but
never with a writing flag — `--fix`, `--write`, `fmt` are blocked, because a
review that edits the code it judges destroys its own subject (`--fix-dry-run`
passes: it writes nothing). Allowance is by resolved target, not by runner:
`npx eslint` is fine, `npx vitest` is not, `tsc` only with `--noEmit`, and
`npm run lint` is refused — a script name proves nothing about what the script
runs. A missing extension file is a refusal, not a warning: the spawn throws
rather than run an unguarded review. The prompt states the same ban list, but
the gate is the extension — prose alone lost to an available `bash`.

**Two axes, one verdict.** The review reads its own repository's rules before
judging: `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `AGENTS.md`, the rule files
under `docs/`, and `docs/REVIEW-EXCEPTIONS.md` — a recorded decision is not a
finding, and a change that breaks the reason behind it is. Spec is judged first
(a beautiful implementation of the wrong behaviour is `major`), standards
second, and only feedback a machine does not already produce is filed. The
smell vocabulary (the twelve Fowler heuristics) is a judgement call, capped at
`minor`, so a standards pass never sends the change back on its own.

**Skills per step.** Each step spawns with skill discovery off and an explicit
allowlist (`STEP_SKILLS`): refine gets `refine`, `grilling`, `codebase-design`,
`domain-modeling`; resolve `clean-code`, `tdd`, `codebase-design`,
`diagnosing-bugs`, `verification-before-completion`, `agent-browser`,
`frontend-design`, `ponytail`; review `clean-code`; test `agent-browser`,
`verification-before-completion`, `diagnosing-bugs`; report `artifact-style`,
`glyph`; devops `container-environment`; pr none, because its skill is injected
verbatim. Refine, resolve, review and test also get the two `pi-lens-*` skills,
but the habit comes from the injected `prompts/lens.md`, not from them: the tools
were always present and went unused in every one of 263 pipeline sessions while
`bash` ran 12,148 times. Anything else a step does not see, and `pr` shows what
that saves: the full advertised set costs ~10.5 KB of system prompt in every
session. Resolve's TDD obligation is not left to that allowlist — it is injected
text (`prompts/resolve-tdd.md`).

**Iterations.** An iteration is `number > 1` when it continues previous work: its
prompts carry `Previous iteration outcome` (the resolve step's `status` +
`summary` from the previous iteration plus the result document, capped at ~4000
characters). One issue has at most one `running`, one `pending` and one `draft`
iteration; creating or repeating while one is queued answers `409`, and
`POST /iterations/:id/queue` moves `draft → pending`.

## Workspace preparation

Runs once, when the issue starts: clone each repository through a bare cache
(`originals`), then a deterministic install chosen by the manifest
(`package-lock.json → npm ci`, `pnpm-lock.yaml → pnpm install`, `yarn.lock →
yarn install`, `bun.lock(b) → bun install`, `package.json → npm install`,
`go.mod → go mod download`). A repeat run neither re-clones nor reinstalls — all
iterations work against one checkout.

While it runs, the issue is `preparing` and the iteration `pending`; a clone or
install failure makes both terminal `failed`. Progress is published as SSE
`workspace_progress`: `creating_dirs` → `cloning` per repository →
`checking_instructions` → `devops` per repository without a current instruction →
`installing` → `dev_server` per repository (with the discovered `devPort`) →
`ready`; a dev-server start failure is `status: 'warning'` and does not fail the
preparation. The devops agent's live stdout/stderr rides the normal `log` events
on `issue.<issueId>.devops` and is persisted in `step_runs`/`step_outputs`, so it
survives a restart.

**Devops agent.** For every repository whose `run_instructions` is not
`generated`, the engine runs `prompts/devops.md` with `{{REPO_DIR}}`,
`{{REPO_NAME}}`, `{{DEV_SERVER_PORT}}`, `{{TAG_INSTRUCTIONS}}`,
`{{CACHED_INSTRUCTIONS}}` and `{{CREDENTIALS}}`. The agent inspects the project,
installs and builds it, writes `RUN_INSTRUCTIONS.md` and `DEV_SERVER.sh` into the
clone, and proves the port answers. Success sets `runInstructions` +
`'generated'`; failure clears the text and sets `'failed'`. A previous run's
instructions are passed back as a cache to verify and update, not to trust; the
start script is never cached, because it lives on the disk of one clone. Both
files are infrastructure: `prepareIssueWorkspace` adds them to
`.git/info/exclude` so the `pr` step cannot ship them.

**Port contract.** `allocateDevPort` gives the issue one entry port from
`5100–5299`, stored on `issues.dev_server_port`. The same number goes to every
repository analyzer, and the system starts exactly one `DEV_SERVER.sh` — the one
of the first repository with bootstrap enabled — passing it in `$PORT`, so the
entry script must honour `"${PORT:-<written port>}"`. A new iteration reuses the
port (`reserveDevPort`) and moves only when the old one is busy. A run that
produced no `RUN_INSTRUCTIONS.md` returns the port and clears the column.
Repositories other than the entry point are upstreams on their own ports,
outside that range, recorded in `WORKSPACE_INSTRUCTIONS.md`.

**Micro-frontends.** A shell plus N remotes, each its own repository, all behind
one origin: recognised by `nginx-local/`/`docker-compose.yaml`, a `servePath`/
`baseHref`/`base` subpath, Module Federation (`remoteEntry.js`, `exposes`,
`remotes`) or a runtime `remoteComponentsUrl` key. Docker-in-docker is
unavailable, so the compose file is translated into a native nginx run
(`host.docker.internal → 127.0.0.1`, volume paths → the real build output), with
the proxy config kept at the workspace root as `nginx-workspace.conf` — outside
every repository. A missing nginx falls back to a small Node reverse proxy.

**Tag instructions.** A tag carries `run_instructions` describing how to run the
whole set together (proxy, ports, env), and they outrank the prompt's defaults.
The agent writes `WORKSPACE_INSTRUCTIONS.md` at the task root; after a successful
preparation the engine stores that text on the tag, so the next task reuses it.
A real edit of `tag.run_instructions` through `PUT /tags/:id` invalidates the
`run_instructions` of its repositories (`null` + `'unknown'`); the write-back from
`WORKSPACE_INSTRUCTIONS.md` does not, because it describes one task's ports.

## Execution topology

`refine` sizes the work and declares `execution` in its step result:
`mode: 'single' | 'stages'`, plus `stages[{ index, name, task, executors,
decomposition }]` and a `rationale`. The engine follows it deterministically
(`planExecutionMode`), bounded by `iteration.worker_count`
(`maxExecutorsFor`, fallback `DEFAULT_MAX_EXECUTORS` in
`shared/src/execution.ts`), which is a concurrency ceiling and never a plan
limit.

- `single` — one agent holds the whole change; more than one declared executor is
  a planner error.
- `stages` — ordered stages, each with 1..worker_count workers running at the
  same moment, then a final lead that integrates every stage and writes the step
  result. A single stage with 2+ workers is one parallel wave: no stage
  coordinator, the final lead integrates the workers itself (N+1 agents, not
  N+2). A single stage with one executor is `single` and is rejected.
- A malformed plan (bad `index`, `executors < 1`, a `decomposition` count that
  differs from `executors`, top-level executors on a staged plan, an unknown
  mode) is not executed and not silently reshaped: `refine` re-runs with the
  specific reason from `executionPlanProblem`, spending its own self-retry
  budget; when that is gone the iteration fails and `resolve` never starts.
- Stage outcomes live in `.issue-stage-<i>.json` (workers:
  `.issue-stage-<i>-worker-<w>.json`) and survive a restart only inside one
  iteration and one plan — `runStagedResolve` writes `.issue-stage-manifest.json`
  and drops stale stage files when the plan changed.
- Each staged agent has its own `StepAgent.id` (`run.<stepRunId>.s2.w1`,
  `run.<stepRunId>.s2.lead`, `<stepRunId>` for the final lead), its own SSE
  stream (`/agents/stream?agentId=`) and aggregated stats.

## Report artifacts

On a terminal iteration — and on `POST /issues/:id/report` — a separate agent
compiles the whole task into two files at the task root: `report.md` (for agents,
loadable as task context) and an optional small `report.json` (verdict, metrics,
diagrams). The agent never writes HTML: the engine renders `report.html` from the
pair right after the agent exits (`backend/src/workflow/report-render/`), then
`bin/embed-screenshots.mjs` inlines the screenshots.

Every terminal iteration also writes `report-<n>.md` at the task root — the
engine's mechanical log (step statuses and the raw step reports). It is the
fallback source for an iteration whose agents left no narrative, and the report
agent is told to prefer the narratives over it.

The page is single-file and opens from `file://`: inline CSS with light and dark
themes, a `<dialog>` lightbox, markdown rendered through an escaping subset (raw
HTML stays text, `javascript:` links are neutralised), no external images or
`../` paths. Composition is the renderer's decision, not the author's: `##
Answer` comes first, everything that smells of the run (`execution`, `итерац`,
`шаг`, `timeline`, `change set`, `findings`, `reproduction`) is collapsed into one
`<details>` at the end, MR links are lifted into the header, diagrams land after
the answer text. Diagram kinds are `flow | bars | matrix | svg`; there is no
timeline kind, and a declared diagram whose title words reappear in an ASCII
figure of `report.md` is dropped with a warning — one carrier per shape.

Before each run the previous pair is archived into `<task>/reports/<ISO-ts>/`,
so the agent can only write fresh files and `running` is the only in-flight
signal. While the root is empty, `/result` serves the last completed iteration's
snapshot with `x-artifact-source: iteration-snapshot`; from the root it is
`root`. `/report/status` answers from the newest issue-level `step_runs` row, and
a `running` row whose session is gone is closed as `failed`. `POST
/report/reembed` rebuilds the page from the existing markdown without touching the
authored files.

**Detectors.** Model-leak detection scans the authored files only: the exact id
of the run plus a narrow pattern layer for a foreign id, both surfaced through
`warnings` in `/report/status` and the `x-artifact-warning` header. Reading
`reports/**` or `.iteration-results/**` during the run adds `anchored on previous
report: <path>` to the same channel; the run is never blocked. The pattern layer
is computed on read, so it survives a restart; only the exact-id layer is
process-local. `observedModel` reports the model the session actually named;
`running.step_status.model: null` honestly means "none requested, system model".

**Requested model** has one source for both entry points (`reportModelFor`):
`step_models.report`, else the iteration model.

## Issue-level runs

`report` and `devops` are not pipeline steps: they live in `step_runs` with
`iteration_id = NULL` and `issue_id` set, `attempt` = previous runs + 1, and are
registered under the addresses `issue.<issueId>.report` and
`issue.<issueId>.devops`. Partial unique indexes hold the uniqueness in both
shapes, because SQLite treats NULLs in a `UNIQUE` index as distinct. Their live
session is steerable through the same control routes as a step
(`/iterations/:id/{control,prompt,abort,message}`), and `GET
/issues/:id/{report,devops}/run` returns the stored `StepRunWithLog`, which is how
the UI restores the output panel after a reload.

`POST /issues/:id/devops` restarts the preparation for every repository with
`bootstrap_enabled` (NULL counts as enabled) and an existing clone; it deletes
the old `RUN_INSTRUCTIONS.md`/`DEV_SERVER.sh` first, so a failed agent cannot
inherit a previous success, and records `run_instructions_status` =
`generated | failed`. A second start while one runs answers `409`.

## Live view and pi control

Each step is a live steerable `pi --mode rpc` session (`RpcPiRunner`, transport
`docker | local`) tracked by `InMemoryStepSessionRegistry`. Every SSE stream opens
with `: connected`. `SSEEvent` is `{ type, issueId, iterationId?, stepRunId?,
stream?, data, ts }` with types `log`, `step_status`, `step_event`,
`iteration_status`, `workspace_progress`, `issue_deleting`, `issue_deleted`,
`container_stats`. Structured session events (text, thinking, tool calls,
questions, compaction, retries, queue, notices) are forwarded as `step_event`;
a live `stats` event per ~3 s feeds the footer, and after `agent_settled` the
runner adds `SessionStats` to the step result.

Control: `GET /iterations/:id/control` is a snapshot (`state`, `models`,
`thinkingLevels`, `commands`), `POST` takes a `SessionCommand`, `POST
/iterations/:id/prompt` sends a prompt with `mode` as the streaming behaviour.
Built-in slash commands (`/compact`, `/model`, `/thinking`, `/name`, `/new`) are
intercepted and translated into RPC commands, because pi does not execute them
through `prompt`; commands a client must handle itself (`/cwd`, `/resume`,
`/reload`, `/help`, `/copy`) come back as `handled` no-ops.

**Questions.** Extension UI requests arrive as `extension_ui_request` and become
an SSE `question`; the answer goes back through
`POST /iterations/:id/ui-response`. While a question is open the issue sits in
`question`; Escape closes the modal without answering and leaves the question as
a clickable banner, and a question of a finished run never opens the modal. A
question is eligible for active statuses and for `needs_input` — a blocked run
still has to surface it.

**Abort** always answers `ok`: it cancels the live step or, with no session,
drives the iteration to terminal `cancelled`.

## Publishing

For every repository marked `create MR`, a successful `pr` step commits the whole
working copy as one squashed commit `feat: <task title>` on a feature branch
(`feature/<slug>-<suffix>`, stable across iterations of the task), pushes it and
opens the MR `head = feature → base = <base branch>` with the title and
description from the step result — one `merge_requests[]` entry per repository,
matched by `repository_url`. If an MR already exists for that branch, the engine
pushes the updated commit and refreshes its text (best effort: a failure is
logged, never fatal). The commit uses an explicit identity
(`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`, default
`issue-resolver <issue-resolver@localhost>`), because the container has no git
config. Everything is published only when a `pr` step exists and passed; a
pipeline without it leaves the result as files.

Hosts: GitHub, GitLab, and two Bitbucket APIs — Server/Data Center
(`/rest/api/1.0`, `scm/`, project key) and Cloud (`api.bitbucket.org/2.0`). The
host is resolved from the repository URL, never rebuilt from a PR link. Review
comments are fetched per platform, paged, with a page cap that fails loudly
rather than returning a partial list.

## Test account

A per-repository, human-owned value (`repositories.test_credentials`, written by
`PUT /repositories/:id/credentials`). Agents only read it: it reaches the
`devops` and `test` prompts as `{{CREDENTIALS}}`, and both prompts forbid copying
the password into the step result, a narrative, a screenshot, the report or the
run instructions. With an account the tester must log in and verify against the
real stand; without one a mock is allowed but has to be declared in `summary`,
with the scenarios that depend on it named and their findings kept at
`low`/`info`. When nothing else can judge the change, the verdict is `blocked`.

## Model choice

`GET /models` reads `MODELS_JSON` and answers `[{ id: 'user-default', name:
'Default' }]` when it is empty or broken. A chosen `model` is stored on the
iteration and passed to the pi runner; the report run resolves its model through
`reportModelFor` instead (see above).

## UI

Screens: new task, task list, task detail, repositories, tags, settings. Every
screen shares one content width (`max-w-4xl`), routes are History API without a
hash, and the header holds the «Задачи» / «Репозитории» tabs plus a contextual
«+».

The task page is composition only (`views/TaskDetail.tsx`): a header card with
status, repository preparation (`repo-status`), MR links and the artifact
actions; the iteration island; and per-stateful-concern hooks in
`views/task-detail/`. A running step shows the live session (one growing
`text_update` block, not one line per token); a finished one shows the status chip
and the parsed summary. In staged mode the active `resolve` card gets tabs per
agent (worker 1..N, stage lead, final lead). Run output and transcripts live
behind «Развернуть» in one shared modal frame (`components/ModalShell.tsx`), and
every run kind renders through `components/RunOutcome.tsx` — a new kind is a
`prefix`, not a fourth renderer.

Statuses shown by the UI come from `shared/src/status.ts`: `TaskStatus`,
`StepRunStatus`, `StepReportStatus`.