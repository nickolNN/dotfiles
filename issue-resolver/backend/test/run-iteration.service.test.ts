import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Iteration,
  PipelineStep,
  SSEEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations, repositories as repositoriesTable, stepOutputs, stepRuns } from '../src/db/schema';
import {
  createStepOutput,
  createStepRun,
} from '../src/db/step-runs.repo';
import { FakeContainerController } from '../src/docker/controller';
import {
  FakeGitService,
  type GitPrepareInput,
  type GitPrepareResult,
} from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import {
  prepareIssueWorkspace,
  runIssueIteration,
  type IterationRunDeps,
} from '../src/workflow/run-iteration.service';
import { FakeDevOpsAgent } from './fixtures/fake-devops';

const NOW = '2026-06-01T00:00:00.000Z';

const pass = (step: PipelineStep): StepExecutionResult => ({
  step,
  exitCode: 0,
  report: { status: 'pass', summary: `${step} ok` },
  stdout: `${step} out`,
  stderr: '',
});

const fail = (step: PipelineStep): StepExecutionResult => ({
  step,
  exitCode: 1,
  report: { status: 'fail', summary: `${step} no` },
  stdout: '',
  stderr: `${step} err`,
});

function seedIteration(
  db: Db,
  steps: PipelineStep[] = ['resolve'],
): { issueId: string; iteration: Iteration } {
  const issueId = randomUUID();
  const iterationId = randomUUID();

  db.insert(issues)
    .values({
      id: issueId,
      title: 'Wiring задача',
      jira_issue_url: null,
      pipeline_steps: steps,
      container_name: null,
      status: 'pending',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();

  const iteration: Iteration = {
    id: iterationId,
    issue_id: issueId,
    number: 1,
    context: 'контекст итерации',
    review_context: '',
    is_review_need: false,
    steps,
    status: 'pending',
    created_at: NOW,
    updated_at: NOW,
  };
  db.insert(iterations).values(iteration).run();

  return { issueId, iteration };
}

function seedNextIteration(
  db: Db,
  issueId: string,
  number: number,
  steps: PipelineStep[] = ['resolve'],
): Iteration {
  const now = new Date().toISOString();
  const iteration: Iteration = {
    id: randomUUID(),
    issue_id: issueId,
    number,
    context: 'контекст итерации',
    review_context: '',
    is_review_need: false,
    steps,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
  db.insert(iterations).values(iteration).run();
  return iteration;
}

async function seedResolveRun(
  db: Db,
  iterationId: string,
  reportJson: string,
): Promise<void> {
  const run = await createStepRun(db, {
    iterationId,
    step: 'resolve',
    attempt: 1,
    context: 'prev',
  });
  await createStepOutput(db, {
    stepRunId: run.id,
    report: reportJson,
    stdout: '',
    stderr: '',
  });
}

function makeDeps(): {
  deps: IterationRunDeps;
  pi: FakePiRunner;
  sse: InMemorySseHub;
  git: FakeGitService;
} {
  const pi = new FakePiRunner();
  const sse = new InMemorySseHub();
  const git = new FakeGitService();
  const deps: IterationRunDeps = {
    container: new FakeContainerController(),
    git,
    mr: new FakeMrClient(),
    pi,
    sse,
    control: new InMemoryStepSessionRegistry(),
  };
  return { deps, pi, sse, git };
}

const repositories = [
  { repository_url: 'https://example.com/app.git', base_branch: 'main' },
];

describe('runIssueIteration — прямой вызов', () => {
  it('успех: completed, статусы в БД, step_runs + step_output, SSE', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribe(iteration.id, (event) => events.push(event));

    const result = await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Wiring задача', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: iteration.steps,
      },
      repositories,
      repoWorkspaces: [],
      model: undefined,
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });

    const iterationRow = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, iteration.id))
      .get();
    expect(iterationRow?.status).toBe('completed');

    const issueRow = db.select().from(issues).where(eq(issues.id, issueId)).get();
    expect(issueRow?.status).toBe('completed');

    const runs = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, iteration.id))
      .all();
    expect(runs).toHaveLength(1);
    expect(runs[0].step).toBe('resolve');
    expect(runs[0].status).toBe('success');

    const outputs = db.select().from(stepOutputs).all();
    expect(outputs).toHaveLength(1);
    expect(outputs[0].step_run_id).toBe(runs[0].id);

    const stepStatuses = events
      .filter((event) => event.type === 'step_status')
      .map((event) => event.data);
    const runningPayload = stepStatuses
      .filter((data) => data.startsWith('{'))
      .map((data) => JSON.parse(data) as { status: string })
      .find((payload) => payload.status === 'running');
    expect(runningPayload).toBeDefined();
    expect(stepStatuses).toContain('success');

    const iterationEvent = events
      .filter((event) => event.type === 'iteration_status')
      .at(-1);
    expect(iterationEvent).toBeDefined();
    expect(JSON.parse(iterationEvent!.data)).toMatchObject({
      iterationId: iteration.id,
      status: 'completed',
      needsInput: false,
    });
  });

  it('вопрос агента: задача question в БД + SSE, ответ — обратно running', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();

    const observed: Array<{ status: string; dbStatus: string | undefined }> = [];
    sse.subscribe(iteration.id, (event) => {
      if (event.type !== 'iteration_status') return;
      const parsed = JSON.parse(event.data) as { status?: string };
      if (parsed.status !== 'question' && parsed.status !== 'running') return;
      observed.push({
        status: parsed.status,
        dbStatus: db
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .get()?.status,
      });
    });

    pi.enqueue({
      step: 'resolve',
      exitCode: 0,
      report: { status: 'pass', summary: 'ok' },
      stdout: '',
      stderr: '',
      events: [
        { type: 'question', id: 'q1', method: 'select', title: 'Выбор?' },
        { type: 'question_answered', questionId: 'q1', answer: 'A' },
      ],
    });

    await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Wiring задача', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: iteration.steps,
      },
      repositories,
      repoWorkspaces: [],
      model: undefined,
    });

    expect(observed).toEqual([
      { status: 'running', dbStatus: 'running' },
      { status: 'question', dbStatus: 'question' },
      { status: 'running', dbStatus: 'running' },
    ]);

    const run = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, iteration.id))
      .get();
    expect(run?.events).toEqual([
      { type: 'question', id: 'q1', method: 'select', title: 'Выбор?' },
      { type: 'question_answered', questionId: 'q1', answer: 'A' },
    ]);
  });

  it('refine: description и jiraText из workspace-файла попадают в промпт', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['refine']);
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('refine'));

    const wsRoot = mkdtempSync(join(tmpdir(), 'jira-test-'));
    const wsDir = join(wsRoot, issueId);
    mkdirSync(join(wsDir, 'jira'), { recursive: true });
    writeFileSync(
      join(wsDir, 'jira', 'KLA-1.md'),
      '# Jira Title\n\n**Ключ:** KLA-1\n\nJira Summary',
      'utf8',
    );
    deps.workspaceRoot = wsRoot;

    await runIssueIteration(db, deps, {
      issue: {
        id: issueId,
        title: 'Wiring задача',
        pipelineSteps: ['refine'],
        description: 'Описание из тела',
        jiraIssueUrl: 'https://jira.example.com/browse/KLA-1',
      },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: ['refine'],
      },
      repositories,
      repoWorkspaces: [],
      model: undefined,
    });

    const stepCalls = pi.calls.filter(
      (call) => call.options?.iterationId !== undefined,
    );
    expect(stepCalls).toHaveLength(1);
    expect(stepCalls[0].prompt).toContain('Описание из тела');
    expect(stepCalls[0].prompt).toContain('Jira Summary');

    rmSync(wsRoot, { recursive: true, force: true });
  });

  it('провал resolve → failed и статусы в БД failed', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));

    const result = await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Wiring задача', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: iteration.steps,
      },
      repositories,
      repoWorkspaces: [],
    });

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });

    expect(
      db.select().from(iterations).where(eq(iterations.id, iteration.id)).get()
        ?.status,
    ).toBe('failed');
    expect(
      db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
    ).toBe('failed');
  });

  it('prepareIssueWorkspace: git.prepare падает (clone timeout) → итерация failed, не остаётся running', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, git } = makeDeps();
    git.failNextWith(new Error('git clone timed out after 5ms'));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(
        prepareIssueWorkspace(db, deps, {
          issueId,
          iterationId: iteration.id,
          repositories,
        }),
      ).rejects.toThrow('git clone timed out after 5ms');

      expect(
        db
          .select()
          .from(iterations)
          .where(eq(iterations.id, iteration.id))
          .get()?.status,
      ).toBe('failed');
      expect(
        db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
      ).toBe('failed');
      expect(pi.calls).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('runIssueIteration — преемственность итераций', () => {
  it('итерация #2: previousOutcome из resolve-отчёта и документа report.md', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration: first } = seedIteration(db, ['resolve']);
    await seedResolveRun(
      db,
      first.id,
      JSON.stringify({ status: 'pass', summary: 'панель уже свёрстана' }),
    );
    const second = seedNextIteration(db, issueId, 2);

    const root = mkdtempSync(join(tmpdir(), 'issue-resolver-'));
    try {
      mkdirSync(join(root, issueId), { recursive: true });
      writeFileSync(
        join(root, issueId, 'report.md'),
        '# Отчёт итерации 1\nГотово наполовину',
        'utf8',
      );
      const { deps, pi } = makeDeps();
      deps.workspaceRoot = root;
      pi.enqueue(pass('resolve'));

      await runIssueIteration(db, deps, {
        issue: {
          id: issueId,
          title: 'Wiring задача',
          pipelineSteps: ['resolve'],
          desiredResult: 'md',
        },
        iteration: {
          id: second.id,
          issueId,
          number: 2,
          context: 'продолжаем',
          steps: ['resolve'],
        },
        repositories,
      repoWorkspaces: [],
      });

      const prompt = pi.calls[0].prompt;
      expect(prompt).toContain(
        'Previous iteration outcome (build on it, do not redo from scratch):',
      );
      expect(prompt).toContain(
        'Previous iteration #1 (status pass): панель уже свёрстана.',
      );
      expect(prompt).toContain('Result document:');
      expect(prompt).toContain('# Отчёт итерации 1');
      expect(prompt).toContain('Готово наполовину');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('битый JSON отчёта и отсутствующий документ не роняют прогон', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration: first } = seedIteration(db, ['resolve']);
    await seedResolveRun(db, first.id, '{не валидный json');
    const second = seedNextIteration(db, issueId, 2);

    const root = mkdtempSync(join(tmpdir(), 'issue-resolver-'));
    try {
      const { deps, pi } = makeDeps();
      deps.workspaceRoot = root;
      pi.enqueue(pass('resolve'));

      const result = await runIssueIteration(db, deps, {
        issue: {
          id: issueId,
          title: 'Wiring задача',
          pipelineSteps: ['resolve'],
          desiredResult: 'md',
        },
        iteration: {
          id: second.id,
          issueId,
          number: 2,
          context: 'продолжаем',
          steps: ['resolve'],
        },
        repositories,
      repoWorkspaces: [],
      });

      expect(result).toEqual({
        iterationStatus: 'completed',
        needsInput: false,
      });
      const prompt = pi.calls[0].prompt;
      expect(prompt).toContain('Previous iteration #1 (status unknown)');
      expect(prompt).toContain('(result document not found)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('итерация #1: previousOutcome отсутствует', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIssueIteration(db, deps, {
      issue: {
        id: issueId,
        title: 'Wiring задача',
        pipelineSteps: ['resolve'],
      },
      iteration: {
        id: iteration.id,
        issueId,
        number: 1,
        context: iteration.context,
        steps: ['resolve'],
      },
      repositories,
      repoWorkspaces: [],
    });

    expect(pi.calls[0].prompt).not.toContain('Previous iteration outcome');
  });
});

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 500,
  stepMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error('waitFor: таймаут ожидания условия');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe('POST /issues — фоновый прогон конвейера', () => {
  it('201 сразу, затем issues.status становится completed (поллинг)', async () => {
    const db = createDb(':memory:');
    const pi = new FakePiRunner();
    pi.enqueue(pass('resolve'));
    const app = buildApp(db, { pi });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/issues',
        payload: {
          title: 'Фоновая задача',
          repositories: [
            {
              repository_url: 'https://github.com/acme/app.git',
              base_branch: 'main',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      const issueId = response.json().id as string;

      const status = await waitFor(() => {
        const row = db.select().from(issues).where(eq(issues.id, issueId)).get();
        return row?.status === 'completed' ? row.status : undefined;
      });

      expect(status).toBe('completed');
      expect(pi.calls.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe('runIssueIteration — снапшот результата итерации', () => {
  it('completed + md: report.md копируется в .iteration-results/<iterId>/report.md', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const root = mkdtempSync(join(tmpdir(), 'issue-resolver-'));
    try {
      mkdirSync(join(root, issueId), { recursive: true });
      writeFileSync(join(root, issueId, 'report.md'), '# Итог', 'utf8');
      const { deps, pi } = makeDeps();
      deps.workspaceRoot = root;
      pi.enqueue(pass('resolve'));

      const result = await runIssueIteration(db, deps, {
        issue: {
          id: issueId,
          title: 'Wiring задача',
          pipelineSteps: ['resolve'],
          desiredResult: 'md',
        },
        iteration: {
          id: iteration.id,
          issueId,
          number: iteration.number,
          context: iteration.context,
          steps: iteration.steps,
        },
        repositories,
      repoWorkspaces: [],
      });

      expect(result).toEqual({
        iterationStatus: 'completed',
        needsInput: false,
      });
      const snapshot = join(
        root,
        issueId,
        '.iteration-results',
        iteration.id,
        'report.md',
      );
      expect(existsSync(snapshot)).toBe(true);
      expect(readFileSync(snapshot, 'utf8')).toBe('# Итог');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('failed: снапшот не создаётся', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const root = mkdtempSync(join(tmpdir(), 'issue-resolver-'));
    try {
      mkdirSync(join(root, issueId), { recursive: true });
      writeFileSync(join(root, issueId, 'report.md'), '# Итог', 'utf8');
      const { deps, pi } = makeDeps();
      deps.workspaceRoot = root;
      pi.enqueue(fail('resolve'));
      pi.enqueue(fail('resolve'));
      pi.enqueue(fail('resolve'));
      pi.enqueue(fail('resolve'));

      const result = await runIssueIteration(db, deps, {
        issue: {
          id: issueId,
          title: 'Wiring задача',
          pipelineSteps: ['resolve'],
          desiredResult: 'md',
        },
        iteration: {
          id: iteration.id,
          issueId,
          number: iteration.number,
          context: iteration.context,
          steps: iteration.steps,
        },
        repositories,
      repoWorkspaces: [],
      });

      expect(result).toEqual({
        iterationStatus: 'failed',
        needsInput: false,
      });
      expect(
        existsSync(
          join(root, issueId, '.iteration-results', iteration.id, 'report.md'),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("без pr-шага: result.json не создаётся (guard)", async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const root = mkdtempSync(join(tmpdir(), 'issue-resolver-'));
    try {
      const { deps, pi } = makeDeps();
      deps.workspaceRoot = root;
      pi.enqueue(pass('resolve'));

      const result = await runIssueIteration(db, deps, {
        issue: {
          id: issueId,
          title: 'Wiring задача',
          pipelineSteps: ['resolve'],
        },
        iteration: {
          id: iteration.id,
          issueId,
          number: iteration.number,
          context: iteration.context,
          steps: iteration.steps,
        },
        repositories: [],
        repoWorkspaces: [],
      });

      expect(result).toEqual({
        iterationStatus: 'completed',
        needsInput: false,
      });
      expect(
        existsSync(
          join(root, issueId, '.iteration-results', iteration.id, 'result.json'),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pr с bitbucket-репо: detectGitHost не падает, итерация completed', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve', 'pr']);
    const root = mkdtempSync(join(tmpdir(), 'issue-resolver-'));
    try {
      const { deps, pi, git } = makeDeps();
      deps.workspaceRoot = root;
      pi.enqueue(pass('resolve'));
      pi.enqueue(pass('pr'));
      const mr = deps.mr as FakeMrClient;

      const bitbucketRepos = [
        {
          repository_url: 'https://b.yadro.com/scm/kos/some-repo.git',
          base_branch: 'main',
          create_mr: true,
        },
      ];
      const repoWorkspaces = [
        {
          repoUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
          path: join(root, issueId, 'some-repo'),
          branch: 'issue-resolver/abc',
        },
      ];

      const result = await runIssueIteration(db, deps, {
        issue: {
          id: issueId,
          title: 'Bitbucket задача',
          pipelineSteps: ['resolve', 'pr'],
        },
        iteration: {
          id: iteration.id,
          issueId,
          number: iteration.number,
          context: iteration.context,
          steps: iteration.steps,
        },
        repositories: bitbucketRepos,
        repoWorkspaces,
      });

      expect(result).toEqual({
        iterationStatus: 'completed',
        needsInput: false,
      });
      expect(git.commits).toHaveLength(1);
      expect(mr.calls).toHaveLength(1);
      expect(mr.calls[0].source).toBe('bitbucket');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('completed без report.md в корне: не падает, снапшота нет', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const root = mkdtempSync(join(tmpdir(), 'issue-resolver-'));
    try {
      mkdirSync(join(root, issueId), { recursive: true });
      const { deps, pi } = makeDeps();
      deps.workspaceRoot = root;
      pi.enqueue(pass('resolve'));

      const result = await runIssueIteration(db, deps, {
        issue: {
          id: issueId,
          title: 'Wiring задача',
          pipelineSteps: ['resolve'],
          desiredResult: 'md',
        },
        iteration: {
          id: iteration.id,
          issueId,
          number: iteration.number,
          context: iteration.context,
          steps: iteration.steps,
        },
        repositories,
      repoWorkspaces: [],
      });

      expect(result).toEqual({
        iterationStatus: 'completed',
        needsInput: false,
      });
      expect(
        existsSync(
          join(root, issueId, '.iteration-results', iteration.id, 'report.md'),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

class GatedGitService extends FakeGitService {
  private startResolve!: () => void;
  private releaseGate!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.startResolve = resolve;
  });
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  async prepare(input: GitPrepareInput): Promise<GitPrepareResult> {
    this.startResolve();
    await this.gate;
    return super.prepare(input);
  }

  open(): void {
    this.releaseGate();
  }
}

describe('runIssueIteration — разовая подготовка рабочей папки (фаза 2)', () => {
  const roots: string[] = [];

  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ir-prepare-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepareIssueWorkspace: preparing на время подготовки, prepare/install один раз, затем running', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['refine', 'resolve']);
    const { deps, pi, sse } = makeDeps();
    const gated = new GatedGitService();
    deps.git = gated;
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('refine'));
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    const preparing = prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });

    await gated.started;

    expect(
      db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
    ).toBe('preparing');
    expect(
      db.select().from(iterations).where(eq(iterations.id, iteration.id)).get()
        ?.status,
    ).toBe('pending');
    expect(pi.calls).toHaveLength(0);
    const progress = events
      .filter((event) => event.type === 'workspace_progress')
      .map((event) => JSON.parse(event.data) as { step: string; status: string });
    expect(progress).toContainEqual({ step: 'creating_dirs', status: 'done' });

    gated.open();
    const repoWorkspaces = await preparing;
    const result = await runIssueIteration(db, deps, {
      issue: {
        id: issueId,
        title: 'Подготовка',
        pipelineSteps: ['refine', 'resolve'],
      },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: ['refine', 'resolve'],
      },
      repositories,
      repoWorkspaces,
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(gated.prepares).toHaveLength(1);
    expect(gated.dependenciesInstalled).toEqual([
      [join(deps.workspaceRoot as string, issueId, 'app')],
    ]);
    expect(
      pi.calls.filter((call) => call.options?.iterationId !== undefined),
    ).toHaveLength(2);
  });

  it('workspace уже склонирован → подготовка пропускается, preparing не публикуется', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse, git } = makeDeps();
    const root = tempRoot();
    deps.workspaceRoot = root;
    mkdirSync(join(root, issueId, 'app', '.git'), { recursive: true });
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribe(iteration.id, (event) => events.push(event));

    const result = await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Повтор', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: ['resolve'],
      },
      repositories,
      repoWorkspaces: [],
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(
      events.some(
        (event) =>
          event.type === 'iteration_status' &&
          event.data.includes('"status":"preparing"'),
      ),
    ).toBe(false);
    expect(git.prepares).toHaveLength(0);
    expect(git.dependenciesInstalled).toHaveLength(0);
  });

  it('local-режим: уже склонированный репо → workspace.path использует host-путь, не /workspaces/', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps } = makeDeps();
    const root = tempRoot();
    deps.workspaceRoot = root;
    deps.local = true;
    mkdirSync(join(root, issueId, 'app', '.git'), { recursive: true });

    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });

    expect(repoWorkspaces).toEqual([
      {
        repoUrl: repositories[0].repository_url,
        path: join(root, issueId, 'app'),
        branch: repositories[0].base_branch,
      },
    ]);
    expect(repoWorkspaces[0].path.startsWith('/workspaces/')).toBe(false);
  });

  it('docker-режим: уже склонированный репо → workspace.path остаётся container-путём', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps } = makeDeps();
    const root = tempRoot();
    deps.workspaceRoot = root;
    mkdirSync(join(root, issueId, 'app', '.git'), { recursive: true });

    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });

    expect(repoWorkspaces).toEqual([
      {
        repoUrl: repositories[0].repository_url,
        path: `/workspaces/${issueId}/app`,
        branch: repositories[0].base_branch,
      },
    ]);
  });

  it('инфраструктурные файлы скрыты от git (.git/info/exclude) и не дублируются', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps } = makeDeps();
    const root = tempRoot();
    deps.workspaceRoot = root;
    mkdirSync(join(root, issueId, 'app', '.git'), { recursive: true });

    const input = { issueId, iterationId: iteration.id, repositories };
    await prepareIssueWorkspace(db, deps, input);
    await prepareIssueWorkspace(db, deps, input);

    const lines = readFileSync(
      join(root, issueId, 'app', '.git', 'info', 'exclude'),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.startsWith('/'));
    expect(lines).toEqual([
      '/RUN_INSTRUCTIONS.md',
      '/DEV_SERVER.sh',
      '/.issue-step-result.json',
      '/.issue-worker-result-*.json',
      '/.issue-stage-*.json',
    ]);
  });

  it('prepareIssueWorkspace init-fail → задача и итерация failed, pi не вызван', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, git, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    git.failNextWith(new Error('npm install failed'));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const events: SSEEvent[] = [];
    sse.subscribe(iteration.id, (event) => events.push(event));

    try {
      await expect(
        prepareIssueWorkspace(db, deps, {
          issueId,
          iterationId: iteration.id,
          repositories,
        }),
      ).rejects.toThrow('npm install failed');

      expect(
        db
          .select()
          .from(iterations)
          .where(eq(iterations.id, iteration.id))
          .get()?.status,
      ).toBe('failed');
      expect(
        db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
      ).toBe('failed');
      expect(pi.calls).toHaveLength(0);
      expect(
        events.some(
          (event) =>
            event.type === 'iteration_status' &&
            event.data.includes('"status":"failed"'),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
class ThrowingStepStatusHub extends InMemorySseHub {
  publish(event: SSEEvent): void {
    if (event.type === 'step_status') {
      throw new Error('boom from sse');
    }
    super.publish(event);
  }
}

describe('runIssueIteration — прогресс подготовки, причина фейла и отчёт', () => {
  const roots: string[] = [];

  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ir-report-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const progressOf = (events: SSEEvent[]): unknown[] =>
    events
      .filter((event) => event.type === 'workspace_progress')
      .map((event) => JSON.parse(event.data) as unknown);

  it('prepareIssueWorkspace шлёт workspace_progress по шагам (clone/install/…)', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });
    const result = await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Прогресс', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: iteration.steps,
      },
      repositories,
      repoWorkspaces,
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(progressOf(events)).toEqual([
      { step: 'creating_dirs', status: 'running' },
      { step: 'creating_dirs', status: 'done' },
      { step: 'cloning', repo: 'app', status: 'running' },
      { step: 'cloning', repo: 'app', status: 'done' },
      { step: 'checking_instructions', status: 'running' },
      { step: 'checking_instructions', status: 'done' },
      { step: 'installing', repo: 'app', status: 'running' },
      { step: 'installing', repo: 'app', status: 'done' },
      { step: 'dev_server', repo: 'app', status: 'running' },
      {
        step: 'dev_server',
        repo: 'app',
        status: 'done',
        message: 'localhost:5173',
        devPort: 5173,
      },
      { step: 'ready', status: 'done' },
    ]);
    const envelope = events.find((event) => event.type === 'workspace_progress');
    expect(envelope?.issueId).toBe(issueId);
    expect(envelope?.iterationId).toBeUndefined();
  });

  it('фейл подготовки: iteration_status failed несёт error и progress error', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, git, sse } = makeDeps();
    const root = tempRoot();
    deps.workspaceRoot = root;
    git.failNextWith(new Error('git clone timed out after 5ms'));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    try {
      await expect(
        prepareIssueWorkspace(db, deps, {
          issueId,
          iterationId: iteration.id,
          repositories,
        }),
      ).rejects.toThrow('git clone timed out after 5ms');

      const failed = events
        .filter((event) => event.type === 'iteration_status')
        .map((event) => JSON.parse(event.data) as Record<string, unknown>)
        .find((data) => data.status === 'failed');
      expect(failed).toMatchObject({
        status: 'failed',
        error: 'git clone timed out after 5ms',
      });

      const errored = (progressOf(events) as Record<string, unknown>[]).find(
        (data) => data.status === 'error',
      );
      expect(errored).toMatchObject({
        step: 'cloning',
        status: 'error',
        message: 'git clone timed out after 5ms',
      });

      expect(
        db
          .select()
          .from(iterations)
          .where(eq(iterations.id, iteration.id))
          .get()?.status,
      ).toBe('failed');
      expect(
        db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
      ).toBe('failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('catch после runIteration: iteration_status failed несёт error', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
    deps.workspaceRoot = tempRoot();
    const hub = new ThrowingStepStatusHub();
    deps.sse = hub;
    pi.enqueue(pass('resolve'));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const events: SSEEvent[] = [];
    hub.subscribe(iteration.id, (event) => events.push(event));

    try {
      const result = await runIssueIteration(db, deps, {
        issue: { id: issueId, title: 'Сбой', pipelineSteps: ['resolve'] },
        iteration: {
          id: iteration.id,
          issueId,
          number: iteration.number,
          context: iteration.context,
          steps: iteration.steps,
        },
        repositories,
      repoWorkspaces: [],
      });

      expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
      const failed = events
        .filter((event) => event.type === 'iteration_status')
        .map((event) => JSON.parse(event.data) as Record<string, unknown>)
        .find((data) => data.status === 'failed');
      expect(failed).toMatchObject({ status: 'failed', error: 'boom from sse' });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('отчёт итерации пишется в report-<n>.md с шагами и статусами', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['refine', 'resolve']);
    const root = tempRoot();
    const { deps, pi } = makeDeps();
    deps.workspaceRoot = root;
    pi.enqueue(pass('refine'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));

    const result = await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Отчётная задача', pipelineSteps: ['refine', 'resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: iteration.number,
        context: iteration.context,
        steps: ['refine', 'resolve'],
      },
      repositories,
      repoWorkspaces: [],
    });

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });

    const reportPath = join(root, issueId, 'report-1.md');
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, 'utf8');
    expect(content).toContain('# Задача: Отчётная задача');
    expect(content).toContain('# Итерация #1');
    expect(content).toContain('**Статус:** failed');
    expect(content).toContain('### refine (попытка 1)');
    expect(content).toContain('**Статус:** ok');
    expect(content).toContain('### resolve (попытка 1)');
    expect(content).toContain('**Статус:** fail');
    expect(content).toContain('refine ok');
    expect(content).toContain('resolve no');
  });
});

describe('runIssueIteration — run_instructions через анализатор', () => {
  const roots: string[] = [];

  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ir-run-instr-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const seedRepository = (
    db: Db,
    url: string,
    status: 'unknown' | 'generated' | 'failed',
  ): void => {
    db.insert(repositoriesTable)
      .values({
        id: randomUUID(),
        url,
        connection_status: 'ok',
        run_instructions: null,
        run_instructions_status: status,
        created_at: NOW,
        updated_at: NOW,
      })
      .run();
  };

  const repoRow = (db: Db, url: string) =>
    db
      .select()
      .from(repositoriesTable)
      .where(eq(repositoriesTable.url, url))
      .get();

  const progressOf = (events: SSEEvent[]): unknown[] =>
    events
      .filter((event) => event.type === 'workspace_progress')
      .map((event) => JSON.parse(event.data) as unknown);

  const runInput = (
    issueId: string,
    iteration: Iteration,
    repoWorkspaces: GitPrepareResult['repoWorkspaces'],
  ) => ({
    issue: { id: issueId, title: 'Анализ', pipelineSteps: ['resolve'] as PipelineStep[] },
    iteration: {
      id: iteration.id,
      issueId,
      number: iteration.number,
      context: iteration.context,
      steps: iteration.steps,
    },
    repositories,
    repoWorkspaces,
  });

  it('status unknown: devops сохраняет generated и шлёт analyzing', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    seedRepository(db, repositories[0].repository_url, 'unknown');
    const agent = new FakeDevOpsAgent({
      success: true,
      instructions: '# Run\nnpm ci',
    });
    deps.devopsFactory = () => agent;
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });
    const result = await runIssueIteration(
      db,
      deps,
      runInput(issueId, iteration, repoWorkspaces),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toMatchObject({
      repoUrl: repositories[0].repository_url,
      repoName: 'app',
    });
    const row = repoRow(db, repositories[0].repository_url);
    expect(row?.run_instructions_status).toBe('generated');
    expect(row?.run_instructions).toBe('# Run\nnpm ci');
    expect(progressOf(events)).toContainEqual({
      step: 'devops',
      repo: 'app',
      status: 'done',
      message: 'Инструкции сохранены',
    });
  });

  it('status generated: devops не вызывается, инструкции не трогаются', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
    deps.workspaceRoot = tempRoot();
    seedRepository(db, repositories[0].repository_url, 'generated');
    const agent = new FakeDevOpsAgent({ success: true, instructions: 'new' });
    deps.devopsFactory = () => agent;
    pi.enqueue(pass('resolve'));

    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });
    const result = await runIssueIteration(
      db,
      deps,
      runInput(issueId, iteration, repoWorkspaces),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(agent.calls).toHaveLength(0);
    const row = repoRow(db, repositories[0].repository_url);
    expect(row?.run_instructions_status).toBe('generated');
    expect(row?.run_instructions).toBeNull();
  });

  it('фейл анализа: статус failed, инструкция очищена', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    seedRepository(db, repositories[0].repository_url, 'unknown');
    const agent = new FakeDevOpsAgent({
      success: false,
      instructions: null,
      error: 'no lockfile',
    });
    deps.devopsFactory = () => agent;
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });
    const result = await runIssueIteration(
      db,
      deps,
      runInput(issueId, iteration, repoWorkspaces),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    const row = repoRow(db, repositories[0].repository_url);
    expect(row?.run_instructions_status).toBe('failed');
    expect(row?.run_instructions).toBeNull();
    expect(progressOf(events)).toContainEqual({
      step: 'devops',
      repo: 'app',
      status: 'error',
      message: 'no lockfile',
    });
  });

  it('bootstrap_enabled:false → clone есть, анализ и install пропущены', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse, git } = makeDeps();
    deps.workspaceRoot = tempRoot();
    seedRepository(db, repositories[0].repository_url, 'unknown');
    const agent = new FakeDevOpsAgent({
      success: true,
      instructions: '# Run\nnpm ci',
    });
    deps.devopsFactory = () => agent;
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    const disabledRepositories = [
      { ...repositories[0], bootstrap_enabled: false },
    ];
    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories: disabledRepositories,
    });
    const result = await runIssueIteration(db, deps, {
      ...runInput(issueId, iteration, repoWorkspaces),
      repositories: disabledRepositories,
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.prepares).toHaveLength(1);
    expect(agent.calls).toHaveLength(0);
    expect(git.dependenciesInstalled).toHaveLength(0);
    expect(repoRow(db, repositories[0].repository_url)?.run_instructions_status).toBe(
      'unknown',
    );
    expect(progressOf(events)).toContainEqual({
      step: 'devops',
      repo: 'app',
      status: 'done',
      message: 'пропущен',
    });
    expect(progressOf(events)).toContainEqual({
      step: 'installing',
      repo: 'app',
      status: 'done',
      message: 'пропущен',
    });
  });

  it('вывод анализатора публикуется как log-события со stepRunId {issueId}/devops', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    seedRepository(db, repositories[0].repository_url, 'unknown');
    const agent = new FakeDevOpsAgent({
      success: true,
      instructions: '# Run',
    });
    deps.devopsFactory = (params) => {
      params.onStdout?.('installing deps\n');
      params.onStderr?.('warning\n');
      return agent;
    };

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });

    const logs = events.filter((event) => event.type === 'log');
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      issueId,
      iterationId: iteration.id,
      stepRunId: `issue.${issueId}.devops`,
      stream: 'stdout',
      data: 'installing deps\n',
    });
    expect(logs[1]).toMatchObject({
      stepRunId: `issue.${issueId}.devops`,
      stream: 'stderr',
      data: 'warning\n',
    });
    expect(events.some((event) => (event.type as string) === 'devops_log')).toBe(
      false,
    );
  });

  it('пробрасывает devopsTimeoutMs в фабрику анализатора', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
    deps.workspaceRoot = tempRoot();
    seedRepository(db, repositories[0].repository_url, 'unknown');
    const seen: Array<number | undefined> = [];
    deps.devopsTimeoutMs = 123_456;
    deps.devopsFactory = (params) => {
      seen.push(params.timeoutMs);
      return new FakeDevOpsAgent({
        success: true,
        instructions: '# Run\nnpm ci',
      });
    };
    pi.enqueue(pass('resolve'));

    const repoWorkspaces = await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });
    await runIssueIteration(
      db,
      deps,
      runInput(issueId, iteration, repoWorkspaces),
    );

    expect(seen).toEqual([123_456]);
  });
});

