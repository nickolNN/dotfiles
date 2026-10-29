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

Refine sizes the work and writes the executor's brief. Two outputs, one decision:
how big the task is and how many executors/stages it needs, and a task
description detailed enough that the executor never has to re-interview the user
or reopen a settled decision. **The method lives in the `grilling` skill;** this
file only glues it to the mechanics of the step.

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

- `title`, `description` (additional_context), `jira_text` (when present),
  `repositories`, `iteration_context` (on a repeated refine), `pipeline_steps`.

## Artifacts (output contract)

- `plan.md` at the root of the working folder — the expanded brief handed to the
  executors: the request in the user's words and what it means concretely,
  decisions with their reasons, behaviour before/after, constraints and
  invariants, one block per executor or stage (naming the area it owns),
  acceptance criteria, risks, and the file ownership map (only so that parallel
  workers never edit the same file);
- `.issue-step-result.json` — `summary`, `scenarios`, `execution`
  (`mode` / `executors` / `decomposition` / `stages` / `rationale`);
- `iterations/<n>/.refine.md` — the step's narrative for the report agent.

What goes into `execution` and the worker limits is defined by the step prompt
(`prompts/step-refine.md`) — not duplicated here.

## Constraints

- **You decide what and why, not how.** The executor designs the edit: which
  files and functions to touch, the current and target code,
  classes/props/signatures, diffs, line numbers. None of that belongs in
  `plan.md` — such a plan duplicates the executor's work and goes stale on its
  first change.
- Read code shallowly and for one purpose: sizing. Where the area is, how big
  it is, does the capability already exist, which file goes to which worker when
  splitting. Opened a file to work out the edit itself — you have left the
  step's boundary.
- Judge size before writing anything: one coherent change in one area is
  `single`. Splitting into a room or stages is a cost paid for genuinely
  independent or genuinely ordered parts, never a default.
- Do not write code — implementation belongs to resolve.
- Do not commit or push — that is the PR step.
- Do not duplicate review/test when they are in `pipeline_steps`.
- Product and design decisions go to the user as a question, not your own
  judgement.