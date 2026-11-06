## One step, one axis

Any step can be missing from this pipeline. Each one that runs owns its axis.

- `refine` plans.
- `resolve` implements against the plan, and checks its own change builds and
  passes the existing suites.
- `review` reads: it proves a defect from `file:line` and runs nothing.
- `test` runs: it proves a defect from a reproduction, and judges no names,
  structure or style.
- `pr` writes the MR title and description; the backend commits, pushes and
  opens the MR.
- `devops` writes the run instructions of a repository (`RUN_INSTRUCTIONS.md`).
- `report` compiles.

Whoever can prove a defect files it; the other mentions it in `summary`, so one
defect costs one development cycle, not two.

When work outside your axis blocks you, say so in `summary` and finish your own
deliverable.