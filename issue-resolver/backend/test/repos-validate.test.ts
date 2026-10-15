import { afterEach, describe, expect, it } from 'vitest';
import type { RepoInfo } from '@issue-resolver/shared';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { FakeRepoResolver, type RepoResolver } from '../src/repo-resolver/resolver';
import { createReposValidator } from '../src/repo-resolver/validate';

const ROUTE = '/issue-resolver/api/v1/repos/validate';

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

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(repos = createReposValidator({}, () => new FakeRepoResolver(GITHUB_INFO))) {
  const app = buildApp(createDb(':memory:'), { repos });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('POST /repos/validate', () => {
  it('валидный URL → 200 с метаданными (через Fake-резолвер, inject)', async () => {
    const seen: string[] = [];
    const factory = (url: string): RepoResolver => {
      seen.push(url);
      return new FakeRepoResolver(GITHUB_INFO);
    };
    const app = makeApp(createReposValidator({}, factory));

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { urls: ['https://github.com/acme/app'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        {
          url: 'https://github.com/acme/app',
          valid: true,
          platform: 'github',
          info: GITHUB_INFO,
        },
      ],
    });
    expect(seen).toEqual(['https://github.com/acme/app']);
  });

  it('writeAccess:false из резолвера сохраняется в info результата', async () => {
    const infoFalse: RepoInfo = { ...GITHUB_INFO, writeAccess: false };
    const app = makeApp(
      createReposValidator({}, () => new FakeRepoResolver(infoFalse)),
    );

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { urls: ['https://github.com/acme/app'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].info.writeAccess).toBe(false);
  });

  it('неизвестный self-hosted хост → bitbucket (валидируется)', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { urls: ['https://example.com/a/b'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      valid: true,
      platform: 'bitbucket',
    });
  });

  it('платформа не определяется (hostless URL) → valid:false', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      // `file:///...` проходит z.string().url(), но у него нет хоста →
      // detectPlatform возвращает 'unknown'.
      payload: { urls: ['file:///tmp/repo'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      valid: false,
      platform: 'unknown',
      error: 'Unsupported platform',
    });
  });

  it('пустой массив urls → 400', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { urls: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('не-URL в urls → 400', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { urls: ['not a url'] },
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('более 20 URL → 400', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: {
        urls: Array.from({ length: 21 }, (_, i) => `https://github.com/a/b${i}`),
      },
    });

    expect(response.statusCode).toBe(400);
  });
});