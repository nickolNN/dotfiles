import { PipelineStep } from '@issue-resolver/shared';
import { stepSkillNames } from '../../pi/tool-policy';

export const SKILL_TRIGGERS: Record<string, string> = {
  refine: 'the ticket is still a wish and the interview has not happened yet',
  grilling: 'a plan or a decision needs stress-testing before anyone builds it',
  'codebase-design': 'you must decide where new code goes or where a seam belongs',
  'domain-modeling': 'a name, a term or an invariant in the issue text is ambiguous',
  'clean-code': 'you are about to write the edit, not after it',
  tdd: 'the fix starts here — the failing test comes first',
  'diagnosing-bugs': 'a failure repeats, or does not make sense yet',
  'verification-before-completion': 'before the words done, fixed or passing',
  'agent-browser': 'the change is visible and has to be seen, not assumed',
  'frontend-design': 'the change is UI and the default would look templated',
  ponytail: 'the fix keeps growing and the plan is the suspect',
  'artifact-style': 'before shaping a report a human will read',
  glyph: 'the answer needs a verdict first, or a shape instead of prose',
  'container-environment': 'the container, its ports or its persistence are in question',
  'pi-lens-lsp-navigation': 'a name exists but you cannot say which file holds it',
  'pi-lens-ast-grep': 'the change is a shape or a rename, not one literal string',
};

const HEADING = '## Skills you have, and when to call them';

const LEAD =
  'Each line is a tool call: `skill(ID)` returns that skill\'s instructions. Call it when the trigger matches your situation — before the work it governs, not after. A call at the wrong moment costs a turn; guessing instead costs more.';

export function skillTrigger(name: string): string | undefined {
  return SKILL_TRIGGERS[name];
}

export function skillRouting(step: PipelineStep): string | null {
  const lines = stepSkillNames(step)
    .filter((name) => SKILL_TRIGGERS[name] !== undefined)
    .map((name) => `- \`skill("${name}")\` — ${SKILL_TRIGGERS[name]}`);
  if (lines.length === 0) return null;
  return [HEADING, LEAD, ...lines].join('\n');
}