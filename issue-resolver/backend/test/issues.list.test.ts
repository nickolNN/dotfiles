import { randomUUID } from 'node:crypto';
import type { PipelineStep } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations } from '../src/db/schema';

const ENDPOINT = '/issue-resolver/api/v1/issues';

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(): { app: ReturnType<typeof buildApp>; db: Db } {
  const db = createDb(':memory:');
  const app = buildApp(db);
  openApps.push(app);
  return { app, db };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function insertIssue(
  db: Db,
  overrides: {
    id?: string;
    title?: string;
    jira_issue_url?: string | null;
    pipeline_steps?: Array<'refine' | 'resolve' | 'review' | 'test' | 'pr'>;
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    created_at?: string;
  } = {},
): string {
  const id = overrides.id ?? randomUUID();
  const createdAt = overrides.created_at ?? new Date().toISOString();
  db.insert(issues)
    .values({
      id,
      title: overrides.title ?? 'Задача',
      jira_issue_url: overrides.jira_issue_url ?? null,
      pipeline_steps: overrides.pipeline_steps ?? ['resolve'],
      container_name: null,
      status: overrides.status ?? 'pending',
      created_at: createdAt,
      updated_at: createdAt,
    })
    .run();
  return id;
}

const list = (app: ReturnType<typeof buildApp>) =>
  app.inject({ method: 'GET', url: ENDPOINT });

describe('GET /issues — список', () => {
  it('пустая БД → 200 и [] (bare-массив)', async () => {
    const { app } = makeApp();

    const response = await list(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  it('две задачи → length 2, сортировка created_at DESC', async () => {
    const { app, db } = makeApp();
    const older = insertIssue(db, {
      title: 'Старая',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const newer = insertIssue(db, {
      title: 'Новая',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    const response = await list(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body.map((issue: { id: string }) => issue.id)).toEqual([
      newer,
      older,
    ]);
    expect(body[0].created_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('созданная через POST задача → полный Issue с repositories/pipeline_steps', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: {
        title: 'Полная задача',
        repositories: [
          {
            repository_url: 'https://github.com/acme/app.git',
            base_branch: 'main',
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();

    const response = await list(app);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toHaveLength(1);
    const issue = body[0];

    expect(issue.id).toBe(createdBody.id);
    expect(issue.title).toBe('Полная задача');
    expect(issue.jira_issue_url).toBeNull();
    // Фоновый прогон стартует сразу после создания → running/completed.
    expect(['running', 'completed']).toContain(issue.status);
    expect(issue.pipeline_steps).toEqual(['refine', 'resolve']);
    expect(issue.repositories).toHaveLength(1);
    expect(issue.repositories[0]).toMatchObject({
      repository_url: 'https://github.com/acme/app.git',
      branch_name: 'main',
    });
    expect(typeof issue.repositories[0].id).toBe('string');
    expect(typeof issue.created_at).toBe('string');
  });

  it('jira_issue_url без title → value в списке', async () => {
    const { app } = makeApp();

    await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: {
        jira_issue_url: 'https://jira.example.com/browse/KLA-5672',
        repositories: [
          {
            repository_url: 'https://github.com/acme/app.git',
            base_branch: 'main',
          },
        ],
      },
    });

    const body = (await list(app)).json();
    expect(body[0].jira_issue_url).toBe(
      'https://jira.example.com/browse/KLA-5672',
    );
  });

  it('status берётся из последней итерации, а не из денормализованного столбца', async () => {
    const { app, db } = makeApp();
    const issueId = insertIssue(db, {
      title: 'С итерациями',
      status: 'pending', // устаревший денормализованный статус
    });

    const base = {
      issue_id: issueId,
      context: '',
      steps: ['resolve'] as PipelineStep[],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.insert(iterations)
      .values({ ...base, id: randomUUID(), number: 1, status: 'completed' })
      .run();
    db.insert(iterations)
      .values({ ...base, id: randomUUID(), number: 2, status: 'failed' })
      .run();

    const response = await list(app);
    expect(response.statusCode).toBe(200);

    const issue = response
      .json()
      .find((item: { id: string }) => item.id === issueId);
    expect(issue.status).toBe('failed');
  });

  it('задача без итераций → status pending', async () => {
    const { app, db } = makeApp();
    const issueId = insertIssue(db, { title: 'Без итераций' });

    const body = (await list(app)).json();
    const issue = body.find((item: { id: string }) => item.id === issueId);
    expect(issue.status).toBe('pending');
  });
});