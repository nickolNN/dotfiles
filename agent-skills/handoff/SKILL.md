---
name: handoff
description: Compact the current conversation into a handoff document so a fresh agent can continue the work. Use when wrapping up a session, handing work to another agent, or when the user asks for a handoff.
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the operating system's temporary directory (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming the skills the next agent should load, using each skill's `name`. Pi loads a skill by reading its `SKILL.md`, or the user can force one with `/skill:<name>`.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments after the skill name (Pi appends them to the loaded instructions as a user request, e.g. `/skill:handoff <focus>`), treat them as a description of what the next session will focus on and tailor the document accordingly.
