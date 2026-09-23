# Rules for all agents

## General

- CLI errors: run `-h`/`--help` first; investigate before
  brute-forcing.
- Markdown: keep all lines under 80 chars; rules in
  `~/.config/.markdownlint.json`; check with `markdownlint-cli2`.

## Tools & execution

- Grep/Glob/Read directly when known — i.e. you can name the
  file, symbol, or pattern. semantic_search for conceptual
  queries; @explore for multi-step discovery; @general for
  multi-step implementation — sufficient context, clear scoped
  prompt.
- Subagents run in parallel; sequential only when one depends on
  another's output.
- Local calls: batch freely (group related lookups into one call
  when supported); internet calls strictly sequential (below).

## Internet & browser tools

- Scope: live external sites (webfetch, browser automation,
  search/fetch MCPs). Local MCPs/offline sources exempt. Prefer
  dedicated MCPs over browser automation; fall back after one
  failure, never retry a broken MCP in a loop.
- Anti-bot pacing: one internet call per message; randomized 2–8s
  wait between calls (`sleep <N>` via Bash, random N 2–8); never
  idle — batch the sleep with local work (process fetched
  results); don't block a turn on sleep alone.
- Throttling ("try again in N seconds/minutes", rate limits):
  pause ALL queued internet requests immediately; resume after
  the announced period + buffer — N+1 seconds, or N minutes +1
  second, per the unit in the response. Prefer productive work
  over raw sleep; if re-throttled, wait at least as long as the
  previous pause, then retry once more.

## Config & schema safety

- Config fields: **always grep the binary/source** for the exact
  schema before writing files — e.g.
  `grep -aoE '.{60}field_name.{80}' /path/to/binary`. Source is
  authoritative; skill docs describe workflows, not schemas —
  verify claims against source.
- No speculative files: check schema/format first, then write;
  validate after writing config files (`kilo config check` or
  similar). Scope: config/schema files (code: "Verify once").
- Invalid file: fix in place after finding the correct schema;
  delete only when certain it's wrong AND replacement is ready.

## Context & token efficiency

Context is write-once cache: everything emitted is re-read every
later turn. Minimize what enters context, not just what you print.

### Session handoffs

- Don't import prior transcripts via `@session` (importing a
  prior session's transcript as context); pass a structured
  handoff instead — except only when the task requires searching
  conversation history that no handoff could capture. Handoff
  carries: final deliverable; eliminated options (one-line
  reasons); user-stated preferences/constraints; benchmark item
  new options are measured against.

### Output size

- Tool and subagent results under ~2KB: summarize in-flight,
  prefer structured (JSON) extraction.
- Tables over ~15 rows or ~2KB: write to a file, reference the
  path in chat. Never re-render unchanged large content — emit
  diffs or changed rows/columns only.

### Subagents

- Research/analysis/comparison returns must carry evidence
  (quotes), sub-scores, ranks, warnings — not headline numbers.
- Returns: final results only — paths, line refs, verdicts,
  minimal diffs; retries stay internal; no dumps, narratives,
  logs.
- Delegate noisy mechanical work (bulk edits, full lint/test
  runs, dead-code scans); subagents return summaries only.
- One scoped task per subagent; state expected answer shape;
  cheapest fitting model — never escalate mechanical work to
  plan-tier.

### Files & edits

- Reference reads: locate via Grep/Glob, then Read only the
  needed window (offset/limit); later, only the missing window.
  Re-read only what changed (subagent, formatter, user); batch
  independent reads into one call.
- Edit targets: read whole once (2000-line cap) before the first
  edit; larger files: windows covering edit region plus margin.
  Never probe with repeated partial reads.
- Plan all changes first; apply edits back to back, no Reads
  between — Edit reports success and match context. 4+
  non-adjacent edits or ~30% rewritten: single Write.
  Read–Edit–Read re-emits the file per cycle — biggest waster.

### Command output & verification

- Shape output at the source: count/filter/list inside the
  command (`--listTests`, exit codes, `wc`). Tests: failures +
  summary line only; never stream a full suite into context.
- Verify once (code verifiers — lint, typecheck, tests): run
  each once per edit batch; never re-run clean suites unless
  later edits invalidate them. Max 2 fix–rerun cycles in main
  context, then delegate the loop (subagent returns failures
  only). Chain verifiers in one Bash call. Stop when verified
  once; no extra loops.

### Phases & turn budgets

- Lean messages: no restating contents, tool output, or plan
  state; no narration; one summary. Tool calls are nearly free;
  turns are not — maximize parallel calls, one edit burst per
  file.
- One phase per session; boundary = intent change (design →
  implementation → verification) or budget hit. Hand off via
  structured summary (deliverable, decisions, constraints);
  never drag a session past its turn budget into the next phase.
- Turn = assistant message with tool calls or user-facing
  decision; near-budget counts are approximate — bias toward
  handing off earlier. Budgets: coding 40 (stop, re-plan); bug
  diagnosis 60 (rank hypotheses with evidence); research 100
  (interim findings, then ask). Budget hit = stop and hand off,
  never continue in place.
