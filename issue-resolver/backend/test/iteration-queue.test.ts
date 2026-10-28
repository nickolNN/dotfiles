import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionPlan,
  PipelineStep,
  StepExecutionResult,
  TaskStatus,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations, stepRuns } from '../src/db/schema';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakeMrClient } from '../src/pr/mr';
import {
  FakePiRunner,
  type PiRunner,
  type PiRunOptions,
} from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { InMemorySseHub } from '../src/sse/hub';
import {
  runIssueIteration,
  type IterationRunDeps,
} from '../src/workflow/run-iteration.service';
import {
  runRoomResolve,
  type RoomResolveInput,
  type RoomResolveOptions,
} from '../src/workflow/room';

const ISSUES = '/issue-resolver/api/v1/issues';
const ITERATIONS = '/issue-resolver/api/v1/iterations';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

type App = ReturnType<typeof buildApp>;

function makeEnv(): { db: Db; root: string; pi: FakePiRunner; app: App } {
  const db = createDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'issue-resolver-queue-'));
  const pi = new FakePiRunner();
  const app = buildApp(db, { pi, workspaceRoot: root });
  cleanups.push(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, pi, app };
}

function tempRoot(prefix = 'issue-resolver-queue-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seedIssue(db: Db, steps: PipelineStep[] = ['resolve']): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id,
      title: 'Очередь итераций',
      jira_issue_url: null,
      pipeline_steps: steps,
      container_name: null,
      status: 'running',
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

function seedIteration(
  db: Db,
  issueId: string,
  opts: {
    number: number;
    status: TaskStatus;
    steps?: PipelineStep[];
    context?: string;
  },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(iterations)
    .values({
      id,
      issue_id: issueId,
      number: opts.number,
      context: opts.context ?? 'ctx',
      steps: opts.steps ?? ['resolve'],
      status: opts.status,
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

function iterationRows(db: Db, issueId: string): { id: string; status: string }[] {
  return db
    .select({ id: iterations.id, status: iterations.status })
    .from(iterations)
    .where(eq(iterations.issue_id, issueId))
    .all();
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 4000,
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

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));

interface ProbeCall {
  id: string;
  iterationId?: string;
  startedAt: number;
  endedAt?: number;
}

class ProbeRunner implements PiRunner {
  active = 0;
  maxActive = 0;
  readonly calls: ProbeCall[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly auto = false,
    private readonly delayMs = 10,
  ) {}

  run(
    _containerName: string,
    _prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    const id = options?.agent?.id ?? options?.stepRunId ?? '?';
    const result: StepExecutionResult = {
      step: 'resolve',
      exitCode: 0,
      report: { status: 'pass', summary: `${id} ok` },
      stdout: '',
      stderr: '',
    };
    if (options?.stepRunId?.endsWith('.report')) {
      return Promise.resolve(result);
    }

    const call: ProbeCall = {
      id,
      iterationId: options?.iterationId,
      startedAt: Date.now(),
    };
    this.calls.push(call);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    const finish = (): void => {
      this.active -= 1;
      call.endedAt = Date.now();
    };

    if (this.auto) {
      return new Promise((resolve) =>
        setTimeout(() => {
          finish();
          resolve(result);
        }, this.delayMs),
      );
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        finish();
        resolve(result);
      });
    });
  }

  releaseAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const release of waiters) release();
  }
}

function makeDeps(pi: PiRunner): {
  deps: IterationRunDeps;
  sse: InMemorySseHub;
} {
  const sse = new InMemorySseHub();
  const deps: IterationRunDeps = {
    container: new FakeContainerController(),
    git: new FakeGitService(),
    mr: new FakeMrClient(),
    pi,
    sse,
    control: new InMemoryStepSessionRegistry(),
  };
  return { deps, sse };
}

function issueInput(id: string, steps: PipelineStep[]) {
  return {
    id,
    title: 'Очередь итераций',
    pipelineSteps: steps,
    description: '',
    desiredResult: 'md' as const,
    jiraIssueUrl: null,
  };
}

