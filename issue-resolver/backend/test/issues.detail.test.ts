import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(): ReturnType<typeof buildApp> {
  const app = buildApp(createDb(':memory:'));
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

type App = ReturnType<typeof buildApp>;

async function createIssue(app: App, title = 'Задача'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: ROUTE_PATH,
    payload: {
      title,
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe('GET /issues/:id', () => {
  it('существующая задача → 200 и полный Issue', async () => {
    const app = makeApp();
    const id = await createIssue(app, 'Детали');

    const response = await app.inject({ method: 'GET', url: `${ROUTE_PATH}/${id}` });

    expect(response.statusCode).toBe(200);
    const issue = response.json();
    expect(issue.id).toBe(id);
    expect(issue.title).toBe('Детали');
    // Фоновый прогон стартует сразу после создания → running/completed.
    expect(['running', 'completed']).toContain(issue.status);
    expect(issue.jira_issue_url).toBeNull();
    expect(issue.pipeline_steps).toEqual(['refine', 'resolve']);
    expect(issue.repositories).toHaveLength(1);
    expect(issue.repositories[0].branch_name).toBe('main');
  });

  it('неизвестный id → 404 { error }', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'issue not found' });
  });
});

describe('GET /issues/:id/iterations', () => {
  it('сразу после создания → 200 с iteration #1', async () => {
    const app = makeApp();
    const id = await createIssue(app);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${id}/iterations`,
    });

    expect(response.statusCode).toBe(200);
    const list = response.json();
    expect(list).toHaveLength(1);
    expect(list[0].number).toBe(1);
    // Фоновый прогон стартует сразу после создания → running/completed.
    expect(['running', 'completed']).toContain(list[0].status);
    expect(list[0].steps).toEqual(['refine', 'resolve']);
    expect(list[0].issue_id).toBe(id);
  });

  it('неизвестный id → 404', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${randomUUID()}/iterations`,
    });

    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe('string');
  });
});

describe('POST /issues/:id/iterations', () => {
  it('{ context: "restart" } → 201 iteration #2, затем список [1, 2]', async () => {
    const app = makeApp();
    const id = await createIssue(app, 'Перезапуск');

    const created = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${id}/iterations`,
      payload: { context: 'restart' },
    });

    expect(created.statusCode).toBe(201);
    const iteration = created.json();
    expect(iteration.number).toBe(2);
    expect(iteration.status).toBe('pending');
    expect(iteration.issue_id).toBe(id);
    expect(iteration.context).toBe('restart');
    expect(iteration.steps).toEqual(['refine', 'resolve']);

    const list = (
      await app.inject({ method: 'GET', url: `${ROUTE_PATH}/${id}/iterations` })
    ).json();
    expect(list.map((item: { number: number }) => item.number)).toEqual([1, 2]);
  });

  it('steps override → 201 со своими шагами', async () => {
    const app = makeApp();
    const id = await createIssue(app);

    const created = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${id}/iterations`,
      payload: { context: 'свои шаги', steps: ['review', 'test'] },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().steps).toEqual(['review', 'test']);
  });

  it('пустой context → 400', async () => {
    const app = makeApp();
    const id = await createIssue(app);

    const response = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${id}/iterations`,
      payload: { context: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('неизвестный id → 404', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${randomUUID()}/iterations`,
      payload: { context: 'restart' },
    });

    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe('string');
  });
});