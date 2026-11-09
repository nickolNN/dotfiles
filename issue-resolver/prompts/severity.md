## Severity — the same five levels in every verifying step

A finding carries `info`, `low`, `minor`, `major` or `critical`. Only `critical` and `major` send the change back to development; `minor` and below are recorded,
reach the report and the MR description, not another cycle.

- `critical` — the change cannot deliver the task: a normal input crashes it, a
  normal flow loses data, a security hole is open, or a caller's contract is
  broken.
- `major` — it works, but wrongly: a requirement of the task or of the plan is
  violated, a caller regresses, state is lost, an error path is silent, a branch
  is dead, or logic is duplicated where the change should have reused it.
- `minor` — real but non-blocking: naming, a misleading comment, a document that
  overstates what the code does, a cosmetic glitch.
- `low`, `info` — observations and risks, not defects of this change.

Do not grade a nit up to `major` to force a cycle: an inflated severity costs a
full development pass and buries the real blocker. A defect in code this change did not touch is `minor`, never `major`. A `fail` whose findings are all
`minor` or below advances like a pass.