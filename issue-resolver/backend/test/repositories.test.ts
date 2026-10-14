import { afterEach, describe, expect, it } from 'vitest';
import type { RepoInfo, SavedRepo } from '@issue-resolver/shared';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { RepoResolverFactory } from '../src/repo-resolver/resolver';

const ROUTE = '/issue-resolver/api/v1/repositories';

const GITHUB_INFO: RepoInfo = {
  platform: 'github',
  fullName: 'acme/app',
  defaultBranch: 'main',
  branches: ['main'],
  language: 'TypeScript',
  description: 'demo',
  stars: 42,
  isPrivate: false,
  cloneUrl: 'https://github.com/acme/app.git',
  writeAccess: true,
};

const GITHUB_URL = 'https://github.com/acme/app';

interface Controllable {
  factory: RepoResolverFactory;
  calls: string[];
  setInfo(info: RepoInfo): void;
  failNextWith(err: Error): void;
}

/** Управляемая фабрика резолверов: смена метаданных/разовая ошибка. */
function controllable(initial: RepoInfo = GITHUB_INFO): Controllable {
  let info = initial;
  let pending: Error | null = null;
  const calls: string[] = [];
  return {
    calls,
    setInfo: (next) => {
      info = next;
    },
    failNextWith: (err) => {
      pending = err;
    },
    factory: () => ({
      resolve: async (url: string) => {
        calls.push(url);
        if (pending) {
          const err = pending;
          pending = null;
          throw err;
        }
        return info;
      },
    }),
  };
}

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(factory: RepoResolverFactory = controllable().factory) {
  const app = buildApp(createDb(':memory:'), { repoResolverFactory: factory });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function createRepo(
  app: ReturnType<typeof buildApp>,
  url = GITHUB_URL,
): Promise<SavedRepo> {
  const response = await app.inject({
    method: 'POST',
    url: ROUTE,
    payload: { url },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe('POST /repositories', () => {
  it('валидный URL → 201 с метаданными и status ok', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { url: GITHUB_URL },
    });

    expect(response.statusCode).toBe(201);
    const repo = response.json() as SavedRepo;
    expect(repo).toMatchObject({
      url: GITHUB_URL,
      platform: 'github',
      fullName: 'acme/app',
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/acme/app.git',
      language: 'TypeScript',
      description: 'demo',
      isPrivate: false,
      connectionStatus: 'ok',
      runInstructions: null,
      runInstructionsStatus: 'unknown',
      writeAccess: true,
    });
    expect(repo.id).toEqual(expect.any(String));
    expect(repo.createdAt).toEqual(expect.any(String));
    expect(fake.calls).toEqual([GITHUB_URL]);
  });

  it('writeAccess резолвера сохраняется в БД (false)', async () => {
    const fake = controllable();
    fake.setInfo({ ...GITHUB_INFO, writeAccess: false });
    const app = makeApp(fake.factory);

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { url: GITHUB_URL },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      url: GITHUB_URL,
      connectionStatus: 'ok',
      writeAccess: false,
    });

    // Значение не теряется при чтении списка.
    const list = await app.inject({ method: 'GET', url: ROUTE });
    expect(list.json()[0].writeAccess).toBe(false);
  });

  it('невалидный URL-строка → 400 без сохранения', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { url: 'not a url' },
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');

    const list = await app.inject({ method: 'GET', url: ROUTE });
    expect(list.json()).toEqual([]);
  });

  it('платформа не определена (hostless URL) → 422, репо сохранён с status error', async () => {
    const app = makeApp();
    // `file:///...` проходит z.string().url(), но у него нет хоста →
    // detectPlatform → 'unknown' → 'Unsupported platform'.
    const url = 'file:///tmp/repo';

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { url },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe('Unsupported platform');
    expect(body.repository).toMatchObject({
      url,
      platform: null,
      fullName: null,
      connectionStatus: 'error',
      runInstructionsStatus: 'unknown',
      writeAccess: false,
    });

    const list = await app.inject({ method: 'GET', url: ROUTE });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].connectionStatus).toBe('error');
  });

  it('резолвер падает (404) → 422, репо сохранён с status error', async () => {
    const fake = controllable();
    fake.failNextWith(new Error('Repository not found'));
    const app = makeApp(fake.factory);

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { url: GITHUB_URL },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('Repository not found');
    expect(response.json().repository.connectionStatus).toBe('error');
  });
});

