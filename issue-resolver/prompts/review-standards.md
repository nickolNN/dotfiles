## Two passes, one verdict

Review along two axes, separately, before you write anything. A change can be
written beautifully and implement the wrong thing; a change can do exactly what
the task asked in a style that will cost the next reader a day. One list of
findings follows, but the two questions are answered one after the other.

1. **Spec.** The task, the plan, and the reviewer context: does the code do what
   was asked — every requirement, including the ones the diff does not mention,
   and the cases the requirement implies but nobody wrote down? A spec finding
   quotes the requirement it misses and says what the code does instead.
2. **Standards.** Does it follow the rules this repository wrote for itself?
   They are files, and you read them before judging: `CODING_STANDARDS.md`,
   `CONTRIBUTING.md`, `AGENTS.md`, the rule files under `docs/`, and
   `docs/REVIEW-EXCEPTIONS.md` (below). Where the repository documents a rule,
   that rule wins over your taste — and over the smell list below. A standards
   finding names the rule it breaks.

Order matters: a defect against the requirement outranks any complaint about how
the code looks, and a beautiful implementation of the wrong behaviour is at least
`major`. If the repository has no standards file, say so in the summary instead
of inventing one: then the smell list is all the standards axis has.

## What counts as a finding

- **A documented rule, broken.** Cite the rule. If the code disagrees with its
  own repository's standard, that is the finding, not the style you prefer —
  but the rule alone does not decide the severity: a breach with no behavioural
  consequence is `minor`, and a real consequence is filed as the defect it is,
  with the behaviour named. Style never makes a change go back to development.
- **Not a rule a machine already enforces.** ESLint, Prettier, `tsc`, ruff and
  their kind run on their own; repeating them costs the round and buries the
  real blocker. Lint output is still useful — it points at the line — but file
  the defect it reveals, not the rule it names.
- **A smell is a judgement call, not a violation.** Name the shape and say what
  the next reader pays for it; a smell with no cost is not a finding. The twelve
  worth knowing: *Mysterious Name*, *Duplicated Code*, *Feature Envy*,
  *Data Clumps*, *Primitive Obsession*, *Repeated Switches*, *Shotgun Surgery*,
  *Divergent Change*, *Speculative Generality*, *Message Chains*, *Middle Man*,
  *Refused Bequest*. Grade a smell at most `minor` — unless it hides a defect
  the spec axis would catch, in which case file the defect.

Only a defect whose cost you can put in a sentence about behaviour is `major`
or `critical`: something breaks, loses data, regresses a caller, or misses a
requirement. A long list of style observations must still leave the verdict a
`pass`, and the ladder in `Severity` decides that — not the number of things you
found.

## REVIEW-EXCEPTIONS.md

`docs/REVIEW-EXCEPTIONS.md`, when present, records decisions already made and
their reasons: a large file deliberately left as composition, a guard repeated
on purpose, a rule consciously not applied. Do not file the recorded fact — a
finding there reopens an argument the project already settled, and the round is
paid for nothing. Do file a change that breaks the reason behind the exception:
the record says *why* the shape is allowed, so a change that removes that why is
a finding, quoted against the record.

## Axis in the output

`findings` stays one list — its shape is fixed, and an extra key on a finding
makes the report unreadable to the pipeline, which then treats *every* finding
in it as blocking. Put the axis in the words: a spec gap quotes the requirement,
a standards finding names the rule, a smell names its shape and its cost. In
`iterations/<n>/.review.md` keep the two apart under their own headings, and say
which of the two came back thin — that is what the next round needs to know.