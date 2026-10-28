/**
 * E2E полного конвейера по всем 4 топологиям resolve.
 *
 * В отличие от `execution-topology-demo.test.ts` (там зовётся только
 * `runRoomResolve`/`runStagedResolve` напрямую) здесь гоняется НАСТОЯЩИЙ
 * pipeline через `runIssueIteration`: refine объявляет `execution`-план,
 * движок ветвится по `planExecutionMode`, и для каждой топологии
 * доказывается, что итерация завершается `completed`, issue — `completed`,
 * а step_run resolve — `success` (никогда `aborted`).
 *
 * Топологии и число pi-вызовов resolve:
 *   1. single            — 1 агент
 *   2. room              — 3 исполнителя ∥ + 1 координатор
 *   3. stages 3×1        — 3 агента-этапа по одному + 1 финальный lead
 *   4. stages-микс 2→1→3 — (2 исполнителя ∥ + координатор) → (1 агент) →
 *                          (3 исполнителя ∥ + координатор) → финальный lead
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionPlan,
  Iteration,
  PipelineStep,
  SSEEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations, stepRuns } from '../src/db/schema';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import {
  runIssueIteration,
  type IterationRunDeps,
} from '../src/workflow/run-iteration.service';

const NOW = '2026-06-01T00:00:00.000Z';
const STEPS: PipelineStep[] = ['refine', 'resolve'];

/** resolve-результат «прошло» для одного pi-агента (исполнитель/координатор/lead). */
const passResolve = (summary = 'resolve ok'): StepExecutionResult => ({
  step: 'resolve',
  exitCode: 0,
  report: { status: 'pass', summary },
  stdout: '',
  stderr: '',
});

/** refine-результат с рекомендацией топологии для следующего resolve. */
const refineWithPlan = (execution: ExecutionPlan): StepExecutionResult => ({
  step: 'refine',
  exitCode: 0,
  report: { status: 'pass', summary: 'plan', execution },
  stdout: '',
  stderr: '',
});

interface Seeded {
  issueId: string;
  iterationId: string;
}

