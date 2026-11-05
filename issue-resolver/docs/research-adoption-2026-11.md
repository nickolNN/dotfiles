# What BMAD and DeepSeek Harness do better than us — in plain terms

Status: discussion draft. Nothing here is decided or implemented.

Sources, read from clones at `/tmp/bmad` and `/tmp/dsh`:

| Repo | Version read | What it is, in one line |
| --- | --- | --- |
| `bmad-code-org/BMAD-METHOD` | commit `022be93`, 2026-11-02 (v7 alpha) | A set of instruction files ("skills") that tell an AI coding agent how to run a whole feature workflow: clarify → plan → implement → review → present |
| `deepseek-ai/deepseek-harness` | commit `fcc0ad4`, 2026-11-04 (0.2.2-rc.1) | A complete agent runtime (like pi, but theirs): the engine that talks to the model, runs tools, logs everything, and enforces rules |

---

## 1. Why these two are interesting to us at all

Our application, issue-resolver, does this:

```
ticket (Jira)  ──►  refine  ──►  resolve  ──►  review  ──►  test  ──►  pr
                    plan it     write code   check code   check app   open MR
                    (ask user)                                    │
                        ▲                                         │
                        └──────────── back to resolve ◄───────────┘
                        (with the list of defects as feedback)
```

Each box is a separate AI agent running in pi. The engine moves work from box to
box, retries up to 5 times, streams the live log to the web UI, and at the end a
report agent writes the human-facing report.

**BMAD is the same pipeline, as a methodology instead of as software.** A human
(or an agent) runs BMAD's skills by hand inside their coding tool. So BMAD has
thought very hard about *what the steps should say*, and that thinking is free
for us to read: it's plain markdown.

**DeepSeek Harness is a different layer.** It is not a pipeline for solving
tickets; it's the machinery underneath an agent. But that machinery solves
problems we also hit — a spinning agent, a lying report, a rule we only *ask* the
agent to obey — and they solve them with code instead of with text in a prompt.

So: from BMAD we can take **instructions**, from dsh we can take **mechanisms**.
Neither is something we should copy wholesale.

---

## 2. The one idea both repos share

> **Do not trust what the agent says about its own work.**

We currently do trust it. When the review agent writes `"verdict": "pass"`, we
believe it. When it writes `"verdict": "fail"` with a list of defects, we believe
every defect is real and important. When the report agent writes "12 files
changed, +340 −87", we believe the number.

BMAD's answer: don't trust it, **cross-check it from several directions**, and
have a different role judge the results.
dsh's answer: don't trust it, **measure it yourself** and make the rules
mechanical.

Everything below is a version of that one idea.

---

## 3. Ideas worth taking

Each entry has four parts: what they do, what we do, why it matters (with a
concrete example), and what it would cost us.

### 3.1 Stop the agent that is spinning its wheels

**What dsh does.** A small plugin watches every tool call. If the agent makes the
*exact same call with the exact same arguments* 3 times, it injects a message:
"you just repeated this call — look at the result, change your approach or
finish". At 5 repeats it says it more firmly, at 8 again. It never blocks the
call, it only reminds. The counter resets when a new user message arrives.

**What we do.** We only watch for *silence*. If an agent produces no output for 15
minutes we nudge it, then compact its context, then kill it. If the agent is
happily typing but going in circles — searching for the same file 20 times,
re-reading the same 500-line file, retrying the same failing test — our watchdog
sees a perfectly healthy, active agent. The 3-hour budget for the resolve step
just burns down.

**Why it matters.** Concretely: an agent is told "make the login form show an
error". It edits a file, runs the test, the test fails, it reverts the edit, runs
the test, it fails, it edits the file again the same way… Our log shows continuous
activity. Our report says "timeout". Nobody knows the agent was stuck on the same
idea for two hours. A repeat-counter would have caught it at repeat #3 and said
"this exact call already failed twice — try something else".

**Cost.** Small. We already receive the events: pi sends us
`tool_execution_start` with the tool name and its arguments
(`backend/src/pi/rpc-runner.ts:348`). The nudge mechanism already exists
(`backend/src/pi/stall-recovery.ts` builds the ladder nudge → compact → kill). We
would add a second trigger to that same ladder: "no output for 15 min" **or**
"same call 3 times". No shared-contract change, no frontend change, no prompt
change.

