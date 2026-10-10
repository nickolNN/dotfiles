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

type App = ReturnType<typeof buildApp>;

async function getIterations(app: App, issueId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `${ROUTE_PATH}/${issueId}/iterations`,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Array<Record<string, unknown>>;
}

describe('review-поля итерации — spec-parity', () => {
  it('POST /issues additional_context → issue.description и iteration#1.context', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'С описанием',
        repositories: REPOSITORIES,
        additional_context: 'важный контекст задачи',
      },
    });

    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;
    expect(created.json().description).toBe('важный контекст задачи');

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(fetched.json().description).toBe('важный контекст задачи');

    const list = await getIterations(app, issueId);
    expect(list[0].context).toBe('важный контекст задачи');
  });

  it('POST /issues с is_review_need:true → review_context сохранён и review в шагах', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'Review-задача',
        repositories: REPOSITORIES,
        is_review_need: true,
        review_context: 'ctx',
      },
    });

    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    const list = await getIterations(app, issueId);
    expect(list).toHaveLength(1);
    expect(list[0].is_review_need).toBe(true);
    expect(list[0].review_context).toBe('ctx');
    expect(list[0].steps).toContain('review');
    expect(list[0].steps).toContain('resolve');
  });

  it('POST /issues без is_review_need → false и review_context === ""', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Без review', repositories: REPOSITORIES },
    });

    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    const list = await getIterations(app, issueId);
    expect(list).toHaveLength(1);
    expect(list[0].is_review_need).toBe(false);
    expect(list[0].review_context).toBe('');
  });

  it('POST /issues/:id/iterations с is_review_need:true → поля на итерации #2', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Итерация с review', repositories: REPOSITORIES },
    });
    const issueId = created.json().id as string;

    const iteration = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${issueId}/iterations`,
      payload: { context: 'restart', is_review_need: true, review_context: 'rctx' },
    });

    expect(iteration.statusCode).toBe(201);
    expect(iteration.json().is_review_need).toBe(true);
    expect(iteration.json().review_context).toBe('rctx');
    expect(iteration.json().steps).toContain('review');

    const list = await getIterations(app, issueId);
    expect(list).toHaveLength(2);
    expect(list[1].is_review_need).toBe(true);
    expect(list[1].review_context).toBe('rctx');
  });
});