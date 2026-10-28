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

async function createIssue(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
) {
  return app.inject({ method: 'POST', url: ROUTE_PATH, payload });
}

describe('выбор шагов: задача (POST /issues)', () => {
  it('без галочек (pipeline_steps: []) → 400, задача не создаётся', async () => {
    const app = makeApp();

    const res = await createIssue(app, {
      title: 'Без шагов',
      pipeline_steps: [],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('хотя бы один шаг');

    const list = await app.inject({ method: 'GET', url: ROUTE_PATH });
    expect(list.json().items ?? list.json()).toEqual([]);
  });

  it('одна галочка: только MR без resolve → шаги остаются [pr]', async () => {
    const app = makeApp();

    const res = await createIssue(app, {
      title: 'Только MR',
      pipeline_steps: ['pr'],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_steps).toEqual(['pr']);
  });

  it('две галочки: review + pr → порядок сохраняется, resolve не дописан', async () => {
    const app = makeApp();

    const res = await createIssue(app, {
      title: 'Ревью и MR',
      pipeline_steps: ['review', 'pr'],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_steps).toEqual(['review', 'pr']);
  });

  it('без pr в галочках → pr не дописывается даже с create_mr у репозитория', async () => {
    const app = makeApp();

    const res = await createIssue(app, {
      title: 'Ревью без MR',
      pipeline_steps: ['resolve', 'review'],
      repositories: [
        {
          repository_url: 'https://github.com/acme/app.git',
          base_branch: 'main',
          create_mr: false,
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_steps).toEqual(['resolve', 'review']);
  });

  it('четыре галочки + create_mr репозитория → pr дописан в конец', async () => {
    const app = makeApp();

    const res = await createIssue(app, {
      title: 'Полный набор',
      pipeline_steps: ['refine', 'resolve', 'review', 'test'],
      repositories: [
        {
          repository_url: 'https://github.com/acme/app.git',
          base_branch: 'main',
          create_mr: true,
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_steps).toEqual([
      'refine',
      'resolve',
      'review',
      'test',
      'pr',
    ]);
  });

  it('дубликаты схлопываются, порядок остаётся пользовательским', async () => {
    const app = makeApp();

    const res = await createIssue(app, {
      title: 'Дубли',
      pipeline_steps: ['review', 'resolve', 'review', 'pr'],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_steps).toEqual(['review', 'resolve', 'pr']);
  });

  it('PUT черновика с пустым pipeline_steps → 400 (снять все галочки нельзя)', async () => {
    const app = makeApp();
    const created = await createIssue(app, {
      title: 'Задача',
      pipeline_steps: ['resolve'],
      run_immediately: false,
    });
    const issueId = created.json().id;

    const put = await app.inject({
      method: 'PUT',
      url: `${ROUTE_PATH}/${issueId}`,
      payload: { pipeline_steps: [] },
    });

    expect(put.statusCode).toBe(400);
    expect(put.json().error).toContain('хотя бы один шаг');
  });

  it('PUT черновика: снятая галочка resolve остаётся снятой', async () => {
    const app = makeApp();
    const created = await createIssue(app, {
      title: 'Задача',
      pipeline_steps: ['resolve', 'pr'],
      run_immediately: false,
    });
    const issueId = created.json().id;

    const put = await app.inject({
      method: 'PUT',
      url: `${ROUTE_PATH}/${issueId}`,
      payload: { pipeline_steps: ['pr'] },
    });

    expect(put.statusCode).toBe(200);
    expect(put.json().pipeline_steps).toEqual(['pr']);
  });
});