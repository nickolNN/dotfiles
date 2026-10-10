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

describe('POST /issues — repositories необязательны', () => {
  it('repositories:[] → 201 и issue.repositories === []', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Без репозиториев', repositories: [] },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.repositories).toEqual([]);

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${body.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().repositories).toEqual([]);
  });

  it('repositories отсутствует → 201 и issue.repositories === []', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Совсем без репозиториев' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().repositories).toEqual([]);
  });
});