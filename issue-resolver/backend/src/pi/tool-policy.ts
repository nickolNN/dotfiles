import { join } from 'node:path';
import { PipelineStep } from '@issue-resolver/shared';

export const ROOM_TOOL_PATTERNS: string[] = ['room_*'];

export const SKILLS_ROOT = '/home/agent/.agents/skills';

export const PI_LENS_SKILLS_ROOT =
  '/home/agent/.pi/agent/npm/node_modules/pi-lens/skills';

const SKILL_PATHS: Record<string, string> = {
  'pi-lens-lsp-navigation': join(PI_LENS_SKILLS_ROOT, 'pi-lens-lsp-navigation'),
  'pi-lens-ast-grep': join(PI_LENS_SKILLS_ROOT, 'pi-lens-ast-grep'),
};

const LENS_SKILLS = ['pi-lens-lsp-navigation', 'pi-lens-ast-grep'] as const;

const STEP_SKILLS: Partial<Record<PipelineStep, readonly string[]>> = {
  [PipelineStep.refine]: [
    'refine',
    'grilling',
    'codebase-design',
    'domain-modeling',
    ...LENS_SKILLS,
  ],
  [PipelineStep.resolve]: [
    'clean-code',
    'tdd',
    'codebase-design',
    'diagnosing-bugs',
    'verification-before-completion',
    'agent-browser',
    'frontend-design',
    'ponytail',
    ...LENS_SKILLS,
  ],
  [PipelineStep.review]: ['clean-code', ...LENS_SKILLS],
  [PipelineStep.test]: [
    'agent-browser',
    'verification-before-completion',
    'diagnosing-bugs',
    ...LENS_SKILLS,
  ],
  [PipelineStep.report]: ['artifact-style', 'glyph'],
  [PipelineStep.devops]: ['container-environment'],
};

export function soloRunExcludeTools(): string[] {
  return [...ROOM_TOOL_PATTERNS];
}

export function readOnlyStep(step: PipelineStep): boolean {
  return step === PipelineStep.review;
}

export function stepSkillNames(step: PipelineStep): string[] {
  return [...(STEP_SKILLS[step] ?? [])];
}

export function stepSkills(step: PipelineStep): string[] {
  return stepSkillNames(step).map((name) => SKILL_PATHS[name] ?? join(SKILLS_ROOT, name));
}