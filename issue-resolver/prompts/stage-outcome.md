## The stage outcome file

`.issue-stage-{{STAGE_INDEX}}.json` at the working-folder root is your hand-off
to the next stage and to the final lead — a hand-off, not a log:

```json
{
  "status": "pass|fail|blocked",
  "summary": "what the stage produced, what the next stage inherits",
  "findings": [
    { "severity": "major", "title": "...", "detail": "file:line — what is wrong" }
  ]
}
```

Put everything the next reader needs to integrate the stage into `summary`:
files touched, interfaces that changed, anything left unfinished. The stage
verdict does not go to memory and does not go to chat: it belongs in this file
and nowhere else.

This is NOT the step result: leave `.issue-step-result.json` to the final lead.
Leave the working copy uncommitted — the backend publishes.