describe('POST /issues/:id/iterations — одна активная итерация за раз', () => {
  it('при running-итерации создаёт draft, а не авто-стартует', async () => {
    const { db, pi, app } = makeEnv();
    const issueId = seedIssue(db);
    const runningId = seedIteration(db, issueId, { number: 1, status: 'running' });

    const res = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: { context: 'ctx', steps: ['resolve'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('draft');
    expect(body.number).toBe(2);
    expect(body.id).not.toBe(runningId);

    const row = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, body.id))
      .get();
    expect(row?.status).toBe('draft');

    await flush();
    expect(pi.calls).toHaveLength(0);
  });

  it('второй draft при running → 409, новых строк не появляется', async () => {
    const { db, pi, app } = makeEnv();
    const issueId = seedIssue(db);
    seedIteration(db, issueId, { number: 1, status: 'running' });
    seedIteration(db, issueId, { number: 2, status: 'draft' });

    const before = iterationRows(db, issueId).length;
    const res = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: { context: 'ctx', steps: ['resolve'] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'A draft iteration already exists — edit or delete it first',
    });
    expect(iterationRows(db, issueId)).toHaveLength(before);
    expect(pi.calls).toHaveLength(0);
  });

  it('pending при running → 409, новых строк не появляется', async () => {
    const { db, pi, app } = makeEnv();
    const issueId = seedIssue(db);
    seedIteration(db, issueId, { number: 1, status: 'running' });
    seedIteration(db, issueId, { number: 2, status: 'pending' });

    const before = iterationRows(db, issueId).length;
    const res = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: { context: 'ctx', steps: ['resolve'] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'A pending iteration already exists — wait for it to start',
    });
    expect(iterationRows(db, issueId)).toHaveLength(before);
    expect(pi.calls).toHaveLength(0);
  });

  it('pending без running (задача простаивает) → 409, очередь не копится', async () => {
    const { db, pi, app } = makeEnv();
    const issueId = seedIssue(db);
    seedIteration(db, issueId, { number: 1, status: 'failed' });
    seedIteration(db, issueId, { number: 2, status: 'pending' });

    const before = iterationRows(db, issueId).length;
    const res = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: { context: 'ctx', steps: ['resolve'] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'A pending iteration already exists — wait for it to start',
    });
    expect(iterationRows(db, issueId)).toHaveLength(before);
    expect(pi.calls).toHaveLength(0);
  });

  it('repeat при draft без running → 409 (порядок итераций не ломается)', async () => {
    const { db, pi, app } = makeEnv();
    const issueId = seedIssue(db);
    const sourceId = seedIteration(db, issueId, {
      number: 1,
      status: 'completed',
    });
    seedIteration(db, issueId, { number: 2, status: 'draft' });

    const before = iterationRows(db, issueId).length;
    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${sourceId}/repeat`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'A draft iteration already exists — edit or delete it first',
    });
    expect(iterationRows(db, issueId)).toHaveLength(before);
    expect(pi.calls).toHaveLength(0);
  });

  it('без running-итерации создаёт pending и запускает пайплайн', async () => {
    const { db, pi, app } = makeEnv();
    const issueId = seedIssue(db);

    const res = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: { context: 'ctx', steps: ['resolve'] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');

    await waitFor(() => (pi.calls.length >= 1 ? true : undefined));
    const status = await waitFor(() => {
      const row = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, res.json().id))
        .get();
      return row?.status === 'completed' ? 'completed' : undefined;
    });
    expect(status).toBe('completed');
  });
});

describe('POST /iterations/:id/queue — постановка draft в очередь', () => {
  it('переводит draft → pending (200)', async () => {
    const { db, app } = makeEnv();
    const issueId = seedIssue(db);
    seedIteration(db, issueId, { number: 1, status: 'running' });
    const draftId = seedIteration(db, issueId, { number: 2, status: 'draft' });

    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${draftId}/queue`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
    const row = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, draftId))
      .get();
    expect(row?.status).toBe('pending');
  });

  it('не-draft итерацию поставить нельзя → 409', async () => {
    const { db, app } = makeEnv();
    const issueId = seedIssue(db);
    const pendingId = seedIteration(db, issueId, { number: 1, status: 'pending' });

    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${pendingId}/queue`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'only draft iterations can be queued',
    });
  });

  it('при уже существующем pending → 409, draft остаётся draft', async () => {
    const { db, app } = makeEnv();
    const issueId = seedIssue(db);
    seedIteration(db, issueId, { number: 1, status: 'running' });
    seedIteration(db, issueId, { number: 2, status: 'pending' });
    const draftId = seedIteration(db, issueId, { number: 3, status: 'draft' });

    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${draftId}/queue`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('A pending iteration already exists');
    const row = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, draftId))
      .get();
    expect(row?.status).toBe('draft');
  });

  it('неизвестная итерация → 404', async () => {
    const { app } = makeEnv();
    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${randomUUID()}/queue`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'iteration not found' });
  });
});

describe('POST /iterations/:id/repeat — та же draft-логика', () => {
  it('при running-итерации задача repeat создаёт draft', async () => {
    const { db, app } = makeEnv();
    const issueId = seedIssue(db);
    const sourceId = seedIteration(db, issueId, { number: 1, status: 'completed' });
    seedIteration(db, issueId, { number: 2, status: 'running' });

    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${sourceId}/repeat`,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('draft');
    expect(res.json().number).toBe(3);
  });

  it('repeat при running + draft → 409, без новой строки', async () => {
    const { db, app } = makeEnv();
    const issueId = seedIssue(db);
    const sourceId = seedIteration(db, issueId, { number: 1, status: 'completed' });
    seedIteration(db, issueId, { number: 2, status: 'running' });
    seedIteration(db, issueId, { number: 3, status: 'draft' });

    const before = iterationRows(db, issueId).length;
    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${sourceId}/repeat`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'A draft iteration already exists — edit or delete it first',
    });
    expect(iterationRows(db, issueId)).toHaveLength(before);
  });

  it('repeat при running + pending → 409, без новой строки', async () => {
    const { db, app } = makeEnv();
    const issueId = seedIssue(db);
    const sourceId = seedIteration(db, issueId, { number: 1, status: 'completed' });
    seedIteration(db, issueId, { number: 2, status: 'running' });
    seedIteration(db, issueId, { number: 3, status: 'pending' });

    const before = iterationRows(db, issueId).length;
    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${sourceId}/repeat`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'A pending iteration already exists — wait for it to start',
    });
    expect(iterationRows(db, issueId)).toHaveLength(before);
  });
});