describe('GET /repositories', () => {
  it('возвращает все сохранённые в порядке добавления', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);
    const first = await createRepo(app, 'https://github.com/acme/one');
    const second = await createRepo(app, 'https://github.com/acme/two');

    const response = await app.inject({ method: 'GET', url: ROUTE });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((repo: SavedRepo) => repo.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
});

describe('PUT /repositories/:id', () => {
  it('меняет URL и перевалидирует', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);
    const created = await createRepo(app);
    fake.setInfo({
      ...GITHUB_INFO,
      fullName: 'acme/renamed',
      defaultBranch: 'develop',
      branches: ['develop'],
    });

    const response = await app.inject({
      method: 'PUT',
      url: `${ROUTE}/${created.id}`,
      payload: { url: 'https://github.com/acme/renamed' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      url: 'https://github.com/acme/renamed',
      fullName: 'acme/renamed',
      defaultBranch: 'develop',
      connectionStatus: 'ok',
      writeAccess: true,
    });
  });

  it('PUT перевалидирует и обновляет writeAccess', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);
    const created = await createRepo(app);
    fake.setInfo({ ...GITHUB_INFO, writeAccess: false });

    const response = await app.inject({
      method: 'PUT',
      url: `${ROUTE}/${created.id}`,
      payload: { url: GITHUB_URL },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      connectionStatus: 'ok',
      writeAccess: false,
    });
  });

  it('сбой перевалидации → 422, метаданные сброшены', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);
    const created = await createRepo(app);
    fake.failNextWith(new Error('Access denied'));

    const response = await app.inject({
      method: 'PUT',
      url: `${ROUTE}/${created.id}`,
      payload: { url: 'https://github.com/acme/private' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().repository).toMatchObject({
      url: 'https://github.com/acme/private',
      fullName: null,
      connectionStatus: 'error',
    });
  });

  it('неизвестный id → 404', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: `${ROUTE}/nope`,
      payload: { url: GITHUB_URL },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /repositories/:id', () => {
  it('удаляет и возвращает 204, повтор → 404', async () => {
    const app = makeApp();
    const created = await createRepo(app);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${ROUTE}/${created.id}`,
    });
    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: ROUTE });
    expect(list.json()).toEqual([]);

    const again = await app.inject({
      method: 'DELETE',
      url: `${ROUTE}/${created.id}`,
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('POST /repositories/:id/validate', () => {
  it('перевалидирует: ok → error → ok, метаданные восстанавливаются', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);
    const created = await createRepo(app);

    fake.failNextWith(new Error('Repository not found'));
    const failed = await app.inject({
      method: 'POST',
      url: `${ROUTE}/${created.id}/validate`,
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({
      id: created.id,
      connectionStatus: 'error',
      fullName: null,
    });

    const ok = await app.inject({
      method: 'POST',
      url: `${ROUTE}/${created.id}/validate`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: created.id,
      connectionStatus: 'ok',
      fullName: 'acme/app',
    });
  });

  it('неизвестный id → 404', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: `${ROUTE}/nope/validate`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /repositories/:id/branches', () => {
  it('отдаёт ветки live (не из кеша)', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);
    const created = await createRepo(app);
    expect(created.connectionStatus).toBe('ok');

    fake.setInfo({ ...GITHUB_INFO, branches: ['main', 'feature/new'] });

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE}/${created.id}/branches`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branches: ['main', 'feature/new'] });
    // Резолвер вызван заново, а не отдан кеш создания.
    expect(fake.calls).toEqual([GITHUB_URL, GITHUB_URL]);
  });

  it('резолвер недоступен → 502', async () => {
    const fake = controllable();
    const app = makeApp(fake.factory);
    const created = await createRepo(app);
    fake.failNextWith(new Error('Access denied'));

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE}/${created.id}/branches`,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('Access denied');
  });

  it('неизвестный id → 404', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE}/nope/branches`,
    });
    expect(response.statusCode).toBe(404);
  });
});