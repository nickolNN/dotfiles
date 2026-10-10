import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

const REPOSITORIES = [
  { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
];

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(): ReturnType<typeof buildApp> {
  const app = buildApp(createDb(':memory:'));
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('create_mr — per-repo режим сдачи (spec-parity)', () => {
  it('POST /issues repositories[].create_mr:true → репо.create_mr true и pr в шагах', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'С MR',
        desired_result: 'pr',
        repositories: [{ ...REPOSITORIES[0], create_mr: true }],
      },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.repositories[0].create_mr).toBe(true);
    expect(body.pipeline_steps).toContain('pr');

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${body.id}`,
    });
    expect(fetched.json().repositories[0].create_mr).toBe(true);
  });

  it('POST /issues без create_mr → репо.create_mr false и pr нет в шагах', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Без MR', repositories: REPOSITORIES },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.repositories[0].create_mr).toBe(false);
    expect(body.pipeline_steps).not.toContain('pr');
  });

  it('POST /issues/:id/iterations наследует per-repo create_mr → pr в шагах', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'Итерация с MR',
        desired_result: 'pr',
        repositories: [{ ...REPOSITORIES[0], create_mr: true }],
      },
    });
    const issueId = created.json().id as string;

    const iteration = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${issueId}/iterations`,
      payload: { context: 'restart' },
    });

    expect(iteration.statusCode).toBe(201);
    expect(iteration.json().steps).toContain('pr');
  });
});