describe('очередь: pending стартует после завершения running', () => {
  it('после running запускается ровно одна pending, агенты не пересекаются', async () => {
    const db = createDb(':memory:');
    const root = tempRoot('ir-queue-advance-');
    const issueId = seedIssue(db);
    const firstId = seedIteration(db, issueId, { number: 1, status: 'running' });
    const secondId = seedIteration(db, issueId, { number: 2, status: 'pending' });

    const pi = new ProbeRunner(true, 10);
    const { deps } = makeDeps(pi);
    deps.workspaceRoot = root;

    const result = await runIssueIteration(db, deps, {
      issue: issueInput(issueId, ['resolve']),
      iteration: {
        id: firstId,
        issueId,
        number: 1,
        context: 'ctx',
        steps: ['resolve'],
      },
      repositories: [],
      repoWorkspaces: [],
    });
    expect(result.iterationStatus).toBe('completed');

    const secondStatus = await waitFor(() => {
      const row = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, secondId))
        .get();
      return row && row.status !== 'pending' && row.status !== 'running'
        ? row.status
        : undefined;
    });
    expect(secondStatus).toBe('completed');

    const firstCalls = pi.calls.filter((call) => call.iterationId === firstId);
    const secondCalls = pi.calls.filter((call) => call.iterationId === secondId);
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(1);
    expect(firstCalls[0].endedAt).toBeLessThanOrEqual(secondCalls[0].startedAt as number);
    expect(pi.maxActive).toBe(1);
  });
});

describe('шаги итерации выполняются последовательно', () => {
  it('resolve → review идут один за другим; параллельных агентов нет', async () => {
    const db = createDb(':memory:');
    const root = tempRoot('ir-seq-');
    const issueId = seedIssue(db, ['resolve', 'review']);
    const iterationId = seedIteration(db, issueId, {
      number: 1,
      status: 'running',
      steps: ['resolve', 'review'],
    });

    const pi = new ProbeRunner(true, 15);
    const { deps } = makeDeps(pi);
    deps.workspaceRoot = root;

    const result = await runIssueIteration(db, deps, {
      issue: issueInput(issueId, ['resolve', 'review']),
      iteration: {
        id: iterationId,
        issueId,
        number: 1,
        context: 'ctx',
        steps: ['resolve', 'review'],
      },
      repositories: [],
      repoWorkspaces: [],
    });

    expect(result.iterationStatus).toBe('completed');
    expect(pi.calls).toHaveLength(2);
    expect(pi.maxActive).toBe(1);

    const runRows = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, iterationId))
      .all();
    const stepById = new Map(runRows.map((row) => [row.id, row.step]));
    expect(pi.calls.map((call) => stepById.get(call.id))).toEqual([
      'resolve',
      'review',
    ]);
  });
});

const ROOM_PLAN: ExecutionPlan = {
  mode: 'room',
  executors: 3,
  decomposition: ['бэкенд', 'фронтенд', 'тесты'],
  rationale: 'три независимые части — параллельно',
};

function roomInput(execution: ExecutionPlan): RoomResolveInput {
  return {
    containerName: 'issue-resolver-issue-1',
    execution,
    issueTitle: 'Fix bug',
    description: 'desc',
    jiraText: null,
    context: 'ctx',
    feedback: null,
    refinedPlan: 'plan',
    repoPaths: ['/workspaces/issue-1/app'],
    desiredResult: 'md',
    previousOutcome: null,
    attachmentPaths: [],
  };
}

