import type { PipelineStep } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { buildStepPrompt } from '../src/workflow/prompts';

const base = {
  issueTitle: 'Поправить вход в личный кабинет',
  description: 'Описание задачи',
  jiraText: 'Текст из Jira' as string | null,
  context: 'Пользователь не может войти после сброса пароля.',
  feedback: null as string | null,
  repoPaths: ['/workspaces/issue-1/app', '/workspaces/issue-1/lib'],
  desiredResult: undefined as 'md' | 'html' | 'pr' | undefined,
  attachmentPaths: undefined as string[] | undefined,
  previousOutcome: null as string | null,
};

function prompt(
  step: PipelineStep,
  overrides: Partial<typeof base> = {},
): string {
  return buildStepPrompt({ ...base, step, ...overrides });
}

describe('buildStepPrompt', () => {
  it('resolve: title + HARD-RULES + commit/push ban', () => {
    const text = prompt('resolve');

    expect(text).toContain('Поправить вход в личный кабинет');
    expect(text).toContain('HARD-RULES');
    expect(text).toContain('commit');
    expect(text).toContain('push');
    expect(text).toContain('/workspaces/issue-1/app');
  });

  it('resolve: with repos — install dependencies; without repos — write files into the working folder', () => {
    const withRepos = prompt('resolve');
    expect(withRepos).toContain('install dependencies');

    const withoutRepos = prompt('resolve', { repoPaths: [] });
    expect(withoutRepos).toContain('There are no repositories');
    expect(withoutRepos).toContain('task working folder');
    expect(withoutRepos).not.toContain('install dependencies');
  });

  it('resolve: desiredResult html → self-contained report.html instruction', () => {
    const text = prompt('resolve', { desiredResult: 'html' });

    expect(text).toContain('report.html');
    expect(text).toContain('self-contained');
    expect(text).toContain('data URIs');
    expect(text).toContain('.issue-step-result.json');
  });

  it('resolve: desiredResult md → plain Markdown report.md instruction', () => {
    const text = prompt('resolve', { desiredResult: 'md' });

    expect(text).toContain('report.md');
    expect(text).toContain('Markdown');
    expect(text).toContain('no HTML wrapper');
    expect(text).not.toContain('report.html');
    expect(text).toContain('.issue-step-result.json');
  });

  it('resolve: desiredResult pr / undefined → no report.html/report.md instruction', () => {
    const pr = prompt('resolve', { desiredResult: 'pr' });
    expect(pr).not.toContain('report.html');
    expect(pr).not.toContain('report.md');

    const fallback = prompt('resolve');
    expect(fallback).not.toContain('report.html');
    expect(fallback).not.toContain('report.md');
  });

  it('refine: invokes grill-me (and to-questionnaire)', () => {
    const text = prompt('refine');

    expect(text).toContain('grill-me');
    expect(text).toContain('to-questionnaire');
  });

  it('refine: full context (description + Jira) + questions → plan', () => {
    const text = prompt('refine');

    expect(text).toContain('Issue description: Описание задачи');
    expect(text).toContain('Jira text: Текст из Jira');
    expect(text).toContain('questions');
    expect(text).toContain('plan');
  });

  it('resolve: repoPaths + issue description in the visible context', () => {
    const text = prompt('resolve');

    expect(text).toContain('/workspaces/issue-1/app');
    expect(text).toContain('Issue description: Описание задачи');
    expect(text).toContain('Jira text: Текст из Jira');
  });

  it('jiraText null → the "Jira text" line is not emitted', () => {
    const text = prompt('review', { jiraText: null });

    expect(text).not.toContain('Jira text');
  });

  it('review: independent reviewer + output file', () => {
    const text = prompt('review');

    expect(text).toContain('independent reviewer');
    expect(text).toContain('.issue-step-result.json');
    expect(text).toContain('Playwright');
  });

  it('pr: PR role + push/MR ban', () => {
    const text = prompt('pr');

    expect(text).toContain('PR');
    expect(text).toContain('Do NOT push');
    expect(text).toContain('do NOT create an MR');
  });

  it.each(['refine', 'resolve', 'review', 'test', 'pr'] as PipelineStep[])(
    '%s: required "Output contract" block + .issue-step-result.json',
    (step) => {
      const text = prompt(step);

      expect(text).toContain('Output contract');
      expect(text).toContain('.issue-step-result.json');
    },
  );

  it('feedback: inserted when present, absent when null', () => {
    const withFeedback = prompt('resolve', { feedback: 'НЕ ТОТ ФАЙЛ' });
    expect(withFeedback).toContain('НЕ ТОТ ФАЙЛ');
    expect(withFeedback).toContain('Previous step feedback');

    const withoutFeedback = prompt('resolve');
    expect(withoutFeedback).not.toContain('Previous step feedback');
  });

  it('previousOutcome: section inserted when present, absent otherwise', () => {
    const outcome = 'Previous iteration #1 (status pass): done.\nResult document:\nX';
    const withOutcome = prompt('resolve', { previousOutcome: outcome });

    expect(withOutcome).toContain(
      'Previous iteration outcome (build on it, do not redo from scratch):',
    );
    expect(withOutcome).toContain('Previous iteration #1 (status pass): done.');

    const withoutOutcome = prompt('resolve');
    expect(withoutOutcome).not.toContain('Previous iteration outcome');

    const emptyOutcome = prompt('resolve', { previousOutcome: '' });
    expect(emptyOutcome).not.toContain('Previous iteration outcome');
  });

  it('determinism: same input → same string', () => {
    expect(prompt('review')).toBe(prompt('review'));
    expect(prompt('resolve', { feedback: 'x' })).toBe(
      prompt('resolve', { feedback: 'x' }),
    );
  });

  it('attachmentPaths: секция Uploaded files выводится, пусто — нет', () => {
    const withFiles = prompt('resolve', {
      attachmentPaths: ['attachments/a.txt', 'attachments/iteration-2/b.png'],
    });
    expect(withFiles).toContain(
      'Uploaded files (already in the working folder):',
    );
    expect(withFiles).toContain('- attachments/a.txt');
    expect(withFiles).toContain('- attachments/iteration-2/b.png');
    expect(withFiles).toContain('Read them before solving.');

    expect(prompt('resolve', { attachmentPaths: [] })).not.toContain(
      'Uploaded files',
    );
    expect(prompt('resolve')).not.toContain('Uploaded files');
  });
});