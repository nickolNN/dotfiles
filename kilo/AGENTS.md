# Rules for all agents

## General rules

- If you need any interaction with human - use "question" tool
- When using any cli tools and getting error before brutforcing
solution invoke -h/--help or similar man action and start your investigation
there

## Markdown Linting

- Rules are in @~/.config/.markdownlint.json
- Use /markdown-lint to check files; run markdownlint-cli2 directly
  for CI-like strict output.
- When creating .md files always restrict your strings to 80 chars

## Prefer delegation

- Always look for a way to decompose task and delegate it to @explore
or @general. Make sure you provide sufficient context and clear
prompt. Subagents should be launched preferrable sequentially

## Efficiency rules

### Schema-first verification

- When dealing with config fields, **always grep the binary/source** for the
  exact schema before writing files
- Example: `grep -aoE '.{60}field_name.{80}' /path/to/binary` reveals the
  exact type structure
- Don't trust skill docs blindly — they're often incomplete or stale
- The actual binary/source code is the authoritative source of truth

### Don't delete until you have the answer

- If a file is invalid, don't delete it — fix it in place after finding the
  correct schema
- Only delete files when you're certain they're wrong AND you have the
  correct replacement ready

### Verify before creating

- Check the schema/format first, then write the file
- Don't create files speculatively — verify the structure matches
  expectations
- Use `kilo config check` or similar validation after writing config files

### Batch exploration

- Batch related searches and related reads together instead of sequential
  exploration

## Internet / browser-backed tools

- Applies to any MCP/tool that drives a real browser against real
  sites (search, fetch, browser automation). Match by behavior,
  not by tool name — new MCPs behave the same way
- Real sites enforce anti-bot limits and throttles. Mimic human
  pacing:
  - Never issue more than one internet call per message; internet
    calls are strictly sequential, never parallel
  - Wait a randomized 2–8s between consecutive internet calls
    (e.g. `sleep <N>` with random N in 2–8 via Bash before the
    next call)
- Use waits productively: process already-fetched results, run
  local analysis, or do other local tool work during the delay —
  do not idle
- Throttle handling ("try again in N seconds/minutes", rate-limit
  responses):
  - Immediately pause ALL internet requests of the waiting queue
  - Resume only after the announced period plus buffer: N+1
    seconds, or N minutes +1 second, per the unit in the response
  - Prefer doing other productive work over raw sleeping; retry
    the queue only after the full wait has elapsed
  - If the retry is throttled again, wait again — at least as long
    as the previous pause — then retry once more

## Context & token efficiency

Cache reads grow with turns x context size. Rules below cut
noise, never signal.

### Session handoffs

- Do not import a full prior-session transcript via `@session` —
  it becomes permanent context re-read on every turn.
- Instead pass a structured handoff:
  - final deliverable (table/list/conclusion)
  - eliminated options with one-line reasons
  - user-stated preferences and constraints
  - benchmark item new options are measured against
- Use `@session` only when the agent must search across many
  turns of history.

### Tool output hygiene

- Prefer structured (JSON) extraction over raw text dumps; keep
  tool results under ~2KB by summarizing in-flight.
- Prefer a dedicated MCP over browser automation whenever one
  exists; fall back to the browser after a single MCP failure,
  never retry a broken MCP in a loop.
- Group related lookups into one call when the tool supports
  batch inputs; do not serialize what can be batched.

### Subagent output schemas

- When delegating data collection, require a return schema that
  carries evidence (review quotes), sub-scores, ranks, and
  warnings — not only headline numbers.
- The subagent retries failures internally and returns only the
  final results; error noise stays out of the parent context.

### Large outputs

- Never re-render unchanged large content; emit a diff or only
  the changed rows/columns.
- Tables with more than ~15 rows: write the full table to a file
  and reference the path in chat.

### Turn budgets

- Coding/implementation: 40 turns, then stop and re-plan.
- Bug diagnosis: 60 turns, then rank hypotheses with evidence.
- Research/comparison: no hard limit; at 100 turns emit interim
  findings and ask whether to go deeper.
- Never reduce the main agent thinking budget to save tokens.