describe('spawnReportAgent (B6–B9)', () => {
  const roots: string[] = [];

  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ir-report-spawn-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const reportCall = (pi: FakePiRunner, issueId: string) =>
    pi.calls.find((call) => call.options?.stepRunId === `issue.${issueId}.report`);

  const runOnce = async (
    db: Db,
    deps: IterationRunDeps,
    issueId: string,
    iteration: Iteration,
    number = iteration.number,
  ) =>
    runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Report задача', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number,
        context: iteration.context,
        steps: iteration.steps,
      },
      repositories,
      repoWorkspaces: [],
    });

  it('B6: строит промпт шага report и передаёт iterationCount', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('report'));

    await runOnce(db, deps, issueId, iteration);

    const call = reportCall(pi, issueId);
    expect(call).toBeDefined();
    expect(call!.prompt).toContain('Pipeline step: report.');
    expect(call!.prompt).toContain('iterations/1/');
  });

  it('B7: SSE report-агента имеет stepRunId = {issueId}/report и оба stream', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));
    pi.enqueue({
      step: 'report',
      exitCode: 0,
      report: { status: 'pass', summary: 'report ok' },
      stdout: 'report out\n',
      stderr: 'report err\n',
    });

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    await runOnce(db, deps, issueId, iteration);

    const logs = events.filter(
      (event) => event.type === 'log' && event.stepRunId === `issue.${issueId}.report`,
    );
    expect(logs.map((event) => event.stream)).toEqual(['stdout', 'stderr']);
    expect(logs.map((event) => event.data)).toEqual([
      'report out\n',
      'report err\n',
    ]);
  });

  it('B8: падение report-агента не роняет итерацию', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));

    const original = pi.run.bind(pi);
    pi.run = (containerName, prompt, options) =>
      options?.stepRunId === `issue.${issueId}.report`
        ? Promise.reject(new Error('report boom'))
        : original(containerName, prompt, options);

    const result = await runOnce(db, deps, issueId, iteration);

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(
      db.select().from(iterations).where(eq(iterations.id, iteration.id)).get()
        ?.status,
    ).toBe('completed');
  });

  it('B9: 0 итераций → промпт сообщает об отсутствии narratives', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    db.update(iterations)
      .set({ number: 0 })
      .where(eq(iterations.id, iteration.id))
      .run();
    const { deps, pi } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('report'));

    await runOnce(db, deps, issueId, iteration, 0);

    const call = reportCall(pi, issueId);
    expect(call).toBeDefined();
    expect(call!.prompt.toLowerCase()).toContain('no iteration');
    expect(call!.prompt).not.toContain('iterations/1/');
  });

  it('B10: report публикует step_status running → success по {issueId}/report', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('report'));

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    await runOnce(db, deps, issueId, iteration);

    const reportRunId = `issue.${issueId}.report`;
    const statuses = () =>
      events.filter(
        (event) =>
          event.type === 'step_status' && event.stepRunId === reportRunId,
      );
    await vi.waitFor(() => expect(statuses()).toHaveLength(2));

    expect(JSON.parse(statuses()[0].data)).toEqual({
      status: 'running',
      step: 'report',
      model: null,
    });
    expect(statuses()[1].data).toBe('failed');
    expect(statuses()[1].issueId).toBe(issueId);
    const reportRun = db
      .select()
      .from(stepRuns)
      .all()
      .find((run) => run.step === 'report');
    expect(reportRun).toMatchObject({
      issue_id: issueId,
      iteration_id: null,
      status: 'failed',
    });
    expect(reportRun?.feedback).toContain('report.md');
  });

  it('B11: падение report-агента → step_status failed, ошибка в серверном логе', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));

    const original = pi.run.bind(pi);
    pi.run = (containerName, prompt, options) =>
      options?.stepRunId === `issue.${issueId}.report`
        ? Promise.reject(new Error('report boom'))
        : original(containerName, prompt, options);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    try {
      await runOnce(db, deps, issueId, iteration);

      const reportRunId = `issue.${issueId}.report`;
      const terminal = () =>
        events.find(
          (event) =>
            event.type === 'step_status' &&
            event.stepRunId === reportRunId &&
            event.data === 'failed',
        );
      await vi.waitFor(() => expect(terminal()).toBeDefined());

      expect(
        events.some(
          (event) =>
            event.type === 'step_status' &&
            event.stepRunId === reportRunId &&
            event.data.includes('"status":"running"'),
        ),
      ).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        'report agent failed',
        expect.objectContaining({ issueId, error: expect.any(Error) }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('B12: ненулевой exitCode report-агента → step_status failed', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('report'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    try {
      await runOnce(db, deps, issueId, iteration);

      const reportRunId = `issue.${issueId}.report`;
      await vi.waitFor(() =>
        expect(
          events.find(
            (event) =>
              event.type === 'step_status' &&
              event.stepRunId === reportRunId &&
              event.data === 'failed',
          ),
        ).toBeDefined(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('DevOps SSE миграция (C10–C12)', () => {
  const roots: string[] = [];

  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ir-devops-sse-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const runDevOps = async (): Promise<{ events: SSEEvent[]; issueId: string }> => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, sse } = makeDeps();
    deps.workspaceRoot = tempRoot();
    db.insert(repositoriesTable)
      .values({
        id: randomUUID(),
        url: repositories[0].repository_url,
        connection_status: 'ok',
        run_instructions: null,
        run_instructions_status: 'unknown',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();
    deps.devopsFactory = (params) => {
      params.onStdout?.('installing deps\n');
      params.onStderr?.('warning\n');
      return new FakeDevOpsAgent({ success: true, instructions: '# Run' });
    };

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    await prepareIssueWorkspace(db, deps, {
      issueId,
      iterationId: iteration.id,
      repositories,
    });

    return { events, issueId };
  };

  it('C10: DevOps stdout → log SSE со stepRunId {issueId}/devops, stream=stdout', async () => {
    const { events, issueId } = await runDevOps();

    const stdout = events.find(
      (event) => event.type === 'log' && event.stream === 'stdout',
    );
    expect(stdout).toBeDefined();
    expect(stdout!.stepRunId).toBe(`issue.${issueId}.devops`);
    expect(stdout!.data).toBe('installing deps\n');
  });

  it('C11: DevOps stderr → log SSE со stream=stderr', async () => {
    const { events, issueId } = await runDevOps();

    const stderr = events.find(
      (event) => event.type === 'log' && event.stream === 'stderr',
    );
    expect(stderr).toBeDefined();
    expect(stderr!.stepRunId).toBe(`issue.${issueId}.devops`);
    expect(stderr!.data).toBe('warning\n');
  });

  it('C12: старый devops_log больше не публикуется', async () => {
    const { events } = await runDevOps();

    expect(events.some((event) => (event.type as string) === 'devops_log')).toBe(
      false,
    );
  });
});
