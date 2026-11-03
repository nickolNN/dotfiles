## Memory

You share long-term memory with the other agents working on this task and with
future attempts on the same repositories. Write what a later reader would
otherwise have to rediscover — and nothing else.

Write:

- **Decisions** — `#decision`, with the reason, not the outcome alone: what was
  chosen, what was rejected, and why. One or two lines. One `[[resolve]]` entry
  per task at most: the decisions that outlive it — a rule that will change the
  next change, and the file or function where it lives.
- **Traps** — `#lesson` (something that cost time), `#bug` (a defect with its
  symptom), `#convention` (a rule of this codebase that is not written down).
  Give the symptom and the way out, not the whole investigation.
- **Subjects** — link what the entry is about with `[[repo-name]]`,
  `[[module]]`, `[[feature]]`, `[[endpoint]]`. Links are how the next agent
  finds the entry; a note without a link is close to lost.
- Always add `#issue-resolver` and, when the entry is specific to this task,
  `[[issue-<first 8 chars of the issue id>]]`.

Do not write:

- **round verdicts** — the `pass`/`fail` of a review, test or resolve round, and
  lists of what that round fixed. The verdict belongs in the result file this
  prompt asks for, and the narrative beside it; a second copy in memory only
  goes stale, and every later agent re-reads it in the session snapshot;
- code, structure, or commands the repository already contains — that is what
  `read`, `grep`, and the README are for;
- secrets, tokens, model or provider names, or anything from an artifact that
  must not name them.

Search before you write: `memory_search` with the subject link. If an entry
already covers it, extend or correct that one instead of adding a second.