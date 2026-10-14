import { afterEach, describe, expect, it } from 'vitest';
import type { SavedRepo } from '@issue-resolver/shared';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db/client';
import { insertRepository } from '../src/db/repositories.repo';

const ROUTE = '/issue-resolver/api/v1/issues';

const openApps: Array<{ close: () => Promise<void> }> = [];

function seedRepo(db: Db, overrides: Partial<SavedRepo> = {}): SavedRepo {
  return insertRepository(db, {
    url: overrides.url ?? 'https://github.com/acme/app',
    platform: overrides.platform === undefined ? 'github' : overrides.platform,
    fullName: overrides.fullName === undefined ? 'acme/app' : overrides.fullName,
    defaultBranch:
      overrides.defaultBranch === undefined ? 'main' : overrides.defaultBranch,
    cloneUrl: overrides.cloneUrl ?? 'https://github.com/acme/app.git',
    language: overrides.language ?? 'TypeScript',
    description: overrides.description ?? 'demo',
    isPrivate: overrides.isPrivate ?? false,
    connectionStatus: overrides.connectionStatus ?? 'ok',
    lastValidatedAt: overrides.lastValidatedAt ?? new Date().toISOString(),
    writeAccess: overrides.writeAccess ?? true,
  });
}

function makeApp(): { db: Db; repo: SavedRepo; app: ReturnType<typeof buildApp> } {
  const db = createDb(':memory:');
  const repo = seedRepo(db);
  const app = buildApp(db);
  openApps.push(app);
  return { db, repo, app };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('POST /issues — repo_id', () => {
  it('repo_id + base_branch + create_mr → 201, URL/ветка из репо', async () => {
    const { repo, app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: {
        title: 'Задача по сохранённому репо',
        repositories: [
          { repo_id: repo.id, base_branch: 'develop', create_mr: true },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0]).toMatchObject({
      repository_url: 'https://github.com/acme/app.git',
      branch_name: 'develop',
      create_mr: true,
    });
  });

  it('repo_id без base_branch → defaultBranch репозитория', async () => {
    const { repo, app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { title: 'Ветка по умолчанию', repositories: [{ repo_id: repo.id }] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().repositories[0]).toMatchObject({
      repository_url: 'https://github.com/acme/app.git',
      branch_name: 'main',
    });
  });

  it('несуществующий repo_id → 422 Repository not found, задача не создана', async () => {
    const { app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: {
        title: 'Нет такого репо',
        repositories: [
          { repo_id: '00000000-0000-4000-8000-000000000000', base_branch: 'main' },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('Repository not found');

    const list = await app.inject({ method: 'GET', url: ROUTE });
    expect(list.json()).toEqual([]);
  });

  it('repo_id с null defaultBranch и без base_branch → 422', async () => {
    const { db, app } = makeApp();
    const broken = seedRepo(db, {
      url: 'https://github.com/acme/broken',
      fullName: 'acme/broken',
      defaultBranch: null,
      connectionStatus: 'error',
    });

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { title: 'Без ветки', repositories: [{ repo_id: broken.id }] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('default branch');
  });

  it('приоритет repo_id над repository_url', async () => {
    const { repo, app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: {
        title: 'Приоритет',
        repositories: [
          {
            repo_id: repo.id,
            repository_url: 'https://github.com/other/thing',
            base_branch: 'dev',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().repositories[0]).toMatchObject({
      repository_url: 'https://github.com/acme/app.git',
      branch_name: 'dev',
    });
  });
});

describe('POST /issues — обратная совместимость repository_url', () => {
  it('repository_url + base_branch работает как раньше', async () => {
    const { app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: {
        title: 'Старый формат',
        repositories: [
          {
            repository_url: 'https://github.com/acme/legacy',
            base_branch: 'main',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().repositories[0]).toMatchObject({
      repository_url: 'https://github.com/acme/legacy',
      branch_name: 'main',
      create_mr: false,
    });
  });

  it('repository_url без base_branch → 400', async () => {
    const { app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: {
        title: 'Нет ветки',
        repositories: [{ repository_url: 'https://github.com/acme/legacy' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('base_branch');
  });

  it('ни repo_id, ни repository_url → 400', async () => {
    const { app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: {
        title: 'Пустой репозиторий',
        repositories: [{ base_branch: 'main' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('repo_id или repository_url');
  });
});