**My take: do this first.** Best value per line of code in this document.

---

### 3.2 Make the reviewer report *more* than one defect

**What BMAD does.** Its review runs several independent reviewers ("lenses" —
each one a separate agent with one narrow job), and one of them is a "blind
hunter" with an unusual instruction:

> Compute your finding floor N from the size of the diff: N = min(⌊√kB⌋ + 1, 10),
> where kB is the diff file's size in kilobytes. State the arithmetic in one
> line, then find at least N issues.

So a 100 KB diff forces at least 10 findings, a 4 KB diff forces at least 3. If
the reviewer comes back with zero findings it is told "re-check and keep
thinking; do not stop with an empty list".

**What we do.** Our review prompt says the right thing in prose:

> A review exists to produce the COMPLETE list of what is wrong, not its first
> item… A round that reports one defect and leaves the next one for the following
> round costs a whole development cycle per leftover finding.

…and then nothing checks whether the agent actually did it. An agent that finds
one real bug and stops has followed our instructions as far as anybody can tell.

**Why it matters.** Our loop is expensive. Review says fail → the whole resolve
step runs again (up to 3 hours) → review again. If the reviewer reported 4
defects instead of 1, we save up to three full cycles on one ticket. The floor
turns "be thorough" from a hope into a number.

**Cost.** A few lines of prompt. The engine already knows the change size — but
even without computing it in the engine, we can tell the reviewer to compute it
itself from `git diff | wc -c`.

**Risk, honestly.** A forced floor produces filler: "this variable name is
unclear" invented to reach the quota. BMAD accepts that because of §3.3 — a
separate triage step throws the filler away. If we take the floor we should take
the triage discipline with it, or explicitly allow "zero findings, here is why".

---

### 3.3 Grade the findings, don't just collect them

**What BMAD does.** Two rules that look small and change everything:

1. **Reviewers are forbidden from assigning severity.** Every lens prompt ends
   with "Output a Markdown list of findings only — no severity, priority, or
   ranking." The reason: a reviewer looking at one slice of the change has no
   idea how much a defect matters, so its grading is noise.
2. **A triage step judges afterwards.** One agent collects every finding and, for
   each one, answers two separate questions in order:
   - *Is it real?* Can that bad behaviour actually happen at that file and line?
     Follow the callers, look for a guard upstream. "A finding that says 'this
     throws when X' is only real if you can show that X happens." An assert on a
     state the program can never reach is defensive programming, not a defect.
   - *How bad is one occurrence?* `high` = data loss, security hole, silently
     wrong result, or a broken path with no workaround. `medium` = broken but
     noticed or limited in reach. `low` = cosmetic. Plus `false` (with the
     evidence that disproves it) and `maybe-false` (say what would settle it).

   Severity depends only on impact — never on how rare it is, how hard it is to
   fix, or whether the bug predates this change.

   Then it routes each one: `patch` (fix now), `decision_needed` (a human must
   choose — do not guess, even in an unattended run), `defer` (not this change's
   problem).

   Two explicit anti-shortcuts: don't drop finding B because it looks similar to
   finding A you already rejected, and don't forget any finding — the triage file
   is the only source of truth, "a decision that is not in it does not exist".

**What we do.** The review agent writes `findings` and that list goes straight
into the next resolve attempt as feedback. There is no grading discipline, no
check that a finding is real, and no distinction between "this will corrupt user
data" and "this comment has a typo".

**Why it matters.** In our pipeline **every finding costs a full development
round.** A finding is not free speech here — it triggers up to 3 hours of agent
work. Right now a cosmetic nit has the same power to trigger that as a security
hole. The opposite failure is worse: a real `high` finding mixed in with five
cosmetic ones gets fixed sloppily, because the next agent treats the list as
noise.

**Cost.** This is the expensive one, because it is a design question, not a
prompt edit:

- Option A (cheap): tell the review agent to do both jobs — first list everything,
  then re-read its own list and grade/route each item before writing
  `.issue-step-result.json`. Loses the independence that makes triage useful
  (same agent, same blind spots), but costs only prompt text.
- Option B (real): add a `triage` step between review and test. Needs a new step
  in the canonical order, DB rows, frontend rendering, report changes, tests.
