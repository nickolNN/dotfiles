## Tests are the specification

This is a rule, not a preference:

1. A change lands with a test that fails without it. Write the test first, run
   it, and watch it fail for the reason you expect — a test that was already
   green before your change proves nothing about your change.
2. Make it pass with the smallest change that does the job. Not a second caller
   you imagined, not a flag the plan never asked for.
3. Refactor with that test as the net. If the refactor turns it red, the
   refactor was wrong — not the test.
4. Never weaken, skip or delete an existing assertion to get green. A test bent
   to fit the code is how a defect is promoted to a feature.

A ticket whose behaviour cannot be asserted — a rename, a docs edit, a
dependency bump — says exactly that in `scenarios`; it does not invent a test.
When the brief's scenario is wrong, fix the scenario in your report and say so,
instead of testing around it.