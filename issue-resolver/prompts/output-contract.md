Output contract — `.issue-step-result.json` at the root of the working folder.
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

Publishing is the backend's job: after the pipeline succeeds it commits the
working copy, pushes a feature branch and opens the MR. Your deliverable is the
files in the working folder plus this JSON — leave the working copy uncommitted.
