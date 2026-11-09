import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineStep } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { sessionArgs } from '../src/pi/rpc-spawn';
import {
  PI_LENS_SKILLS_ROOT,
  SKILLS_ROOT,
  stepSkillNames,
  stepSkills,
} from '../src/pi/tool-policy';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

const PROMPT_FILES: Record<PipelineStep, string[]> = {
  [PipelineStep.refine]: ['step-refine.md'],
  [PipelineStep.resolve]: ['step-resolve-single.md', 'step-scope.md'],
  [PipelineStep.review]: ['step-review.md', 'review-standards.md'],
  [PipelineStep.test]: ['step-test.md'],
  [PipelineStep.report]: ['step-report.md'],
  [PipelineStep.pr]: ['step-pr.md'],
  [PipelineStep.devops]: ['devops.md'],
};

const INJECTED_SKILLS = ['pr'];

const LENS = ['pi-lens-lsp-navigation', 'pi-lens-ast-grep'];

const EXPECTED: Record<PipelineStep, string[]> = {
  [PipelineStep.refine]: [
    'refine',
    'grilling',
    'codebase-design',
    'domain-modeling',
    ...LENS,
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
    ...LENS,
  ],
  [PipelineStep.review]: ['clean-code', ...LENS],
  [PipelineStep.test]: [
    'agent-browser',
    'verification-before-completion',
    'diagnosing-bugs',
    ...LENS,
  ],
  [PipelineStep.report]: ['artifact-style', 'glyph'],
  [PipelineStep.pr]: [],
  [PipelineStep.devops]: ['container-environment'],
};

function skillMentions(text: string): string[] {
  return [...text.matchAll(/\bthe [`"]?([a-z][a-z0-9-]*)[`"]? skill\b/gi)].map(
    (match) => match[1],
  );
}

describe('stepSkills', () => {
  it('каждый шаг получает свой набор скиллов, а не всё установленное', () => {
    for (const step of Object.values(PipelineStep)) {
      expect(stepSkillNames(step), step).toEqual(EXPECTED[step]);
    }
  });

  it('пути разрешаются от каталога скиллов контейнера', () => {
    expect(stepSkills(PipelineStep.review)).toContain(join(SKILLS_ROOT, 'clean-code'));
    expect(stepSkills(PipelineStep.pr)).toEqual([]);
  });

  it('скиллы pi-lens лежат не в ~/.agents/skills — путь берётся у пакета', () => {
    const paths = stepSkills(PipelineStep.resolve);

    expect(paths).toContain(join(PI_LENS_SKILLS_ROOT, 'pi-lens-lsp-navigation'));
    expect(paths).toContain(join(PI_LENS_SKILLS_ROOT, 'pi-lens-ast-grep'));
    expect(paths).not.toContain(join(SKILLS_ROOT, 'pi-lens-lsp-navigation'));
  });

  it('--no-skills отключает обнаружение, а --skill возвращает ровно нужные', () => {
    const args = sessionArgs({ skills: stepSkills(PipelineStep.test) });

    expect(args).toContain('--no-skills');
    expect(args.filter((arg) => arg === '--skill')).toHaveLength(5);
    expect(args).toContain(join(SKILLS_ROOT, 'agent-browser'));
    expect(args).toContain(join(SKILLS_ROOT, 'diagnosing-bugs'));
  });

  it('пустой набор всё равно отключает обнаружение: шаг без скиллов их не видит', () => {
    const args = sessionArgs({ skills: [] });

    expect(args).toContain('--no-skills');
    expect(args).not.toContain('--skill');
  });

  it('без флага skills поведение прежнее — обнаружение включено', () => {
    const args = sessionArgs({});

    expect(args).not.toContain('--no-skills');
    expect(args).not.toContain('--skill');
  });

  it('скилл, названный в промпте шага, есть в его allowlist', () => {
    for (const step of Object.values(PipelineStep)) {
      const allowed = new Set([...EXPECTED[step], ...INJECTED_SKILLS]);
      for (const file of PROMPT_FILES[step]) {
        const text = readFileSync(join(PROMPTS_DIR, file), 'utf8');
        for (const name of skillMentions(text)) {
          expect(allowed.has(name), `${step} names "${name}" in ${file}`).toBe(true);
        }
      }
    }
  });

  it('страховка ловит расхождение: промпт шага без нужного скилла — падение', () => {
    const allowed = new Set([...EXPECTED[PipelineStep.review], ...INJECTED_SKILLS]);

    expect(skillMentions('Methodology: the "refine" skill (grilling)')).toEqual([
      'refine',
    ]);
    expect(allowed.has('refine')).toBe(false);
    expect(allowed.has('clean-code')).toBe(true);
  });
});