import { PipelineStep } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { stepSkillNames } from '../src/pi/tool-policy';
import { buildStepPrompt } from '../src/workflow/prompts';
import { SKILL_TRIGGERS, skillRouting, skillTrigger } from '../src/workflow/prompts/skill-routing';

const base = {
  issueTitle: 'Поправить вход в личный кабинет',
  description: 'Описание задачи',
  jiraText: null as string | null,
  context: 'Пользователь не может войти после сброса пароля.',
  feedback: null as string | null,
  refinedPlan: null as string | null,
  repoPaths: ['/workspaces/issue-1/app'],
  desiredResult: undefined as 'md' | 'html' | undefined,
  attachmentPaths: undefined as string[] | undefined,
  workingDir: undefined as string | undefined,
  previousOutcome: null as string | null,
  reviewContext: null as string | null,
  pipelineSteps: undefined as PipelineStep[] | undefined,
  devServerPort: null as number | null | undefined,
  credentials: null as string | null | undefined,
  prTargets: undefined,
  workerCount: undefined as number | undefined,
  iterationCount: undefined as number | undefined,
  attempt: undefined as number | undefined,
};

const STEPS_WITH_SKILLS = [
  PipelineStep.refine,
  PipelineStep.resolve,
  PipelineStep.review,
  PipelineStep.test,
  PipelineStep.report,
  PipelineStep.devops,
];

const STEPS_WITHOUT_SKILLS = [PipelineStep.pr];

function prompt(step: PipelineStep): string {
  return buildStepPrompt({ ...base, step });
}

describe('расписание скиллов: каждый скилл из набора шага знает свой триггер', () => {
  it.each(STEPS_WITH_SKILLS)('%s: нет скилла без триггера', (step) => {
    for (const name of stepSkillNames(step)) {
      expect(skillTrigger(name), `у скилла ${name} нет триггера`).toBeDefined();
    }
  });

  it.each(STEPS_WITH_SKILLS)('%s: триггер не пустой и не абзац', (step) => {
    for (const name of stepSkillNames(step)) {
      const trigger = skillTrigger(name) ?? '';
      expect(trigger.length).toBeGreaterThan(10);
      expect(trigger.length).toBeLessThanOrEqual(90);
      expect(trigger).not.toContain('\n');
    }
  });

  it('расписание не описывает скилл, которого никто не подключает', () => {
    const allowed = new Set(
      STEPS_WITH_SKILLS.flatMap((step) => stepSkillNames(step)),
    );
    const orphans = Object.keys(SKILL_TRIGGERS).filter(
      (name) => !allowed.has(name),
    );
    expect(orphans).toEqual([]);
  });
});

describe('расписание скиллов: попадает в промпт своего шага', () => {
  it.each(STEPS_WITH_SKILLS)('%s: перечислены ровно его скиллы', (step) => {
    const text = prompt(step);
    expect(text).toContain('## Skills you have, and when to call them');
    for (const name of stepSkillNames(step)) {
      expect(text).toContain(`- \`skill("${name}")\` — `);
    }
  });

  it('resolve не рекламирует скиллы чужих шагов', () => {
    const text = prompt(PipelineStep.resolve);
    expect(text).toContain('- `skill("clean-code")` — ');
    expect(text).not.toContain('- `skill("glyph")` — ');
    expect(text).not.toContain('- `skill("container-environment")` — ');
  });

  it('report не рекламирует инженерные скиллы', () => {
    const text = prompt(PipelineStep.report);
    expect(text).toContain('- `skill("glyph")` — ');
    expect(text).not.toContain('- `skill("tdd")` — ');
    expect(text).not.toContain('- `skill("clean-code")` — ');
  });

  it.each(STEPS_WITHOUT_SKILLS)('%s: секции нет — скилл вшит текстом', (step) => {
    expect(prompt(step)).not.toContain(
      '## Skills you have, and when to call them',
    );
  });

  it('расписание стоит перед телом шага, а не в хвосте после контракта', () => {
    for (const step of STEPS_WITH_SKILLS) {
      const text = prompt(step);
      const heading = text.indexOf('## Skills you have, and when to call them');
      expect(heading, step).toBeGreaterThan(-1);
      expect(heading, step).toBeLessThan(text.indexOf('Output contract'));
    }
  });

  it('расписание читается до инструкций, а не после них', () => {
    const text = prompt(PipelineStep.resolve);

    expect(text.indexOf('## Skills you have, and when to call them')).toBeLessThan(
      text.indexOf('HARD-RULES:'),
    );
  });

  it('расписание остаётся списком, а не вторым промптом', () => {
    const longest = Math.max(
      ...STEPS_WITH_SKILLS.map((step) => skillRouting(step)?.length ?? 0),
    );
    expect(longest).toBeLessThan(1400);
  });
});
