import { afterEach, describe, expect, it } from 'vitest';
import type { SavedRepo } from '@issue-resolver/shared';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { getRepositoryTestCredentials } from '../src/db/repositories.repo';

const ROUTE = '/issue-resolver/api/v1/repositories';

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp() {
  const db = createDb(':memory:');
  const app = buildApp(db, {
    repoResolverFactory: () => ({
      resolve: async () => ({
        platform: 'github',
        fullName: 'acme/app',
        defaultBranch: 'main',
        branches: ['main'],
        language: 'TypeScript',
        description: 'demo',
        stars: 1,
        isPrivate: false,
        cloneUrl: 'https://github.com/acme/app.git',
        writeAccess: true,
      }),
    }),
  });
  openApps.push(app);
  return { app, db };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function createRepo(
  app: ReturnType<typeof buildApp>,
  db: ReturnType<typeof createDb>,
): Promise<SavedRepo> {
  const response = await app.inject({
    method: 'POST',
    url: ROUTE,
    payload: { url: 'https://github.com/acme/app' },
  });
  expect(response.statusCode).toBe(201);
  expect(getRepositoryTestCredentials(db, 'https://github.com/acme/app')).toBe(
    null,
  );
  return response.json() as SavedRepo;
}

describe('PUT /repositories/:id/credentials', () => {
  it('сохраняет тестовый аккаунт и отдаёт его в ответе', async () => {
    const { app, db } = makeApp();
    const repo = await createRepo(app, db);

    const response = await app.inject({
      method: 'PUT',
      url: `${ROUTE}/${repo.id}/credentials`,
      payload: { testCredentials: 'https://dev.example.com · login · secret' },
    });

    expect(response.statusCode).toBe(200);
    const saved = response.json() as SavedRepo;
    expect(saved.testCredentials).toBe(
      'https://dev.example.com · login · secret',
    );
    expect(
      getRepositoryTestCredentials(db, 'https://github.com/acme/app'),
    ).toBe('https://dev.example.com · login · secret');
  });

  it('пустая строка очищает креды в null', async () => {
    const { app, db } = makeApp();
    const repo = await createRepo(app, db);
    await app.inject({
      method: 'PUT',
      url: `${ROUTE}/${repo.id}/credentials`,
      payload: { testCredentials: 'login: secret' },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `${ROUTE}/${repo.id}/credentials`,
      payload: { testCredentials: '   ' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as SavedRepo).testCredentials).toBeNull();
  });

  it('неизвестный id → 404', async () => {
    const { app } = makeApp();

    const response = await app.inject({
      method: 'PUT',
      url: `${ROUTE}/missing/credentials`,
      payload: { testCredentials: 'x' },
    });

    expect(response.statusCode).toBe(404);
  });
});