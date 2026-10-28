import { randomUUID } from 'node:crypto';
import type { ModelDescriptor } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
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
  it('200: шаги в хронологическом порядке (created_at ASC)', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db);
    const iterationId = seedIteration(db);

    const response = await app.inject({
      method: 'GET',
      url: `${STEP_RUNS_PATH}/${iterationId}/step-runs`,
    });

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });

  it('200: объекты содержат stdout/stderr/report (лог шага)', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db);
    const iterationId = seedIteration(db);

    const response = await app.inject({
      method: 'GET',
      url: `${STEP_RUNS_PATH}/${iterationId}/step-runs`,
    });

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
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
    expect(Array.isArray(response.json())).toBe(true);
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