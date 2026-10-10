---
name: pr
description: Generates an MR/PR description from a feature's diff against the base
  branch. Use it at the pipeline's pr step, when a title and description must be
  prepared for a merge/pull request without creating it manually.
---

# PR / MR — description from the diff

You prepare the **text** of a merge/pull request for changes that have already
been made. Work only with the git repository that is already in the workspace.
Do not push anything or create the MR yourself — the backend (`HttpMrClient`)
does that.

## Steps

1. Determine the base branch (passed in the context, usually `main`, `master`,
   or `develop`) and the current feature branch with the changes.
2. Collect the feature diff against the base:
   - list of changed files: `git diff --stat <base>...HEAD`;
   - the diff itself: `git diff <base>...HEAD`;
   - commits: `git log --oneline <base>..HEAD`.
3. Read the changes and understand: what was done, why, which subsystems are
   affected, what risks exist, and how to verify it.
4. Produce `title` and `description`. If the context contains a Jira key,
   include it in the title (for example, `EXP-1234: ...`).

## Output structure

Return the result strictly as JSON with three fields:

```json
{
  "title": "short title (up to ~72 characters, with the Jira key)",
  "description": "Markdown following the structure below",
  "summary": "1-3 sentences: the gist of the change in plain language"
}
```

`description` — Markdown with the following sections:

- **What was done** — concrete changes by file and subsystem, no fluff.
- **Why** — the task or problem this solves (link to Jira).
- **How to verify** — manual verification steps and/or affected tests.
- **Risks** — backward compatibility, migrations, edge cases; if there are no
  risks, write `none`.

## Forbidden

- **Do not push**: no `git push`, no `git commit --amend`.
- **Do not create** an MR/PR via API or CLI.
- Do not change code as part of this step — only read the diff.

The step's result is a ready description that the backend passes to the MR
client.