const roomOptions: RoomResolveOptions = {
  stepRunId: 'run-1',
  iterationId: 'iter-1',
  issueId: 'issue-1',
};

describe('room-режим: исполнители одного шага бегут параллельно', () => {
  it('3 исполнителя стартуют одновременно, координатор — только после них', async () => {
    const pi = new ProbeRunner(false);
    const promise = runRoomResolve(pi, roomInput(ROOM_PLAN), roomOptions);

    await waitFor(() => (pi.active >= 3 ? true : undefined));
    expect(pi.active).toBe(3);
    expect(pi.maxActive).toBe(3);
    expect(pi.calls.map((call) => call.id)).toEqual([
      'run.run-1.w0',
      'run.run-1.w1',
      'run.run-1.w2',
    ]);
    expect(pi.calls.some((call) => call.id === 'run-1')).toBe(false);

    pi.releaseAll();
    await waitFor(() => (pi.calls.some((call) => call.id === 'run-1') ? true : undefined));
    expect(pi.active).toBe(1);

    pi.releaseAll();
    const result = await promise;
    expect(result.report?.summary).toBe('run-1 ok');
  });
});

describe('worker_count доезжает до refine-промпта', () => {
  it('POST /issues/:id/iterations с worker_count=3 → планировщик видит 3', async () => {
    const { db, pi, app } = makeEnv();
    const issueId = seedIssue(db);

    const res = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: { context: 'ctx', steps: ['refine'], worker_count: 3 },
    });
    expect(res.statusCode).toBe(201);

    await waitFor(() => (pi.calls.length > 0 ? pi.calls.length : undefined));
    const refinePrompt = pi.calls
      .map((call) => call.prompt)
      .find((text) => text.includes('Maximum parallel agents'));
    expect(refinePrompt).toBeDefined();
    expect(refinePrompt).toContain('Maximum parallel agents: 3');
    expect(refinePrompt).not.toContain('Maximum parallel agents: 1 (');
  });
});

describe('статус задачи при наличии pending-итерации в очереди', () => {
  it('после completed-итерации задача остаётся pending, если очередь не пуста', async () => {
    const db = createDb(':memory:');
    const root = tempRoot('ir-status-');
    const issueId = seedIssue(db);
    const firstId = seedIteration(db, issueId, { number: 1, status: 'running' });
    seedIteration(db, issueId, { number: 2, status: 'pending' });

    const pi = new ProbeRunner(true, 10);
    const { deps } = makeDeps(pi);
    deps.workspaceRoot = root;

    const result = await runIssueIteration(db, deps, {
      issue: issueInput(issueId, ['resolve']),
      iteration: {
        id: firstId,
        issueId,
        number: 1,
        context: 'ctx',
        steps: ['resolve'],
      },
      repositories: [],
      repoWorkspaces: [],
    });

    expect(result.iterationStatus).toBe('completed');

    const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
    expect(['pending', 'running']).toContain(issue?.status);

    await waitFor(() => {
      const row = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, firstId))
        .get();
      return row?.status === 'completed' ? true : undefined;
    });
    const secondStatus = await waitFor(() => {
      const row = db
        .select()
        .from(iterations)
        .where(eq(iterations.issue_id, issueId))
        .orderBy(iterations.number)
        .all()
        .at(-1);
      return row && row.status !== 'pending' && row.status !== 'running'
        ? row.status
        : undefined;
    });
    expect(secondStatus).toBe('completed');
  });

  it('после completed-итерации без очереди задача → completed', async () => {
    const db = createDb(':memory:');
    const root = tempRoot('ir-status-');
    const issueId = seedIssue(db);
    const iterationId = seedIteration(db, issueId, { number: 1, status: 'running' });

    const pi = new ProbeRunner(true, 10);
    const { deps } = makeDeps(pi);
    deps.workspaceRoot = root;

    await runIssueIteration(db, deps, {
      issue: issueInput(issueId, ['resolve']),
      iteration: {
        id: iterationId,
        issueId,
        number: 1,
        context: 'ctx',
        steps: ['resolve'],
      },
      repositories: [],
      repoWorkspaces: [],
    });

    const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
    expect(issue?.status).toBe('completed');
  });

  it('queue из draft → pending поправляет completed-задачу в pending', async () => {
    const { db, app } = makeEnv();
    const issueId = seedIssue(db);

    db.update(issues).set({ status: 'completed' }).where(eq(issues.id, issueId)).run();
    const draftId = seedIteration(db, issueId, { number: 1, status: 'draft' });

    const res = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${draftId}/queue`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');

    const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
    expect(issue?.status).toBe('pending');
  });
});