- Option C (middle): keep one review step but run the reviewer as a *lens fan-out*
  — several parallel reviewers with narrow mandates, then one triage agent
  consolidates. We already have the machinery for parallel agents (rooms), so
  this is mostly prompt + a topology choice. Costs more tokens per task.

**My take:** start with Option A now (free), decide about B/C after we can
measure whether it helped (§3.8).

---

### 3.4 Give the reviewer a job description, not a general mandate

**What BMAD does.** Instead of "review this code", it has two specialists whose
prompts are worth reading in full (`/tmp/bmad/skills/bmad-code-review/review-prompts/`):

- **Edge-case hunter.** "You are a pure path tracer. Never comment on whether
  code is good or bad; only list missing handling." It mechanically walks every
  branch reachable from the changed lines and reports only the ones with no
  guard. No opinions, no severity, no editorializing.
- **Verification gap.** "Find behaviour this change altered that could break
  later without any test failing." Four named shapes:
  1. *regression gap* — the changed code could break where it is used and no test would fail;
  2. *missing-adoption gap* — a place that should use the new behaviour still does it its own way, and no test catches that;
  3. *broken-verification gap* — a test looks like it covers the change but doesn't (skipped, flaky, not run in CI, too weak);
  4. *stale-verification gap* — a test this change made wrong or obsolete; it may still pass.
  And the rule: "A gap finding is a request to add or change one test. File it
  only when you can name a specific regression that test would catch."

**What we do.** Our review agent is a generalist: read the change, read the
touched files, check every requirement, look for regressions and edge cases and
convention violations. All at once, in one pass. Our test step separately
verifies the running app in a browser (that part is genuinely better than BMAD's,
which mostly reviews by inspection).

**Why it matters.** A generalist mandate produces whatever the model feels like.
A narrow mandate produces a specific class of finding reliably. The
"broken-verification gap" in particular is something we can never catch today: an
agent writes a test that always passes, our test step sees green, the review says
pass, and the change ships with no real coverage.

**Cost.** Prompt-only. Copy the two job descriptions, adapt the wording to our
context (we have multiple repositories, they assume one).

