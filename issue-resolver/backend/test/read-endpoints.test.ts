import { randomUUID } from 'node:crypto';
import type { ModelDescriptor } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { createStepOutput, createStepRun } from '../src/db/step-runs.repo';
import { issues, iterations } from '../src/db/schema';
import { ConfigModelSource } from '../src/models/source';

const STEP_RUNS_PATH = '/issue-resolver/api/v1/iterations';

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(db: Db): ReturnType<typeof buildApp> {
  const app = buildApp(db);
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/**
 * Прямой insert issue + iteration: POST /issues теперь сам запускает resolve#1,
 * поэтому фикстура создаёт итерацию в обход фонового прогона.
 */
function seedIteration(db: Db): string {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const iterationId = randomUUID();

  db.insert(issues)
    .values({
      id: issueId,
      title: 'Задача со шагами',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();

  db.insert(iterations)
    .values({
      id: iterationId,
      issue_id: issueId,
      number: 1,
      context: '',
      steps: ['resolve'],
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();

  return iterationId;
}

describe('GET /iterations/:id/step-runs', () => {
  it('200: шаги в порядке конвейера (step-first), внутри шага attempt ASC', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db);
    const iterationId = seedIteration(db);

    // Порядок вставки намеренно обратный canonical, чтобы поймать регрессию.
    await createStepRun(db, {
      iterationId,
      step: 'review',
      attempt: 1,
      context: 'review ctx',
    });
    await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'resolve ctx',
    });
    await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 2,
      context: 'resolve retry ctx',
    });

    const response = await app.inject({
      method: 'GET',
      url: `${STEP_RUNS_PATH}/${iterationId}/step-runs`,
    });

    expect(response.statusCode).toBe(200);
    const runs = response.json() as Array<{
      step: string;
      attempt: number;
      status: string;
      iteration_id: string;
    }>;
    expect(runs).toHaveLength(3);
    // step-first: resolve#1, resolve#2, затем review#1 (не attempt-first).
    expect(runs.map((run) => `${run.step}#${run.attempt}`)).toEqual([
      'resolve#1',
      'resolve#2',
      'review#1',
    ]);
    for (const run of runs) {
      expect(run.iteration_id).toBe(iterationId);
      expect(run.status).toBe('pending');
    }
  });

  it('200: объекты содержат stdout/stderr/report (лог шага)', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db);
    const iterationId = seedIteration(db);

    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'ctx',
    });
    await createStepOutput(db, {
      stepRunId: run.id,
      report: '{"status":"pass","summary":"ok"}',
      stdout: 'сырой stdout',
      stderr: 'сырой stderr',
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 },
        cost: 0.01,
        contextUsage: null,
      },
    });
    await createStepRun(db, {
      iterationId,
      step: 'review',
      attempt: 1,
      context: 'review ctx',
    });

    const response = await app.inject({
      method: 'GET',
      url: `${STEP_RUNS_PATH}/${iterationId}/step-runs`,
    });

    expect(response.statusCode).toBe(200);
    const runs = response.json() as Array<{
      step: string;
      stdout: string;
      stderr: string;
      report: string | null;
      stats: unknown;
    }>;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      step: 'resolve',
      stdout: 'сырой stdout',
      stderr: 'сырой stderr',
      report: '{"status":"pass","summary":"ok"}',
      stats: { totalMessages: 2, tokens: { total: 7 }, cost: 0.01 },
    });
    expect(runs[1]).toMatchObject({
      step: 'review',
      stdout: '',
      stderr: '',
      report: null,
      stats: null,
    });
  });

  it('несуществующая итерация → 404 { error }', async () => {
    const app = makeApp(createDb(':memory:'));

    const response = await app.inject({
      method: 'GET',
      url: `${STEP_RUNS_PATH}/${randomUUID()}/step-runs`,
    });

    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe('string');
  });
});

describe('GET /models', () => {
  it('200: массив ModelDescriptor без ключей', async () => {
    const app = makeApp(createDb(':memory:'));

    const response = await app.inject({
      method: 'GET',
      url: '/issue-resolver/api/v1/models',
    });

    expect(response.statusCode).toBe(200);
    const models = response.json();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
    }
  });
});

describe('ConfigModelSource', () => {
  it('list() возвращает ровно переданный массив', async () => {
    const models: ModelDescriptor[] = [
      { id: 'a', name: 'A' },
      { id: 'b', provider: 'p' },
    ];
    const source = new ConfigModelSource(models);

    expect(await source.list()).toEqual(models);
  });
});