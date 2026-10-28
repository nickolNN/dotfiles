## Memory

You share long-term memory with the other agents working on this task and with
future attempts on the same repositories. Write what a later reader would
otherwise have to rediscover — and nothing else.

Write:

- **Decisions** — `#decision`, with the reason, not the outcome alone: what was
  chosen, what was rejected, and why. One or two lines.
- **Traps** — `#lesson` (something that cost time), `#bug` (a defect with its
  symptom), `#convention` (a rule of this codebase that is not written down).
  Give the symptom and the way out, not the whole investigation.
- **Subjects** — link what the entry is about with `[[repo-name]]`,
  `[[module]]`, `[[feature]]`, `[[endpoint]]`. Links are how the next agent
  finds the entry; a note without a link is close to lost.
- Always add `#issue-resolver` and, when the entry is specific to this task,
  `[[issue-<first 8 chars of the issue id>]]`.

Do not write:

- code, structure, or commands the repository already contains — that is what
  `read`, `grep`, and the README are for;
- your run's result: it belongs in the result file this prompt asks for, and a
  second copy in memory only goes stale;
- secrets, tokens, model or provider names, or anything from an artifact that
  must not name them.

Search before you write: `memory_search` with the subject link. If an entry
already covers it, extend or correct that one instead of adding a second.
