import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Iteration,
  PipelineStep,
  SSEEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations, stepOutputs, stepRuns } from '../src/db/schema';
import {
  createStepOutput,
  createStepRun,
} from '../src/db/step-runs.repo';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakeJiraClient } from '../src/jira/client';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import {
  runIssueIteration,
  type IterationRunDeps,
} from '../src/workflow/run-iteration.service';

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

/** Прямой insert issue + iteration, без HTTP-слоя. */
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

/** Прямой insert следующей итерации issue (для преемственности, number > 1). */
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

/** resolve-прогон итерации с заданной JSON-строкой отчёта (байты как есть). */
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
  jira: FakeJiraClient;
  git: FakeGitService;
} {
  const pi = new FakePiRunner();
  const sse = new InMemorySseHub();
  const jira = new FakeJiraClient();
  const git = new FakeGitService();
  const deps: IterationRunDeps = {
    container: new FakeContainerController(),
    git,
    mr: new FakeMrClient(),
    pi,
    sse,
    jira,
    control: new InMemoryStepSessionRegistry(),
  };
  return { deps, pi, sse, jira, git };
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
    expect(stepStatuses).toContain('running');
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

  it('refine: description и jiraText из FakeJiraClient попадают в промпт', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['refine']);
    const { deps, pi, jira } = makeDeps();
    jira.setIssue('KLA-1', {
      key: 'KLA-1',
      title: 'Jira Title',
      summary: 'Jira Summary',
    });
    pi.enqueue(pass('refine'));

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
    });

    expect(jira.calls).toContain('KLA-1');
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].prompt).toContain('Описание из тела');
    expect(pi.calls[0].prompt).toContain('Jira Summary');
  });

  it('провал resolve → failed и статусы в БД failed', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi } = makeDeps();
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

  it('git.prepare падает (clone timeout) → итерация failed, не остаётся running', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const { deps, pi, git } = makeDeps();
    git.failNextWith(new Error('git clone timed out after 5ms'));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
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
        repositories,
      });

      expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
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
      // Шаг не запускался — pi не вызывался.
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