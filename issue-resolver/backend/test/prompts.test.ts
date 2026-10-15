import type { NormalizedStage, PipelineStep } from '@issue-resolver/shared';
import { DEFAULT_MAX_ROOM_EXECUTORS } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import {
  buildRoomCoordinatorPrompt,
  buildRoomWorkerPrompt,
  buildStageCoordinatorPrompt,
  buildStageWorkerPrompt,
  buildStagedFinalCoordinatorPrompt,
  buildStepPrompt,
  type PrTarget,
  type RoomPromptInput,
} from '../src/workflow/prompts';

const base = {
  issueTitle: 'Поправить вход в личный кабинет',
  description: 'Описание задачи',
  jiraText: 'Текст из Jira' as string | null,
  context: 'Пользователь не может войти после сброса пароля.',
  feedback: null as string | null,
  refinedPlan: null as string | null,
  repoPaths: ['/workspaces/issue-1/app', '/workspaces/issue-1/lib'],
  desiredResult: undefined as 'md' | 'html' | undefined,
  attachmentPaths: undefined as string[] | undefined,
  previousOutcome: null as string | null,
  reviewContext: null as string | null,
  pipelineSteps: undefined as PipelineStep[] | undefined,
  devServerPort: null as number | null | undefined,
  prTargets: undefined as PrTarget[] | undefined,
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
    expect(text.toLowerCase()).toContain('commit');
    expect(text.toLowerCase()).toContain('push');
    expect(text).toContain('/workspaces/issue-1/app');
    // Самопроверка разрешена, публикация — нет (резолв больше не запрещает build/test/typecheck).
    expect(text).toContain('build/tests/typecheck');
    expect(text).not.toContain(
      'running build, test, commit, or push is forbidden',
    );
  });

  it('resolve: with repos — зависимости уже поставлены подготовкой; without repos — файлы в рабочую папку', () => {
    const withRepos = prompt('resolve');
    expect(withRepos).toContain('Dependencies are already installed');

    const withoutRepos = prompt('resolve', { repoPaths: [] });
    expect(withoutRepos).toContain('There are no repositories');
    expect(withoutRepos).toContain('task working folder');
    expect(withoutRepos).not.toContain('Dependencies are already installed');
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

  it('resolve: desiredResult undefined → no report.html/report.md instruction', () => {
    const fallback = prompt('resolve');
    expect(fallback).not.toContain('report.html');
    expect(fallback).not.toContain('report.md');
  });

  it('refine: asks via the `question` tool with options, not stdout/skills', () => {
    const text = prompt('refine');

    expect(text).toContain('`question` TOOL');
    expect(text).toContain('options');
    expect(text).toContain('BLOCKS until the user answers');
    expect(text).not.toContain('stdout');
    expect(text).not.toContain('grill-me');
    expect(text).not.toContain('to-questionnaire');
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

  it('review: чистое код-ревью — source-only, без запуска tests/build/browser', () => {
    const text = prompt('review');

    expect(text).toContain('independent code reviewer');
    expect(text).toContain('source code');
    expect(text).toContain('READ-ONLY step');
    expect(text).toContain('.issue-step-result.json');
    expect(text).not.toContain('You are allowed to run');
    expect(text).not.toContain('Playwright');
    expect(text).not.toContain('Verify the real behavior');
  });

  it('test: финальная проверка, не чинит код, при падении перезапускается разработка', () => {
    const text = prompt('test');

    expect(text).toContain('final verification only');
    expect(text).toContain('Playwright');
    expect(text.toLowerCase()).toContain('do not fix');
    expect(text.toLowerCase()).toContain('re-run development');
    expect(text).toContain('fail/blocked');
    expect(text).toContain('.issue-step-result.json');
  });

  it('review: review_context renders the "Reviewer context" section; empty/other steps — no section', () => {
    const withContext = prompt('review', {
      reviewContext: 'Особое внимание к авторизации после сброса пароля',
    });

    expect(withContext).toContain('Reviewer context');
    expect(withContext).toContain('Особое внимание к авторизации после сброса пароля');

    expect(prompt('review')).not.toContain('Reviewer context');
    expect(prompt('resolve', { reviewContext: 'X' })).not.toContain(
      'Reviewer context',
    );
  });

  it('pr: PR role + push/MR ban', () => {
    const text = prompt('pr');

    expect(text).toContain('PR');
    expect(text).toContain('READ-ONLY');
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

  it('resolve: знает даунстрим-гейты и не дублирует их', () => {
    const text = prompt('resolve', { pipelineSteps: ['refine','resolve','review','test','pr'] });
    expect(text).toContain('Downstream verification steps run AFTER you');
    expect(text).toContain('do NOT duplicate');
    expect(text).toContain('Playwright');
    expect(text).toContain('source code only');
  });

  it('resolve: без даунстрим review/test — примечания нет', () => {
    const text = prompt('resolve', { pipelineSteps: ['refine','resolve'] });
    expect(text).not.toContain('Downstream verification steps');
    expect(text).not.toContain('do NOT duplicate');
  });

  it('refine: согласует план с даунстрим-гейтами', () => {
    const text = prompt('refine', { pipelineSteps: ['refine','resolve','review','test','pr'] });
    expect(text).toContain('Enabled pipeline for this run');
    expect(text).toContain('Coordinate your plan with these steps');
    expect(text).toContain('do NOT duplicate');
    expect(text).toContain('Playwright');
  });

  it('refine: resolve — FINAL gate, когда review/test не включены', () => {
    const text = prompt('refine', { pipelineSteps: ['refine','resolve'] });
    expect(text).toContain('Enabled pipeline for this run');
    expect(text).toContain('FINAL verification gate');
    expect(text).toContain('full self-verification');
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

describe('refine execution & room prompts', () => {
  const roomInput: RoomPromptInput = {
    issueTitle: base.issueTitle,
    description: base.description,
    jiraText: base.jiraText,
    context: base.context,
    feedback: null,
    refinedPlan: 'План: сделать X, затем Y',
    repoPaths: base.repoPaths,
    desiredResult: 'md',
    previousOutcome: null,
    attachmentPaths: [],
  };

  it('refine: asks for an execution recommendation incl. room', () => {
    const text = prompt('refine');

    expect(text).toContain('execution');
    expect(text).toContain('room');
    expect(text).toContain('single');
  });

  it('resolve: refinedPlan renders the "Refined plan" section', () => {
    const text = prompt('resolve', { refinedPlan: 'План из refine' });

    expect(text).toContain('Refined plan');
    expect(text).toContain('План из refine');
  });

  it('worker prompt: peer, not the lead, writes .issue-worker-result-1.json', () => {
    const text = buildRoomWorkerPrompt(
      roomInput,
      { index: 0, task: 'frontend part' },
      2,
    );

    expect(text).toContain('NOT the lead');
    expect(text).toContain('.issue-worker-result-1.json');
    expect(text).not.toContain('.issue-worker-result-0.json');
    expect(text).toContain('frontend part');
    expect(text).toContain('Sub-task 1 of 2');
    // Самопроверка разрешена, публикация — нет.
    expect(text).toContain('build/tests/typecheck');
    expect(text).toContain('Commit/push are FORBIDDEN');
  });

  it('coordinator prompt: LEAD takes the FINAL decision + worker summaries', () => {
    const text = buildRoomCoordinatorPrompt(roomInput, [
      { index: 0, summary: 'frontend done' },
      { index: 1, summary: 'backend done' },
    ]);

    expect(text).toContain('LEAD');
    expect(text).toContain('FINAL');
    expect(text).toContain('frontend done');
    expect(text).toContain('backend done');
    expect(text).toContain('.issue-step-result.json');
  });

  it('coordinator: знает даунстрим-гейты, когда они включены', () => {
    const text = buildRoomCoordinatorPrompt(
      { ...roomInput, pipelineSteps: ['refine','resolve','review','test','pr'] },
      [{ index: 0, summary: 'frontend done' }],
    );

    expect(text).toContain('Downstream verification steps run AFTER you');
  });
});

describe('staged prompts', () => {
  const stage: NormalizedStage = {
    index: 1,
    name: 'Сбор контекста',
    task: 'собрать контекст',
    executors: 2,
    decomposition: ['frontend', 'backend'],
  };

  const roomInput: RoomPromptInput = {
    issueTitle: base.issueTitle,
    description: base.description,
    jiraText: base.jiraText,
    context: base.context,
    feedback: null,
    refinedPlan: 'План: сделать X, затем Y',
    repoPaths: base.repoPaths,
    desiredResult: 'md',
    previousOutcome: null,
    attachmentPaths: [],
  };

  it('refine: mentions the plan.md artifact and the stages mode', () => {
    const text = prompt('refine');

    expect(text).toContain('plan.md');
    expect(text).toContain('stages');
    expect(text).toContain('.issue-step-result.json');
  });

  it('stage worker: stage name, peer-not-lead, own stage-worker file', () => {
    const text = buildStageWorkerPrompt(
      roomInput,
      stage,
      { index: 1, task: 'backend' },
      2,
    );

    expect(text).toContain('NOT the lead');
    expect(text).toContain('Сбор контекста');
    expect(text).toContain('Sub-task 2 of 2: backend');
    expect(text).toContain('.issue-stage-1-worker-2.json');
    expect(text).not.toContain('.issue-step-result.json');
    // Самопроверка разрешена, публикация — нет.
    expect(text).toContain('build/tests/typecheck');
    expect(text).toContain('Commit/push are FORBIDDEN');
  });

  it('stage coordinator: integrates workers, stage file, shared memory read/write', () => {
    const text = buildStageCoordinatorPrompt(roomInput, stage, [
      { index: 0, summary: 'frontend done' },
      { index: 1, summary: 'backend done' },
    ]);

    expect(text).toContain('Сбор контекста');
    expect(text).toContain('frontend done');
    expect(text).toContain('backend done');
    expect(text).toContain('.issue-stage-1.json');
    expect(text).toContain('memory_read');
    expect(text).toContain('memory_search');
    expect(text).toContain('memory_write');
    expect(text).toContain('[[stage-1]]');
  });

  it('final lead: integrates all stage outcomes, deliverable + final report + memory', () => {
    const text = buildStagedFinalCoordinatorPrompt(roomInput, [
      { stage, outcome: 'stage 1 done' },
      {
        stage: { ...stage, index: 2, name: 'Починка', executors: 1 },
        outcome: 'stage 2 done',
      },
    ]);

    expect(text).toContain('LEAD');
    expect(text).toContain('FINAL');
    expect(text).toContain('stage 1 done');
    expect(text).toContain('stage 2 done');
    expect(text).toContain('report.md');
    expect(text).toContain('.issue-step-result.json');
    expect(text).toContain('memory_write');
    expect(text).toContain('[[resolve]]');
  });
});

describe('prompt hygiene — роль видит всё, что нужно именно ей', () => {
  const steps: PipelineStep[] = ['refine', 'resolve', 'review', 'test', 'pr'];
  const stage: NormalizedStage = {
    index: 1,
    name: 'Сбор контекста',
    task: 'собрать контекст',
    executors: 2,
    decomposition: ['frontend', 'backend'],
  };
  const full: RoomPromptInput = {
    issueTitle: 'Поправить вход',
    description: 'Описание',
    jiraText: 'Jira',
    context: 'Контекст итерации',
    feedback: 'верните кэш',
    refinedPlan: 'План',
    repoPaths: ['/workspaces/issue-1/app'],
    desiredResult: 'md',
    previousOutcome: 'Previous iteration #1 (status fail): кэш не сброшен.',
    attachmentPaths: ['attachments/spec.pdf'],
    pipelineSteps: steps,
    devServerPort: 4321,
  };
  const roomTexts = (): string[] => [
    buildRoomWorkerPrompt(full, { index: 0, task: 'frontend' }, 2),
    buildRoomCoordinatorPrompt(full, [{ index: 1, summary: 'frontend done' }]),
    buildStageWorkerPrompt(full, stage, { index: 0, task: 'frontend' }, 2),
    buildStageCoordinatorPrompt(full, stage, [{ index: 1, summary: 'frontend done' }]),
    buildStagedFinalCoordinatorPrompt(full, [{ stage, outcome: 'stage done' }]),
  ];

  it.each(steps)('%s: пути репозиториев и место в конвейере', (step) => {
    const text = prompt(step, { pipelineSteps: steps });

    expect(text).toContain(`Pipeline step: ${step}.`);
    expect(text).toContain(
      'Enabled pipeline for this run: refine → resolve → review → test → pr.',
    );
    expect(text).toContain('- /workspaces/issue-1/app');
  });

  it('ни один промпт не оставляет нерезолвленных плейсхолдеров', () => {
    const texts = [
      ...steps.map((step) =>
        prompt(step, {
          pipelineSteps: steps,
          devServerPort: 4321,
          desiredResult: 'md',
          refinedPlan: 'План',
          previousOutcome: 'итог',
          attachmentPaths: ['attachments/spec.pdf'],
          reviewContext: 'контекст ревьюера',
          prTargets: [
            { path: '/workspaces/issue-1/app', baseBranch: 'main', createMr: true },
          ],
        }),
      ),
      ...roomTexts(),
    ];

    for (const text of texts) {
      expect(text).not.toContain('{{');
    }
  });

  it('room/staged: задача, вложения и итог прошлой итерации доходят до каждой роли', () => {
    for (const text of roomTexts()) {
      expect(text).toContain('Task: Поправить вход');
      expect(text).toContain('Uploaded files (already in the working folder):');
      expect(text).toContain('- attachments/spec.pdf');
      expect(text).toContain('Previous iteration outcome');
      expect(text).toContain('кэш не сброшен');
      expect(text).toContain('http://localhost:4321');
    }
  });

  it('room/staged: воркеру и лиду видно, какие гейты идут после них', () => {
    for (const text of roomTexts()) {
      expect(text).toContain('Downstream verification steps run AFTER');
      expect(text).toContain('Playwright');
    }
  });

  it('lead комнаты: карта файлов воркеров + output contract', () => {
    const text = buildRoomCoordinatorPrompt(full, [
      { index: 1, summary: 'frontend done' },
      { index: 2, summary: 'backend done' },
    ]);

    expect(text).toContain('`.issue-worker-result-1.json`: frontend done');
    expect(text).toContain('`.issue-worker-result-2.json`: backend done');
    expect(text).toContain('Output contract');
  });

  it('test: живой dev-сервер — URL; нет порта — поднять самому', () => {
    expect(prompt('test', { devServerPort: 4321 })).toContain(
      'http://localhost:4321',
    );
    expect(prompt('test')).toContain('No dev server is running');
  });

  it('pr: диф рабочего дерева (коммитит бэкенд после шага) + цели публикации', () => {
    const text = prompt('pr', {
      prTargets: [
        { path: '/workspaces/issue-1/app', baseBranch: 'release-7', createMr: true },
      ],
    });

    expect(text).toContain('git status --porcelain');
    expect(text).toContain('nothing is committed yet');
    expect(text).toContain('/workspaces/issue-1/app — base `release-7`, create MR: yes');
    expect(text).not.toContain('<base>...HEAD');
  });

  it('pr: без репозиториев — публиковать нечего', () => {
    expect(prompt('pr', { prTargets: [] })).toContain('nothing to publish');
  });

  it('output contract: форма scenarios/findings, без недосягаемых ссылок', () => {
    const text = prompt('resolve');

    expect(text).toContain('"expected"');
    expect(text).toContain('"severity"');
    expect(text).not.toContain('ISSUE_RESOLVER_PLAN');
  });

  it('refine: потолок исполнителей из shared, без противоречивых «prefer»', () => {
    const text = prompt('refine');

    expect(text).toContain(`2..${DEFAULT_MAX_ROOM_EXECUTORS}`);
    expect(text).not.toContain('MAX 3 AGENTS PARALLEL');
    expect(text).not.toContain('Prefer `single`');
    expect(text).not.toContain('Prefer room or stages');
  });

  it('review: читает change set и отчёт предыдущего шага', () => {
    const text = prompt('review');

    expect(text).toContain('git status --porcelain');
    expect(text).toContain('the execution step');
  });
});