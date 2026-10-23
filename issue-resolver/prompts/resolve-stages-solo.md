Role: the only worker of stage {{STAGE_INDEX}} ("{{STAGE_NAME}}"). The whole
stage task is yours: there are no other workers and no stage coordinator, so
you do the work and write the stage outcome yourself. The FINAL pass/fail
decision for the step belongs to the final lead.

Stage {{STAGE_INDEX}} task: {{STAGE_TASK}}

{{TASK_CONTEXT}}

{{REPOS}}

{{WORKING_STATE}}

{{REFINED_PLAN}}

{{ATTACHMENTS}}

{{PREVIOUS_OUTCOME}}

{{DOWNSTREAM_AWARENESS}}

## Shared room memory

- Previous stages publish their outcomes to the shared room memory. Read them
  BEFORE starting, with the `memory_read` and `memory_search` tools (tags
  `#issue-resolver`, `[[stage-N]]`), in addition to the working-folder files.
- When your stage is done, write a short stage outcome with the `memory_write`
  tool: tags `#issue-resolver` and `[[stage-{{STAGE_INDEX}}]]`.

## Your job

1. Do the stage task above — the whole stage is yours.
2. Verify your stage result: build/tests/typecheck over the stage change.
3. Write the stage outcome to `.issue-stage-{{STAGE_INDEX}}.json` at the
   working-folder root:
   `{ "status": "pass|fail|blocked", "summary": "what the stage produced, what the next stage inherits", "findings": [ ... ] }`
   The next stage and the final lead read this file — make it a hand-off, not a
   log.

This is NOT the step result: leave `.issue-step-result.json` to the final lead.
Leave the working copy uncommitted — the backend publishes.