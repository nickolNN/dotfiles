import type { NormalizedStage, PipelineStep } from '@issue-resolver/shared';
import { DEFAULT_MAX_ROOM_EXECUTORS } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { STEP_SYSTEM_APPEND, buildRoomCoordinatorPrompt, buildRoomWorkerPrompt, buildStageCoordinatorPrompt, buildStageSoloPrompt, buildStageWorkerPrompt, buildStagedFinalCoordinatorPrompt, buildStepPrompt, type PrTarget, type RoomPromptInput } from '../src/workflow/prompts';

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
  workerCount: undefined as number | undefined,
  iterationCount: undefined as number | undefined,
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

  it('refine: WORKER_COUNT уходит планировщику (дефолт 1)', () => {
    expect(prompt('refine')).toContain('Maximum parallel agents: 1');
    expect(prompt('refine', { workerCount: 3 })).toContain(
      'Maximum parallel agents: 3',
    );
  });

  it('refine/resolve: репозитории помечены create MR из задачи, а не спрашиваются', () => {
    const targets: PrTarget[] = [
      { path: '/workspaces/issue-1/app', baseBranch: 'dev', createMr: true },
      { path: '/workspaces/issue-1/lib', baseBranch: 'dev', createMr: false },
    ];

    for (const step of ['refine', 'resolve', 'test'] as PipelineStep[]) {
      const text = prompt(step, { prTargets: targets });
      expect(text).toContain('- /workspaces/issue-1/app — create MR: yes');
      expect(text).toContain('- /workspaces/issue-1/lib — create MR: no');
    }

    // Без целей публикации строка репозитория остаётся прежней (фраза
    // «create MR: yes/no» живёт в брифе refine, но разметки строк нет).
    expect(prompt('refine')).toContain('- /workspaces/issue-1/app');
    expect(prompt('refine')).not.toContain('— create MR:');
  });

  it('refine/resolve: репозиторий без цели публикации остаётся без разметки MR', () => {
    const text = prompt('resolve', {
      prTargets: [
        { path: '/workspaces/issue-1/app', baseBranch: 'dev', createMr: true },
      ],
    });

    expect(text).toContain('- /workspaces/issue-1/app — create MR: yes');
    expect(text).toContain('- /workspaces/issue-1/lib');
    expect(text).not.toContain('/workspaces/issue-1/lib — create MR:');
  });

  it('refine: цель публикации для пути вне рабочей копии молча игнорируется', () => {
    const text = prompt('refine', {
      prTargets: [
        { path: '/workspaces/other/repo', baseBranch: 'dev', createMr: true },
      ],
    });

    expect(text).not.toContain('— create MR:');
    expect(text).not.toContain('/workspaces/other/repo');
  });

  it('refine: без репозиториев цели публикации не появляются', () => {
    const text = prompt('refine', {
      repoPaths: [],
      prTargets: [
        { path: '/workspaces/issue-1/app', baseBranch: 'dev', createMr: true },
      ],
    });

    expect(text).toContain('There are no repositories');
    expect(text).not.toContain('— create MR:');
  });

  it('pr: разметка create MR сосуществует с блоком целей (base-ветка не потеряна)', () => {
    const text = prompt('pr', {
      prTargets: [
        { path: '/workspaces/issue-1/app', baseBranch: 'release-7', createMr: true },
      ],
    });

    expect(text).toContain('- /workspaces/issue-1/app — create MR: yes');
    expect(text).toContain(
      '- /workspaces/issue-1/app — base `release-7`, create MR: yes',
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

  it('resolve: НЕ говорит генерировать report.html — это задача report-агента', () => {
    const text = prompt('resolve', { desiredResult: 'html' });

    expect(text).not.toContain('report.html');
    expect(text).not.toContain('self-contained');
    expect(text).not.toContain('data URIs');
    // .issue-step-result.json всё ещё обязателен для каждого шага.
    expect(text).toContain('.issue-step-result.json');
  });

  it('resolve: НЕ говорит генерировать report.md/report.html — это удел report-шага', () => {
    for (const desiredResult of ['md', undefined] as const) {
      const text = prompt('resolve', { desiredResult });

      expect(text).not.toContain('report.md');
      expect(text).not.toContain('report.html');
      expect(text).not.toContain('self-contained');
      expect(text).not.toContain('data URIs');
      // resolve пишет .issue-step-result.json и narrative .resolve.md для report-агента.
      expect(text).toContain('.issue-step-result.json');
      expect(text).toContain('.resolve.md');
    }
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
    expect(text).toContain('## Memory');
    expect(text).toContain('memory_search');
    expect(text).toContain('#decision');
    expect(text).toContain('[[stage-1]]');
  });

  it('stage solo (executors=1): роль единственного исполнителя, файл этапа, память; без интеграции исполнителей', () => {
    const text = buildStageSoloPrompt(roomInput, stage);

    expect(text).toContain('the only worker of stage 1');
    expect(text).toContain('there are no other workers and no stage coordinator');
    expect(text).toContain('Сбор контекста');
    expect(text).toContain('.issue-stage-1.json');
    expect(text).toContain('## Memory');
    expect(text).toContain('memory_search');
    expect(text).toContain('#decision');
    expect(text).toContain('[[stage-1]]');
    // Роль координатора/интегратора исполнителей этапу без исполнителей не достаётся.
    expect(text).not.toContain('Role: coordinator');
    expect(text).not.toContain("Integrate the workers' changes");
    // Финальный отчёт шага — не его: он пишет только исход этапа.
    expect(text).toContain('This is NOT the step result');
  });

  it('final lead: integrates all stage outcomes + final report + memory, без HTML-deliverable', () => {
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
    // report.md/report.html генерирует ТОЛЬКО report-шаг, не resolve.
    expect(text).not.toContain('report.md');
    expect(text).not.toContain('report.html');
    expect(text).toContain('.issue-step-result.json');
    expect(text).toContain('## Memory');
    expect(text).toContain('#decision');
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
    buildStageSoloPrompt(full, stage),
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

  it('room/staged: разметка create MR доходит до каждой роли', () => {
    const withTargets: RoomPromptInput = {
      ...full,
      prTargets: [
        { path: '/workspaces/issue-1/app', baseBranch: 'dev', createMr: true },
      ],
    };
    const texts = [
      buildRoomWorkerPrompt(withTargets, { index: 0, task: 'frontend' }, 2),
      buildRoomCoordinatorPrompt(withTargets, [{ index: 1, summary: 'done' }]),
      buildStageWorkerPrompt(withTargets, stage, { index: 0, task: 'frontend' }, 2),
      buildStageCoordinatorPrompt(withTargets, stage, [
        { index: 1, summary: 'done' },
      ]),
      buildStageSoloPrompt(withTargets, stage),
      buildStagedFinalCoordinatorPrompt(withTargets, [
        { stage, outcome: 'done' },
      ]),
    ];

    for (const text of texts) {
      expect(text).toContain('- /workspaces/issue-1/app — create MR: yes');
    }
  });

  it('room/staged: без целей публикации разметки MR нет (обратная совместимость)', () => {
    for (const text of roomTexts()) {
      expect(text).not.toContain('— create MR:');
    }
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

  it('room/staged: исполнителю и лиду видно, какие гейты идут после них', () => {
    for (const text of roomTexts()) {
      expect(text).toContain('Downstream verification steps run AFTER');
      expect(text).toContain('Playwright');
    }
  });

  it('lead комнаты: карта файлов исполнителей + output contract', () => {
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

  it('refine: число параллельных исполнителей из shared, без противоречивых «prefer»', () => {
    const text = prompt('refine');

    expect(text).toContain('Maximum parallel agents: 1');
    expect(text).toContain(`1..${DEFAULT_MAX_ROOM_EXECUTORS} workers`);
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

describe('buildStepPrompt — report агент (E18–E21)', () => {
  it('report: 0 итераций → пометка «нет narratives» + фолбек на engine summaries', () => {
    const text = prompt('report', { iterationCount: 0 });

    // buildStepPrompt вызывает iterationNarrativesBlock(0): папок нет.
    expect(text.toLowerCase()).toContain('no iteration');
    expect(text).not.toContain('iterations/1/');
    // Fallback: механические engine-сводки report-<n>.md всё равно описаны.
    expect(text).toContain('report-');
    expect(text).toContain('Engine summaries');
  });

  it('report: 2 итерации → обе папки narratives перечислены', () => {
    const text = prompt('report', { iterationCount: 2 });

    expect(text).toContain('iterations/1/');
    expect(text).toContain('iterations/2/');
    expect(text).not.toContain('iterations/3/');
  });

  it('report: плейсхолдер ITERATION_NARRATIVES отрендерен, а не оставлен как {{...}}', () => {
    const text = prompt('report', { iterationCount: 1 });

    expect(text).not.toContain('{{ITERATION_NARRATIVES}}');
    expect(text).toContain('narratives');
    expect(text).toContain('iterations/1/');
  });

  it('report: агент читает шаговые narrative-файлы .<step>.md', () => {
    const text = prompt('report', { iterationCount: 1 });

    for (const name of ['.refine.md', '.resolve.md', '.review.md', '.test.md', '.pr.md']) {
      expect(text).toContain(name);
    }
  });

  it('report: ответ раньше выполнения, HTML-выполнение свёрнуто в <details>', () => {
    const text = prompt('report', { iterationCount: 1 });

    // Каркас: `## Answer` — первая обязательная секция, метрика — после
    // заголовка `## Execution details` в конце файла.
    const answerAt = text.indexOf('## Answer');
    const executionAt = text.indexOf('## Execution details');
    expect(answerAt).toBeGreaterThan(-1);
    expect(executionAt).toBeGreaterThan(-1);
    expect(answerAt).toBeLessThan(executionAt);

    // HTML: выполнение — нативный свёрнутый <details>; JS — только
    // инлайновый vanilla как progressive enhancement.
    expect(text).toContain('<details>');
    expect(text).toContain('<summary>');
    expect(text).toContain('progressive enhancement');
    expect(text).toMatch(/allow-scripts/);
    // Внешние скрипты, CSS-import, CDN и любая сеть запрещены
    // (self-contained / sandbox без allow-same-origin).
    expect(text).not.toMatch(/<script[^>]+\bsrc=/i);
    // «Форма инструкции», а не голый токен: промпт ВПРАВЕ называть
    // `@import` / `cdn.jsdelivr.net` в списке запретов — ловим реальную
    // загрузку, а не упоминание (иначе guard диктует текст бана).
    expect(text).not.toMatch(/@import\s+(url\(|["']https?:)/i);
    expect(text).not.toMatch(
      /(src|from)\s*=\s*["']https?:\/\/(cdn\.jsdelivr|unpkg)/i,
    );
    // Ссылки-навигация РАЗРЕШЕНЫ (MR/Jira/док), с безопасным target.
    expect(text).toContain('target="_blank"');
    expect(text).toContain('rel="noopener"');
    // Скелет form-by-goal: имена шагов и номера итераций — не заголовки
    // Answer; Evidence placement вынесен отдельным правилом.
    expect(text).not.toMatch(/## Iteration \d+/);
    expect(text).not.toContain('### Plan (refine)');
    expect(text).toContain('Evidence placement');
    expect(text).toContain('ceiling');
    // Свёрнутый блок Execution details не раскрыт по умолчанию.
    expect(text).toMatch(/<details>/);
    expect(text).not.toMatch(/<details[^>]*\sopen\b/i);
    // Визуальная часть — обязательный инструмент (SVG без библиотек).
    expect(text).toContain('Visual recipes (no libraries)');
    expect(text).toContain('Single-file guarantee');
    // Свёртка не теряет факты выполнения.
    expect(text).toContain('Collapsing loses nothing');
  });

  it('report: существующие артефакты пересобираются, не патчатся + финальный чек-лист', () => {
    const text = prompt('report', { iterationCount: 1 });

    // Готовая папка с прошлым отчётом не должна соблазнять агента на
    // точечные edit-правки: оба файла пересобираются целиком.
    expect(text).toContain('Rebuild, never patch');
    expect(text).toMatch(/previous run's draft/);
    expect(text).toMatch(/again, in full, with `write`/);
    // Generated всегда обновляется — иначе timestamp врёт.
    expect(text).toMatch(/stale timestamp is a bug/);

    // Прошлый отчёт — не источник, где бы он ни лежал: ни архив
    // (`reports/**`), ни снапшот итерации (`.iteration-results/**`).
    expect(text).toMatch(/previous report is never a source/i);
    expect(text).toMatch(/iteration-results\/\*\*\/report/);
    expect(text).toMatch(/reports\/\*\*/);
    // …и это закреплено в финальном чек-листе, не только в прозе.
    expect(text).toMatch(/No previous report was read as a source/);

    // Чек-лист в конце файла (модель теряет середину 20 КБ промпта).
    expect(text).toContain('Final self-check');
    const checklistAt = text.indexOf('## Final self-check');
    const outputAt = text.indexOf('## Output: `.issue-step-result.json`');
    expect(checklistAt).toBeGreaterThan(outputAt);
    // Обязательные пункты самопроверки: безопасные ссылки и хотя бы одна SVG.
    expect(text).toMatch(/grep -c 'target="_blank"'/);
    expect(text).toMatch(/at least one inline `<svg>`/);
  });

  it('report: одна диаграмма в двух формах — ASCII md / SVG html, glyph-структура', () => {
    const text = prompt('report', { iterationCount: 1 });

    // Структура ответа — glyph, обязательна для обеих форм отчёта.
    expect(text).toContain('`glyph`');
    expect(text).toContain('verdict first');
    // Одна и та же диаграмма: текстовая в md, SVG в html.
    expect(text).toMatch(/monospace ASCII art or\s+a Markdown table/);
    expect(text).toMatch(/inline `<svg>`, never as an\s+ASCII block/);
    // Ремесло — из craft-скиллов, но контракт артефакта сильнее.
    expect(text).toContain('`frontend-design`');
    expect(text).toContain('`theme-factory`');
    expect(text).toMatch(/no external\s+fonts/);
    // Артефакт не подчиняется чат-скиллам краткости, включая варианты.
    expect(text).toMatch(/not governed by `caveman`/);
    expect(text).toContain('ultracave');
    expect(text).toContain('megacave');
    expect(text).toContain('ponytail');
    // Контракт агент-facing артефактов приезжает из output-contract.md.
    expect(text).toContain('machine-readable Markdown or');
    expect(text).toContain('telegraphic');
  });

  it('модель/провайдер не называются ни в одном артефакте', () => {
    const text = prompt('report', { iterationCount: 1 });

    // Промпт отчёта вводит запрет и больше не заказывает «model used».
    expect(text).not.toMatch(/model used/i);
    expect(text).toContain('No model or provider name');
    expect(text).not.toContain('**Model:**');
    expect(text).toMatch(/step \+ iteration/);
    // Тот же запрет приезжает из output-contract.md — он покрывает ВСЕ шаги.
    expect(text).toContain('No model or provider name in an artifact');
    expect(text).toContain('provider/model-id');
    const resolveText = prompt('resolve');
    expect(resolveText).toContain('No model or provider name in an artifact');
    expect(resolveText).not.toMatch(/model used/i);
    expect(resolveText).not.toContain('**Model:**');
  });

  it('report: чужой скилл или его пример не тянут CDN в артефакт', () => {
    const text = prompt('report');

    // Контракт обобщён на ЛЮБОЙ установленный скилл и файл, на который он
    // ссылается, — не только на craft-скиллы.
    expect(text).toMatch(/any installed skill/i);
    // Покрытие реального upstream-нарушителя
    // (`improve-codebase-architecture/HTML-REPORT.md`: tailwind CDN + mermaid).
    expect(text).toMatch(/tailwind|jsdelivr|mermaid/i);
    expect(text).toMatch(/CDN|diagram librar/i);
    // Чек-лист по-прежнему запрещает внешние загрузки.
    expect(text).toMatch(/no `<script>` tag with a `src`/);
    expect(text).toMatch(/no CSS `import`/);
  });

  it('каждый шаговый промпт велит писать narrative в iterations/<n>/', () => {
    for (const step of ['refine', 'resolve', 'review', 'test', 'pr'] as PipelineStep[]) {
      expect(prompt(step)).toContain('iterations/<n>/');
    }
  });
});

describe('правила памяти в промптах шагов', () => {
  it('каждый шаговый промпт несёт блок Memory с тегами и ссылками', () => {
    const prompt = buildStepPrompt({
      step: 'review',
      issueTitle: 'T',
      description: '',
      jiraText: null,
      context: '',
      feedback: null,
      repoPaths: [],
      iterationCount: 1,
    });

    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('#decision');
    expect(prompt).toContain('[[issue-');
    expect(prompt).toContain('Do not write');
  });

  it('system-append фиксирует файл как единственный deliverable', () => {
    expect(STEP_SYSTEM_APPEND).toContain('.issue-step-result.json');
    expect(STEP_SYSTEM_APPEND).toContain('not a deliverable');
  });
});