**One more thing worth stealing:** BMAD deliberately *hides* the change author's
own claims from the edge-case reviewer until the last step of its analysis —
otherwise the reviewer anchors on what the author said. Our review prompt tells
the reviewer to read `.issue-step-result.json` (the resolve agent's own report)
first. That primes the reviewer with the author's story.

---

### 3.5 Ask "is this ticket two tickets?" before planning

**What BMAD does.** Before it plans, it checks whether the intent contains more
than one independently shippable goal, with a precise test:

> Multi-goal means ≥2 top-level independent shippable deliverables — each could
> be reviewed, tested, and merged as a separate PR without breaking the others.
> Never count surface verbs, "and" conjunctions, or noun phrases.

If yes, it stops and asks the human: **Split** (do the first, defer the rest into
a `deferred-work.md` ledger with the reason) or **Keep all goals** (accept the
risk). Examples it gives: "add dark mode toggle AND refactor auth to JWT AND
build admin dashboard" = split. "add validation and display errors" = one goal,
do not split.

**What we do.** Our refine step decides *topology* — how many agents, in what
order (`single` / `room` / `stages`). It never questions *scope*. A ticket with
two unrelated goals becomes one plan, and the plan splits it into parallel
workers.

**Why it matters.** Splitting into parallel agents is the expensive way to solve
a scope problem: two workers, one MR containing two unrelated changes, a review
that has to hold both in its head, a test round that can fail for either reason
and re-runs both. The cheap answer is "these are two tickets, here is the second
one" — and we never even consider it.

**Cost.** Prompt-only: one gate in the refine step. The question is whether the
refine agent should *ask the user* (we have the question mechanism for exactly
this) or just *report* the split in the plan. I'd ask — refine is already the
step allowed to ask.

---

### 3.6 Have a definition of "this plan is good enough to hand over"

**What BMAD does.** A written standard a plan must meet before implementation
starts:

- **Actionable** — every task names a file and an action
- **Logical** — tasks ordered by dependency
- **Testable** — every acceptance criterion is Given/When/Then and provable without pointing at code
- **Complete** — no placeholders, no TBDs
- **Sufficient** — no known requirement, acceptance, dependency or implementation gap left unresolved
- **Coherent** — no unresolved ambiguity or internal contradiction

Plus a size target: 900–1600 tokens. Below 900 the plan is too vague; above 1600
the implementation agent gets "context rot" (too much plan, it starts ignoring
parts).

**What we do.** `plan.md` is capped at 12,000 characters and we mechanically
check two things: does the file exist, and does it cite line numbers like
`file.ts:335` (which we forbid, because a plan that names lines duplicates the
executor's job and goes stale on its first edit). Both problems surface as
warnings in the run log. Everything else about plan quality is unmeasured.

**Why it matters.** Our own design notes say the plan is the executor's brief and
that decisions settled in the interview must not be re-litigated downstream. The
readiness standard is the checklist for whether that actually happened. "No
placeholders or TBDs" alone would catch a large class of bad plans — the executor
gets a plan saying "add validation where appropriate" and invents the requirements.

**Cost.** Prompt-only for the standard itself. Optionally a mechanical check for
`TBD`/`TODO`/placeholder markers in `plan.md`, added next to the existing
`planShapeWarnings`.

---

### 3.7 Compute the change set ourselves; don't ask the agent to type it

**What dsh does.** A plugin takes a git snapshot of the working tree at the start
of a turn and another at the end, diffs them, and records which files changed
with line counts. It also copies whole files before/after edits for files git
can't see. The result is shown in the UI and stored as a durable event. Its own
guarantee: the user's *earlier* uncommitted changes never leak into the summary.

**What we do.** The report prompt instructs the report agent to run
`git diff --stat` per repository and paste the output into the report:

```
#### <repo-name>
    <N> files changed, +A −D
    file/one.ts      | 12 +++++
```

**Why it matters.** Three problems with asking an agent for a number: it can run
the command wrong (wrong base branch, forgotten repository), it can paraphrase,
or it can just not run it and produce a plausible-looking table. The report is
the artifact a human reads to decide whether to merge — it's the worst place for
a fabricated number. And we already have everything needed: the engine owns the
workspace, the repository list and the base branch, and we already do exactly
this trick for two other things (the engine lifts MR links into the report
header, and the engine — not the agent — inlines screenshots).

**Cost.** Small-to-medium. Compute the diffstat in the engine after the pr step,
then either (a) inject the real numbers into the report prompt as a fact the agent
must not retype, or (b) have the report renderer print the table itself and drop
that section from the prompt. (b) is more in line with how we already treat MR
links.

---

### 3.8 Actually forbid what we only ask for

**What dsh does.** Tool calls go through a pipeline: policy checks first, then
registered "guards" that can deny or abstain, then a human approval prompt if
needed, then execution. Filesystem writes go through an explicit intent gate. The
point: a rule that matters is *enforced*, not requested.

**What we do.** Our review prompt says:

> READ-ONLY means the change set: you do not edit source, do not run builds,
> tests or browsers — those belong to the `test` step, stay fast.

And our tool policy is: exclude the room tools (`room_*`) when running solo. That
is the whole policy. Nothing stops the review agent from editing the code it is
reviewing.

**Why it matters.** If the review agent "helpfully" fixes the bug it found, the
review is worthless — the diff it judged is no longer the diff we ship, the
resolve step never learns, and the report's findings list describes a change that
was made by an unaccountable third party. Same for the test step, which we also
only *ask* not to touch source.

**Cost.** Needs one design decision, because our review agent legitimately writes
two files (`.issue-step-result.json` and `iterations/<n>/.review.md`). Either:
- pi's tool policy can express "write only these paths" — then it's a config change; or
- we stop asking agents to write result files at all and parse the verdict from
  the agent's final message — bigger change, but removes the exception entirely; or
- the engine checks after the step whether anything outside the allowed files
  changed, and marks the step invalid if so — a detector rather than a preventer,
  but cheap and honest.

I'd start with the third (detect and fail loudly), and treat the first as the
real fix once we know what pi's policy can express.

---

### 3.9 Distinguish "the code is wrong" from "the plan is wrong"

**What BMAD does.** When a review finding's root cause is the plan rather than
the implementation, it loops back to *planning*, not to implementation, and
records what changed in an append-only "Plan Change Log" inside the plan file.

**What we do.** `shared/src/workflow.ts` has exactly one failure transition:
`retry_resolve`. Every failure of review or test sends the work back to the
executor, with the findings attached as feedback.

**Why it matters.** Consider a plan that says "add the new field to the existing
user table". The executor implements it faithfully. Review correctly finds that
the field belongs on a separate table for normalization reasons. Our engine
re-runs resolve with that finding — but the executor is told to follow the plan,
and the plan still says the wrong thing. Best case the executor overrides the
plan (which we allow "where the code contradicts it") and we get an
inconsistency between plan and code. Worst case it re-implements the same wrong
design and we burn rounds until the retry limit, then `needs_input`.

**Cost.** Real, and it touches the contract: add something like
`root: 'code' | 'plan'` to a finding (shared types), add a `replan` transition
that re-runs refine with the finding as input, show it in the frontend, test it.
This is the one item here that I'd want to do as a proper designed change, not a
patch.

---

### 3.10 Retro: every claim must point at evidence

**What BMAD does.** Its retrospective skill reads the artifacts an unattended run
left behind (tickets, plans, diffs, commits, session logs) and states one hard
rule:

> Every finding you report carries a source reference (file, line, commit, or
> log). A claim you cannot point at — an invented root cause, a pattern the diff
> does not actually show — is not a finding. Drop it.

Plus: never state time estimates ("AI has changed development speed, so
hour/day/week predictions are noise"), and when running headless, record every
assumption made without a human into an Assumptions section so the audit trail
survives.

**What we do.** Our `prompts/retro.md` runs unattended over pi session logs and
our SQLite database and writes a retrospective. There is no evidence rule.

**Why it matters.** An unattended retro with no evidence rule produces confident
invented root causes, which we then fold into long-term memory, which then
influences future tasks. That's a contamination path, not a documentation issue.

**Cost.** Three sentences of prompt. Probably the cheapest item on this list.

---

### 3.11 Let a repository tune its own prompts

**What BMAD does.** Every skill ships a `customize.toml` with typed knobs
(`route` = oneshot/full/auto, `review` = none/quick/thorough/auto, `fixes` =
apply/handoff) and three override layers: the skill's defaults, then
`_bmad/custom/<skill>.toml`, then `<skill>.user.toml`. Merge rules are explicit
(strings replace, lists append, arrays-of-tables merge by id). Invalid values
stop the run immediately with a message rather than being silently ignored. There
is also `persistent_facts`: literal sentences or `file:` globs loaded once at
activation and kept in context for the whole run.

**What we do.** Prompts are static markdown files with `{{VARIABLES}}` filled in
by the engine. The only per-task injection is the review context (focus points
from the task owner). To make one repository stricter in review, you edit the
application.

**Why it matters.** Different repositories genuinely want different things: a
design-token package doesn't need a browser test round; a payments service wants
a paranoid review; a docs repo wants no review at all. Today that's a fork.

**Cost.** A product decision more than a refactor: where do per-repo overrides
live (the repository itself? our DB? a file in the working folder?), who can edit
them, and how do we keep them from silently rotting. I'd park this until we have
two or three repositories actually asking for it.

---

### 3.12 Measure whether a prompt change helped

**What BMAD does.** A skill called `bmad-eval` runs four kinds of test against
any skill:

| Mode | Question it answers |
| --- | --- |
| baseline | Does the skill beat the bare model on the same input? |
| variant | Does this section earn its place, or does a stripped version do as well? |
| quality | Does the output meet a written rubric? |
| trigger | Does the description fire on the right requests and stay quiet on the rest? |

Test cases are `input + rubric + optional fixtures` in a JSON file. Each case runs
in a clean temporary folder so the host's config and history can't bias the
result. dsh has the same instinct at harness level (`benchmarks/`: session
corpus, agent continuation, long-session browser).

**What we do.** `e2e/` has five mock scenarios (all-success, step-failure,
agent-question, concurrent-questions, bootstrap-failure). They verify plumbing:
does the engine advance, does the UI render, does a failure loop back. They would
pass identically with a much worse prompt, because the agent is mocked.

**Why it matters.** Items 3.2, 3.3, 3.4, 3.5, 3.6 and 3.10 in this document are
all claims that some wording produces better agent behaviour. Today we have no
way to know. We would be trading one opinion for another.

**Cost.** Medium, and it's the only item here that isn't about the pipeline. A
minimum useful version: 5 fixed inputs (real tickets we've already run), a
written rubric per step, a script that runs refine/review on them, and a human
grading the output. Run manually before and after a prompt change, not in CI.

---

## 4. Things we should NOT copy

| Idea | Why not |
| --- | --- |
| dsh's Cordis framework (everything is a plugin) | Our adapters (docker/git/pi/MR/Jira) already are the seams that matter. A plugin framework at our size buys configuration surface, not flexibility. Their `capability-seams.md` is still a good read on what a seam is. |
| BMAD's ticket tree + Python scripts (`tickets.py`, `render_skill.py`, uv) | A second source of ticket truth next to Jira and our own DB, plus a Python toolchain in the loop. |
| dsh's model-authored orchestration (`workflow` tool: the model writes a script that fans out subagents; `ralph`: loop until done) | The opposite of our deliberate choice. Our design notes say the engine follows the plan deterministically. Letting the model author the orchestration makes the topology unauditable and moves failures from "wrong plan" to "wrong orchestration code". Worth knowing it exists as the road not taken. |
| dsh's per-tool human approval | Our human-in-the-loop is the refine interview and the question modal, which is the right granularity for a ticket pipeline. |
| i18n sidecars, docs website, plugin marketplace | Not our problem. |

---

## 5. Ranked by value ÷ cost

| # | Item | Type | Touches | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Repeat-call nudge (3.1) | mechanism | `pi/stall-recovery.ts`, `pi/rpc-runner.ts` | Do now. Small, contained, fixes a real silent failure. |
| 2 | Retro evidence rule (3.10) | prompt | `prompts/retro.md` | Do now. Three sentences. |
| 3 | Mechanical change set (3.7) | mechanism | report renderer / report prompt | Do soon. Removes fabricated numbers from the human-facing artifact. |
| 4 | Detect review/test writes (3.8) | mechanism | engine step post-check | Do soon as a detector; design the real enforcement later. |
| 5 | Reviewer job descriptions (3.4) | prompt | `prompts/step-review.md`, `step-test.md` | Do soon. Free, but see #8. |
| 6 | Scope split gate (3.5) | prompt | `prompts/step-refine.md` | Do soon. Free. |
| 7 | Plan readiness standard (3.6) | prompt | `prompts/step-refine.md` | Do soon. Free. |
| 8 | Finding floor (3.2) | prompt | `prompts/step-review.md` | Only together with #9, otherwise it manufactures filler. |
| 9 | Triage / grading (3.3) | design | prompts, possibly a new step | Decide: cheap in-prompt version now, or a real step later. |
| 10 | Plan-defect route (3.9) | contract | `shared/`, engine, frontend, tests | Real project. Worth it, but design it properly. |
| 11 | Prompt evals (3.12) | tooling | new `evals/` harness | The only way to know if 5–9 worked. Build before or right after. |
| 12 | Per-repo prompt overrides (3.11) | product | config model | Park until repositories ask. |

---

## 6. Questions for you

1. **Where do we start?** My recommendation: items 1–4 (mechanisms, no opinion
   involved), then the prompts. Or do you want review quality first?
2. **Review cost.** Running several independent reviewers per round multiplies
   tokens on every task. Do we always do it, or gate it on ticket size/risk the
   way BMAD gates on `review = none|quick|thorough`?
3. **Triage: same agent or separate step?** A separate step is honest but changes
   the canonical order, the DB, the frontend and the report. Same-agent grading is
   free but weaker.
4. **Plan-defect route (3.9).** Worth a proper design pass now, or later?
5. **Prompt evals (3.12).** Do you want to invest in measuring prompt changes, or
   keep changing prompts on judgement? This decides how confident we can be about
   half of this list.
6. **Docs.** dsh keeps engineering rules as per-artifact pages with a routing
   table ("changing X → read Y") and a `rejected/` folder of decisions they
   decided against. We keep everything in one 315-line `DESIGN-NOTES.md`. Split it
   and add a decisions folder, or leave it?