function seedIteration(db: Db, steps: PipelineStep[] = STEPS): Seeded {
  const issueId = randomUUID();
  const iterationId = randomUUID();

  db.insert(issues)
    .values({
      id: issueId,
      title: 'Топология pipeline',
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

  return { issueId, iterationId };
}

function makeDeps(workspaceRoot: string): {
  deps: IterationRunDeps;
  pi: FakePiRunner;
  sse: InMemorySseHub;
} {
  const pi = new FakePiRunner();
  const sse = new InMemorySseHub();
  const deps: IterationRunDeps = {
    container: new FakeContainerController(),
    git: new FakeGitService(),
    mr: new FakeMrClient(),
    pi,
    sse,
    control: new InMemoryStepSessionRegistry(),
    workspaceRoot,
  };
  return { deps, pi, sse };
}

/** Дескриптор вызовов resolve: роль/stage/index/label (без refine-вызова). */
interface AgentDescriptor {
  role: string | undefined;
  stage: number | null;
  index: number | null | undefined;
  label: string | undefined;
}

function resolveAgents(pi: FakePiRunner): AgentDescriptor[] {
  // calls[0] — refine (без агента), дальше — агенты resolve. Post-iteration
  // report-агент (нет iterationId) в топологию не входит.
  return pi.calls
    .filter((call) => call.options?.iterationId !== undefined)
    .slice(1)
    .map((call) => {
      const agent = call.options?.agent;
      return {
        role: agent?.role,
        stage: agent?.stage ?? null,
        index: agent?.index,
        label: agent?.label,
      };
    });
}

describe('pipeline E2E — 4 топологии resolve (refine → resolve)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'issue-resolver-topology-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Общий прогон: seed → refine с планом → N resolve-результатов → проверки. */
  async function runTopology(
    plan: ExecutionPlan,
    resolveResultCount: number,
  ): Promise<{
    db: Db;
    pi: FakePiRunner;
    events: SSEEvent[];
    seeded: Seeded;
    result: Awaited<ReturnType<typeof runIssueIteration>>;
  }> {
    const db = createDb(':memory:');
    const seeded = seedIteration(db);
    const { deps, pi, sse } = makeDeps(root);
    // Подписка ДО прогона: ловим iteration_status running → completed.
    const events: SSEEvent[] = [];
    sse.subscribe(seeded.iterationId, (event) => events.push(event));

    pi.enqueue(refineWithPlan(plan));
    for (let i = 0; i < resolveResultCount; i += 1) {
      pi.enqueue(passResolve());
    }

    const result = await runIssueIteration(db, deps, {
      issue: {
        id: seeded.issueId,
        title: 'Топология pipeline',
        pipelineSteps: STEPS,
      },
      iteration: {
        id: seeded.iterationId,
        issueId: seeded.issueId,
        number: 1,
        context: 'контекст итерации',
        steps: STEPS,
      },
      repositories: [],
      repoWorkspaces: [],
    });

    return { db, pi, events, seeded, result };
  }

  /** Инварианты, общие для всех топологий: completed/success/не aborted. */
  function expectCompleted(
    db: Db,
    seeded: Seeded,
    result: Awaited<ReturnType<typeof runIssueIteration>>,
    expectedPiCalls: number,
    pi: FakePiRunner,
    events: SSEEvent[],
  ): void {
    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });

    const iterationRow = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, seeded.iterationId))
      .get();
    expect(iterationRow?.status).toBe('completed');

    const issueRow = db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .get();
    expect(issueRow?.status).toBe('completed');

    const runs = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, seeded.iterationId))
      .all();
    expect(runs).toHaveLength(2);

    const refineRun = runs.find((run) => run.step === 'refine');
    const resolveRun = runs.find((run) => run.step === 'resolve');
    expect(refineRun?.status).toBe('success');
    expect(resolveRun?.status).toBe('success');
    // resolve НИКОГДА не aborted — иначе итерация была бы `cancelled`.
    expect(resolveRun?.status).not.toBe('aborted');

    // Ровно refine + агенты топологии; ни одного лишнего pi-вызова. Post-iteration
    // report-агент идёт после конвейера и в счёт шагов не входит (нет iterationId).
    expect(
      pi.calls.filter((call) => call.options?.iterationId !== undefined),
    ).toHaveLength(expectedPiCalls);

    // Последнее iteration_status в SSE — completed, не cancelled.
    const last = events
      .filter((event) => event.type === 'iteration_status')
      .at(-1);
    expect(last).toBeDefined();
    expect(JSON.parse(last!.data)).toMatchObject({
      iterationId: seeded.iterationId,
      status: 'completed',
      needsInput: false,
    });
  }

  it('single: refine → один агент resolve (без room/stage)', async () => {
    const plan: ExecutionPlan = { mode: 'single', rationale: 'one agent' };
    const { db, pi, events, seeded, result } = await runTopology(plan, 1);

    expectCompleted(db, seeded, result, 2, pi, events);
    expect(resolveAgents(pi)).toEqual([
      { role: undefined, stage: null, index: undefined, label: undefined },
    ]);
  });

  it('room: refine → 3 исполнителя ∥ + 1 координатор', async () => {
    const plan: ExecutionPlan = {
      mode: 'room',
      executors: 3,
      decomposition: ['a', 'b', 'c'],
      rationale: 'parallel',
    };
    const { db, pi, events, seeded, result } = await runTopology(plan, 4);

    expectCompleted(db, seeded, result, 5, pi, events);
    expect(resolveAgents(pi)).toEqual([
      { role: 'worker', stage: null, index: 1, label: 'Исполнитель 1' },
      { role: 'worker', stage: null, index: 2, label: 'Исполнитель 2' },
      { role: 'worker', stage: null, index: 3, label: 'Исполнитель 3' },
      { role: 'coordinator', stage: null, index: null, label: 'Координатор' },
    ]);

    const resolveRun = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, seeded.iterationId))
      .all()
      .find((run) => run.step === 'resolve');
    // Исполнители нумеруются 0-based в id, координатор = stepRunId шага.
    expect(pi.calls[1].options?.stepRunId).toBe(`run.${resolveRun?.id}.w0`);
    expect(pi.calls[2].options?.stepRunId).toBe(`run.${resolveRun?.id}.w1`);
    expect(pi.calls[3].options?.stepRunId).toBe(`run.${resolveRun?.id}.w2`);
    expect(pi.calls[4].options?.stepRunId).toBe(resolveRun?.id);
  });

  it('stages 3×1: refine → 3 исполнителя-этапа последовательно + финальный lead', async () => {
    const plan: ExecutionPlan = {
      mode: 'stages',
      stages: [
        { index: 1, name: 'D', executors: 1 },
        { index: 2, name: 'I', executors: 1 },
        { index: 3, name: 'P', executors: 1 },
      ],
      rationale: 'seq',
    };
    const { db, pi, events, seeded, result } = await runTopology(plan, 4);

    expectCompleted(db, seeded, result, 5, pi, events);
    expect(resolveAgents(pi)).toEqual([
      { role: 'worker', stage: 1, index: 1, label: 'Этап 1 · Исполнитель 1' },
      { role: 'worker', stage: 2, index: 1, label: 'Этап 2 · Исполнитель 1' },
      { role: 'worker', stage: 3, index: 1, label: 'Этап 3 · Исполнитель 1' },
      { role: 'coordinator', stage: null, index: null, label: 'Координатор' },
    ]);

    const resolveRun = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, seeded.iterationId))
      .all()
      .find((run) => run.step === 'resolve');
    expect(
      pi.calls
        .filter((call) => call.options?.iterationId !== undefined)
        .map((call) => call.options?.stepRunId),
    ).toEqual([
      pi.calls[0].options?.stepRunId, // refine
      `run.${resolveRun?.id}.s1.w0`,
      `run.${resolveRun?.id}.s2.w0`,
      `run.${resolveRun?.id}.s3.w0`,
      resolveRun?.id,
    ]);
  });

  it('stages-микс 2→1→3: параллель → последовательность → параллель → финал', async () => {
    const plan: ExecutionPlan = {
      mode: 'stages',
      stages: [
        {
          index: 1,
          name: 'Фундамент',
          executors: 2,
          decomposition: ['бэкенд', 'фронтенд'],
        },
        { index: 2, name: 'Интеграция', executors: 1 },
        {
          index: 3,
          name: 'Полировка',
          executors: 3,
          decomposition: ['тесты', 'документация', 'ревью'],
        },
      ],
      rationale: 'mix',
    };
    const { db, pi, events, seeded, result } = await runTopology(plan, 9);

    // refine + 2 исполнителя + coord этапа1 + исполнитель этапа2 + 3 исполнителя +
    // coord этапа3 + финальный lead = 10 pi-вызовов (9 агентов resolve).
    expectCompleted(db, seeded, result, 10, pi, events);
    expect(resolveAgents(pi)).toEqual([
      { role: 'worker', stage: 1, index: 1, label: 'Этап 1 · Исполнитель 1' },
      { role: 'worker', stage: 1, index: 2, label: 'Этап 1 · Исполнитель 2' },
      { role: 'coordinator', stage: 1, index: null, label: 'Этап 1 · Координатор' },
      { role: 'worker', stage: 2, index: 1, label: 'Этап 2 · Исполнитель 1' },
      { role: 'worker', stage: 3, index: 1, label: 'Этап 3 · Исполнитель 1' },
      { role: 'worker', stage: 3, index: 2, label: 'Этап 3 · Исполнитель 2' },
      { role: 'worker', stage: 3, index: 3, label: 'Этап 3 · Исполнитель 3' },
      { role: 'coordinator', stage: 3, index: null, label: 'Этап 3 · Координатор' },
      { role: 'coordinator', stage: null, index: null, label: 'Координатор' },
    ]);

    const resolveRun = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, seeded.iterationId))
      .all()
      .find((run) => run.step === 'resolve');
    expect(
      pi.calls
        .filter((call) => call.options?.iterationId !== undefined)
        .map((call) => call.options?.stepRunId),
    ).toEqual([
      pi.calls[0].options?.stepRunId, // refine
      `run.${resolveRun?.id}.s1.w0`,
      `run.${resolveRun?.id}.s1.w1`,
      `run.${resolveRun?.id}.s1.lead`,
      `run.${resolveRun?.id}.s2.w0`,
      `run.${resolveRun?.id}.s3.w0`,
      `run.${resolveRun?.id}.s3.w1`,
      `run.${resolveRun?.id}.s3.w2`,
      `run.${resolveRun?.id}.s3.lead`,
      resolveRun?.id,
    ]);
  });
});