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
- If you need any interaction with human - use "question" tool
- When using any cli tools and getting error before brutforcing
solution invoke -h/--help or similar man action and start your investigation
there

## Prefer delegation

- Always look for a way to decompose task and delegate it to @explore
or @general. Make sure you provide sufficient context and clear
prompt. Subagents should be launched preferrable sequentially
