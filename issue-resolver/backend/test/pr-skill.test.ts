import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PipelineStep } from '@issue-resolver/shared';
import { buildStepPrompt, type PrTarget } from '../src/workflow/prompts';

const SKILL_PATH = join(homedir(), '.agents', 'skills', 'pr', 'SKILL.md');

const base = {
  issueTitle: 'Добавить кнопку экспорта',
  description: 'Описание задачи',
  jiraText: 'EXP-1',
  context: 'Нужен экспорт списка.',
  feedback: null,
  refinedPlan: null,
  repoPaths: ['/workspaces/issue-1/app', '/workspaces/issue-1/lib'],
  desiredResult: undefined,
  attachmentPaths: undefined,
  previousOutcome: null,
  reviewContext: null,
  pipelineSteps: undefined,
  devServerPort: null,
  prTargets: [
    { path: '/workspaces/issue-1/app', baseBranch: 'develop', createMr: true },
    { path: '/workspaces/issue-1/lib', baseBranch: 'develop', createMr: true },
  ] as PrTarget[],
  workerCount: undefined,
  iterationCount: undefined,
};

function prPrompt(): string {
  return buildStepPrompt({ ...base, step: 'pr' as PipelineStep });
}

describe('pr шаг: форма описания — из оригинального скилла', () => {
  it('скилл `pr` установлен (иначе шаг теряет источник формы)', () => {
    expect(
      existsSync(SKILL_PATH),
      `нет ${SKILL_PATH}: оригинал должен быть в списке remote-скиллов Dockerfile`,
    ).toBe(true);
  });

  it('в промпт попадает ДОСЛОВНЫЙ текст оригинала', () => {
    const raw = readFileSync(SKILL_PATH, 'utf-8');
    expect(prPrompt()).toContain('Use this template for writing the PR body');
    expect(prPrompt()).toContain(raw.split('\n').at(-1)!.trim().slice(0, 40));
  });

  it('секции оригинала дошли до агента', () => {
    const text = prPrompt();
    for (const marker of [
      '## Summary',
      '## Evidence',
      '## Merge Danger',
      '**Door:**',
      '**Blast Radius:**',
      'one-way or two-way',
    ]) {
      expect(text, `маркер «${marker}» не в промпте`).toContain(marker);
    }
  });

  it('нашей версии структуры больше нет нигде', () => {
    const text = prPrompt();
    expect(text).not.toMatch(/What was done/);
    expect(text).not.toMatch(/### description: three/);
    expect(text).not.toMatch(/^## Risks$/m);
  });

  it('скилл не тянет git-команд, а шаг остаётся working-tree-aware', () => {
    const text = prPrompt();
    expect(text).not.toContain('<base>...HEAD');
    expect(text).toContain('git status --porcelain');
    expect(text).toContain('nothing is committed yet');
  });

  it('несколько репозиториев → описание обязательно для каждого', () => {
    const text = prPrompt();
    expect(text).toMatch(/One MR description \*\*per repository\*\*/);
    const repoUrls = [...text.matchAll(/"repository_url": "([^"]+)"/g)];
    expect(repoUrls.length).toBeGreaterThanOrEqual(2);
    const perRepo = [...text.matchAll(/"description": "([^"]+)"/g)]
      .slice(1)
      .map((m) => m[1]);
    expect(perRepo.length).toBe(2);
    for (const d of perRepo) {
      expect(d).toContain('## Summary');
      expect(d).toContain('## Merge Danger');
    }
  });

  it('транспорт остаётся нашим: JSON-поля и запрет действий', () => {
    const text = prPrompt();
    for (const field of ['"title"', '"description"', '"summary"', '"status"']) {
      expect(text).toContain(field);
    }
    expect(text).toMatch(/READ-ONLY/);
    expect(text).not.toMatch(/git push/);
  });
});
