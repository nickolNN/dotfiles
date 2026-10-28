# Rules for all agents

## General

- CLI errors: run `-h`/`--help` first; investigate before
  brute-forcing.
- Line length: follow the project's linter/formatter rules for
  code. Markdown files have NO line-length constraint — don't
  waste time reflowing paragraphs. Write naturally.

## Tools & execution

- `bash` (rg/grep/find) plus `read` directly when the target is
  known — you can name the file, symbol, or pattern. pi-lens:
  `symbol_search` for identifier-ish queries, `project_report` /
  `module_report` to orient before you know the file,
  `read_symbol` / `read_enclosing` for one body instead of the
  whole file.
- In pi: `codemode` — for a **local, mechanical batch**: 3+ reads/
  greps whose output you would filter anyway (session jsonl, logs,
  wide `rg`), or the same lookup across many files. One script
  replaces a dozen round-trips. Not for a single call, and not for
  anything that goes over the network (see "Internet & browser
  tools"). Harnesses without it: batch with whatever single call
  they offer.
- Parallel work = room agents: `room_list_agents` to find an idle
  peer, `room_send_message` to dispatch. One writer per file;
  disjoint file sets per task. Sequential only when one depends
  on another's output.
- Local calls: batch freely (group related lookups into one call
  when supported; parallel tool calls in one message for a few);
  internet calls strictly sequential (below).

## Internet & browser tools

- Scope: live external sites (webfetch, browser automation,
  search/fetch MCPs). Local MCPs/offline sources exempt.
  Precedence: dedicated MCP tools first, `agent-browser` as the
  fallback (it is not the default). Fall back after one failure,
  never retry a broken MCP in a loop.
- Anti-bot pacing: one internet call per message; randomized 2–8s
  wait between calls (`sleep <N>` via Bash, random N 2–8); never
  idle — batch the sleep with local work (process fetched
  results); don't block a turn on sleep alone. In pi this rules
  out `codemode` for the fetch itself: its sandbox has no timers,
  so a script cannot pace. Local batches inside a script are fine;
  network calls stay direct, one per message.
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
  validate after writing with what exists here — `jq`, `node -e`,
  `python3 -c "import json…"`. The agent image has no `kilo`.
  Scope: config/schema files (code: "Verify once").
- Invalid file: fix in place after finding the correct schema;
  delete only when certain it's wrong AND replacement is ready.

## Style skills vs artifacts

Chat style and artifact style are separate. Never let a chat
skill rewrite a deliverable:

- `caveman` (and its `ultracave` / `megacave` variants) and
  `ponytail` govern **code and chat replies only**.
  They never apply to artifacts an agent produces — reports, MR
  descriptions, plans, per-step narratives, specs. Those keep
  full sentences, headings, and evidence regardless of how terse
  the chat is.
- `glyph` belongs to the **human-facing report** (the `report`
  agent). Its portable core — verdict first, one render per
  answer, anything with a shape gets a diagram, icon always
  paired with a word, legend of meanings — governs both report
  files. Only the medium differs: the same diagram is monospace
  ASCII or a table in `report.md`, inline `<svg>` in
  `report.html`. Agent-facing artifacts (narratives, plans,
  handoffs to peers) get plain structured markdown: no glyph.
- When brevity skills and `clean-code` disagree about the code,
  `clean-code` wins: it is the preferred code doctrine here.
- `frontend-design` and `theme-factory` inform the visual craft
  of a human-facing artifact (report, MR body). The artifact's
  own contract outranks them: self-contained, no external fonts
  or resources, no libraries.
- The same override applies to **every** installed skill, not
  just the craft ones — including example files a skill links to.
  The pattern to distrust: a scaffold that says `Tailwind via CDN`
  (`<script src="https://cdn.tailwindcss.com">`) and imports a
  diagram library from `jsdelivr` (mermaid). One such skill used
  to ship exactly that; it is out of the build now, but the shape
  repeats. Those examples are written for a
  throwaway local page that may assume a network; our artifacts
  must render from `file://` and survive being emailed. So for
  our deliverables: no CDN `<script src>`, no `@import`, no web
  fonts, no diagram libraries (mermaid, d3, chart.js) — inline
  CSS, inline `<svg>`, inline vanilla JS only. A skill's example
  is never authority over an artifact's contract.
- Method skills are called by name, not imitated: `refine` and
  `wayfinder` delegate the interview to the `grilling` skill.
- **Never name the model or provider in an artifact** — report,
  per-step narrative, plan, spec, MR body. No `model:` line, no
  `provider/model-id`, no «this run used …». Provenance in a
  report means which step and which iteration produced the
  claim, not which model. Model visibility belongs to the UI
  and to SSE `step_status`, never to the deliverable.

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
