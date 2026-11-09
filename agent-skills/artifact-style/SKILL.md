---
name: artifact-style
description: >
  How to shape a deliverable an agent produces for a human — a report, an MR
  body, a plan, a spec, a narrated step. Use when writing or reformatting such an
  artifact, when a visual-design or theme skill pulls toward an external
  resource, or when deciding whether a brevity skill (caveman, ponytail) applies
  to the text at hand. Not for chat replies or code.
---

# Artifact style

Chat style and artifact style are separate, and the artifact's own contract
outranks every installed skill — including the example files a skill links to.

## What governs what

| Text | Governed by |
| ---- | ----------- |
| Chat replies, code, diffs | the brevity and code skills — `caveman` (and `ultracave`/`megacave`), `ponytail` |
| Reports the `report` agent compiles (`report.md`, `report.json` → the generated page) | `glyph` |
| Everything else an agent hands down: step result JSON, `iterations/<n>/.<step>.md`, `plan.md`, narratives, MR bodies, handoffs between agents | plain structured markdown — full sentences, headings, evidence |

A brevity skill never rewrites a deliverable: a review finding that lost its
reproduction condition is useless to the next step. That is the whole rule —
the exceptions are per-section, not per-artifact.

When brevity skills and `clean-code` disagree about **the code**, `clean-code`
wins: it is the preferred code doctrine here.

## `glyph`, and its two media

`glyph` belongs to the human-facing report. Its portable core is the same in
both files:

- verdict first, supporting shape after;
- one render per answer — a comparison, a mechanism, a flow or a ranking is
  drawn, not only narrated;
- every status is an icon **paired with its word** (never colour alone), and
  every diagram carries a legend of its values.

Only the medium differs: monospace ASCII art or a Markdown table in
`report.md` (an agent reading the file cannot see SVG), inline `<svg>` on the
generated page. One shape has exactly one carrier per artifact — drawing it in
both is the one combination the engine refuses. Agent-facing artifacts (narratives,
plans, handoffs to peers) get no glyph at all: plain structured markdown.

## Self-contained or it does not count

Our deliverables must render from `file://` and survive being emailed:

- inline CSS, inline `<svg>`, inline vanilla JS — nothing else;
- no CDN `<script src>`, no `@import`, no web fonts, no diagram library
  (mermaid, d3, chart.js), no external images.

`frontend-design` and `theme-factory` inform the visual craft — palette,
typography, spacing, "not a template". The contract outranks them. The pattern
to distrust is a scaffold that reaches for `https://cdn.tailwindcss.com` or a
`jsdelivr` import of mermaid: those examples are written for a throwaway local
page that may assume a network. A skill's example is never authority over an
artifact's contract.

## Never name the model

No model or provider name in an artifact — no `model:` line, no
`provider/model-id`, no «this run used …». Provenance is **which step and which
iteration** produced a claim. Model visibility belongs to the UI and to SSE
`step_status`, never to a file.

## Method skills are called, not imitated

`refine` and `wayfinder` delegate the interview to the `grilling` skill; an
adapter that needs the method reads it there rather than restating it. The same
holds for any skill that names another as its source of truth: a second copy of
the method is a copy that drifts.