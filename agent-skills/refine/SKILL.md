---
name: refine
description: >-
  The refine step of the issue-resolver pipeline: wraps the `grilling`
  interview (design tree → frontier → rounds) in the mechanics of the step —
  step input, questions through the `question` tool, `plan.md`, and the
  `execution` object. The method itself lives in the `grilling` skill; this
  file is only the adapter. Use when the refine step of the issue-resolver
  pipeline runs and a raw ticket must become a plan.
---

# Refine — pipeline step adapter

Refine sizes the work and writes the executor's brief. **The method lives in the
`grilling` skill; the step's contract lives in
[`issue-resolver/prompts/step-refine.md`](../../issue-resolver/prompts/step-refine.md).**
This file only glues them: how the interview reaches the user here, where the
answer goes, and what the step must not do.

## Method: grilling

The interview follows the **`grilling`** skill's protocol: it fixes the shape
(design tree → frontier → rounds), the rule "facts yourself, decisions to the
user", and the stopping condition (empty frontier). Only what the original
cannot know is written here.

Adaptation to the pipeline: there is no chat round — there is the **`question`**
tool, one call per question; the call blocks the turn until the user answers and
returns that answer. So the frontier is walked one question at a time, not one
round at a time:

```json
{ "question": "...", "options": [ { "label": "...", "description": "..." } ] }
```

Two to five concrete options, the recommended one first.

## Step input

- Delivered to you by `taskContext` (`backend/src/workflow/prompts.ts`), as
  labeled lines, not as fields: `Task:` (the issue title), `Issue description:`
  (the API's `additional_context`), `Jira text:` when the issue came from Jira,
  `Iteration context:` (the iteration's own context — this is what a repeated
  refine gets to work against), repository working paths, `attachments/…` paths
  when any, and `Previous step feedback (fix exactly this):` when a step is
  retried. Pipeline order arrives as `Enabled pipeline for this run: …`.

## Artifacts (output contract)

- `plan.md` at the root of the working folder — the expanded brief handed to the
  executors. What belongs in it, and what must stay out, is defined by
  `prompts/step-refine.md` §4;
- `.issue-step-result.json` — `summary`, `scenarios`, `execution`;
- `iterations/<n>/.refine.md` — this iteration's record for the report agent: a
  delta (what the input added, what was asked, how you sized the work), never a
  copy of the decisions in `plan.md`; long-term memory gets only cross-task
  conventions and traps, not this task's decisions.

What goes into `execution` and the worker limits is defined by the step prompt
(`prompts/step-refine.md` §3) — not duplicated here.

## Boundaries

The sizing axes, the `single`-versus-`stages` rule, the ownership map and the
"what, never how" boundary are stated once, in `prompts/step-refine.md`. What
this adapter adds is what that prompt cannot know:

- read code only far enough to name the area that owns the work and to check
  whether the capability already exists — opened a file to work out the edit
  itself, and you have left the step;
- judge the size before writing anything;
- decisions go to the user as a question, facts you check in the code yourself;
- no code, no commit — resolve implements, `pr` publishes;
- review and test work belongs to those steps when they are in
  `pipeline_steps`.