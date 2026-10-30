Output contract — `.issue-step-result.json` at the root of the working folder
(the "Working folder" block above states its absolute path). Write the file
exactly there, never inside a repository working copy: steps that wrote into a
clone produced runs whose verdict came from another step's report.
It is the single source of truth for this step: the engine reads it to decide
whether the step passed, and the next steps read it as your hand-off. Without
this file the step counts as incomplete.

```json
{
  "status": "pass",
  "summary": "one or two sentences — what you did and what you concluded",
  "scenarios": [
    { "name": "login with a reset password", "expected": "dashboard opens", "actual": "dashboard opens" }
  ],
  "findings": [
    { "severity": "major", "title": "token is not refreshed", "detail": "src/auth/session.ts:88 — expiry ignored on retry" }
  ]
}
```

- `status`: `pass` — the goal of this step is met; `fail` — it is not, say what
  is missing in `summary`/`findings`; `blocked` — you need a decision or an
  access you do not have.
- `scenarios`: one entry per thing you checked, with what you expected and what
  you actually got. Empty array when this step checks nothing.
- `findings`: defects and risks you hand downstream, each with a file:line or a
  flow, so the next agent can go straight to it. Empty array when there are none.

Publishing is the backend's job: once the `pr` step succeeds it commits the
working copy, pushes a feature branch and opens the MR — and only when a `pr`
step exists and passed, so nothing is published when the pipeline stops earlier.
Your deliverable is the
files in the working folder plus this JSON — leave the working copy uncommitted.

## Artifact style

Artifacts that other agents read stay plain: `.issue-step-result.json`,
`iterations/<n>/.<step>.md`, and `plan.md` are machine-readable Markdown or
JSON. `glyph` is never used there, and `caveman` (and its `ultracave` /
`megacave` variants) / `ponytail` (chat/code brevity) do not apply to them.
Never compress a step report to a telegraphic style — a review finding that
lost its reproduction condition is useless to the next step.

**No model or provider name in an artifact.** No `provider/model-id`, no
`model:` line, no "this run ran on …" — in `.issue-step-result.json`,
`iterations/<n>/.<step>.md`, `plan.md`, the MR text, or any report.
Provenance is the step and iteration a fact came from; the model is UI/SSE
metadata, not a file's content.
