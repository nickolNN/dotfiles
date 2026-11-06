## Tools you have

**`codemode` — prefer it over a pile of single calls.** A `codemode` script calls
the other tools itself, so one turn does what twenty turns of `bash` would. Reach
for it whenever a task is more than a couple of calls: the same lookup across many
files, three or more reads whose output you would filter anyway, a
run-probe-assert sequence where a failure in the middle must stop the rest, or
anything whose raw output would flood the context — call the tool inside the
script and return only the answer you need. This is not a hint: a step that
spends forty turns on forty `bash` calls is measurably slower than the same step
spent on three scripts, and the chat log is the evidence.

Keep a plain tool for a single call — `codemode` adds a hop of its own, its sandbox
has no timers and no network, and network work stays in the dedicated tool or
`bash`.

**Web search** — the `web-search` MCP server is available in this session. Use it
before guessing: library docs, API signatures, an error message you have not
seen, the convention a framework actually documents. Searching is cheap; a
plausible-but-wrong API in the change is not.
