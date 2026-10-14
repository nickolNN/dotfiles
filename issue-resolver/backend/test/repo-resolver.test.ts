import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepoInfo } from '@issue-resolver/shared';
import {
  BitbucketCloudResolver,
  BitbucketResolver,
  detectPlatform,
  FakeRepoResolver,
  GitLabResolver,
  GitHubResolver,
  createRepoResolver,
  type RepoResolverFactory,
} from '../src/repo-resolver/resolver';
import { validateRepos } from '../src/repo-resolver/validate';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectPlatform', () => {
  it('github.com → github', () => {
    expect(detectPlatform('https://github.com/acme/app.git')).toBe('github');
  });

  it('gitlab.com → gitlab', () => {
    expect(detectPlatform('https://gitlab.com/acme/app.git')).toBe('gitlab');
  });

  it('ssh-стиль распознаётся по хосту', () => {
    expect(detectPlatform('git@github.com:acme/app.git')).toBe('github');
    expect(detectPlatform('git@gitlab.com:acme/app.git')).toBe('gitlab');
  });

  it('самохостящийся gitlab → gitlab', () => {
    expect(detectPlatform('https://gitlab.example.com/group/app')).toBe(
      'gitlab',
    );
  });

  it('bitbucket.org и self-hosted → bitbucket', () => {
    expect(detectPlatform('https://bitbucket.org/acme/app')).toBe('bitbucket');
    expect(
      detectPlatform('https://bitbucket.company.com/scm/proj/app.git'),
    ).toBe('bitbucket');
  });

  it('stash (бывший Bitbucket Server) → bitbucket', () => {
    expect(detectPlatform('https://stash.internal.ru/scm/proj/app.git')).toBe(
      'bitbucket',
    );
    expect(detectPlatform('git@stash.internal.ru:proj/app.git')).toBe(
      'bitbucket',
    );
  });

  it('неизвестный self-hosted хост → bitbucket, нераспознанный URL → unknown', () => {
    expect(detectPlatform('https://example.com/acme/app.git')).toBe('bitbucket');
    expect(detectPlatform('not a url')).toBe('unknown');
  });

  it('ssh-порт 7999 (Bitbucket Server) → bitbucket', () => {
    expect(detectPlatform('ssh://git@git.example.com:7999/proj/app.git')).toBe(
      'bitbucket',
    );
  });
});

describe('GitHubResolver', () => {
  it('маппит поля ответа и шлёт токен/заголовки', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          full_name: 'acme/app',
          default_branch: 'main',
          language: 'TypeScript',
          description: 'demo',
          stargazers_count: 42,
          private: false,
          clone_url: 'https://github.com/acme/app.git',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ name: 'main' }, { name: 'develop' }]));
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new GitHubResolver('secret');
    const info = await resolver.resolve('https://github.com/acme/app.git');

    expect(info).toEqual({
      ...GITHUB_INFO,
      branches: ['main', 'develop'],
      // В моке нет permissions → право на запись не подтверждено.
      writeAccess: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/app',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'User-Agent': 'issue-resolver',
          Authorization: 'Bearer secret',
        }),
      }),
    );
  });

  it('без токена не шлёт Authorization', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          full_name: 'acme/app',
          default_branch: 'main',
          language: 'TypeScript',
          description: 'demo',
          stargazers_count: 42,
          private: false,
          clone_url: 'https://github.com/acme/app.git',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetchMock);

    await new GitHubResolver().resolve('https://github.com/acme/app');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('404 → "Repository not found"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404)),
    );

    await expect(
      new GitHubResolver().resolve('https://github.com/acme/app'),
    ).rejects.toThrow('Repository not found');
  });

  it('403 → "Access denied"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Forbidden' }, 403)),
    );

    await expect(
      new GitHubResolver().resolve('https://github.com/acme/app'),
    ).rejects.toThrow('Access denied');
  });

  it('permissions.push → writeAccess:true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          full_name: 'acme/app',
          default_branch: 'main',
          language: null,
          description: null,
          stargazers_count: 0,
          private: true,
          clone_url: 'https://github.com/acme/app.git',
          permissions: { push: true },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetchMock);

    const info = await new GitHubResolver('secret').resolve(
      'https://github.com/acme/app',
    );

    expect(info.writeAccess).toBe(true);
  });

  it('без permissions.push → writeAccess:false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          full_name: 'acme/app',
          default_branch: 'main',
          language: null,
          description: null,
          stargazers_count: 0,
          private: false,
          clone_url: 'https://github.com/acme/app.git',
          permissions: { push: false },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetchMock);

    const info = await new GitHubResolver('secret').resolve(
      'https://github.com/acme/app',
    );

    expect(info.writeAccess).toBe(false);
  });
});

describe('GitLabResolver', () => {
  it('маппит поля, шлёт PRIVATE-TOKEN и кодирует путь', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        path_with_namespace: 'group/sub/project',
        default_branch: 'master',
        language: 'Go',
        description: null,
        star_count: 7,
        visibility: 'private',
        http_url_to_repo: 'https://gitlab.com/group/sub/project.git',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new GitLabResolver('glpat', 'gitlab.com');
    const info = await resolver.resolve(
      'https://gitlab.com/group/sub/project.git',
    );

    expect(info).toEqual({
      platform: 'gitlab',
      fullName: 'group/sub/project',
      defaultBranch: 'master',
      branches: ['master'],
      language: 'Go',
      description: null,
      stars: 7,
      isPrivate: true,
      cloneUrl: 'https://gitlab.com/group/sub/project.git',
      writeAccess: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject',
      expect.objectContaining({
        headers: { 'PRIVATE-TOKEN': 'glpat' },
      }),
    );
  });

  it('self-hosted host подставляется в URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path_with_namespace: 'g/p' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetchMock);

    await new GitLabResolver('', 'gitlab.example.com').resolve(
      'https://gitlab.example.com/g/p.git',
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fp',
    );
  });

  it('404 → "Repository not found"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: '404' }, 404)),
    );

    await expect(
      new GitLabResolver().resolve('https://gitlab.com/g/p'),
    ).rejects.toThrow('Repository not found');
  });

  it('project_access.access_level 30 → writeAccess:true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          path_with_namespace: 'g/p',
          default_branch: 'main',
          language: null,
          description: null,
          star_count: 0,
          visibility: 'private',
          http_url_to_repo: 'https://gitlab.com/g/p.git',
          permissions: { project_access: { access_level: 30 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetchMock);

    const info = await new GitLabResolver('glpat').resolve(
      'https://gitlab.com/g/p',
    );

    expect(info.writeAccess).toBe(true);
  });

  it('project_access.access_level 20 (Reporter) → writeAccess:false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          path_with_namespace: 'g/p',
          default_branch: 'main',
          language: null,
          description: null,
          star_count: 0,
          visibility: 'private',
          http_url_to_repo: 'https://gitlab.com/g/p.git',
          permissions: { project_access: { access_level: 20 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetchMock);

    const info = await new GitLabResolver('glpat').resolve(
      'https://gitlab.com/g/p',
    );

    expect(info.writeAccess).toBe(false);
  });
});

describe('BitbucketResolver', () => {
  const REPO_BODY = {
    slug: 'repo',
    name: 'repo',
    project: { key: 'PROJECT', name: 'Project Name' },
    description: 'desc',
    public: false,
    links: {
      clone: [
        {
          name: 'http',
          href: 'https://bitbucket.company.com/scm/project/repo.git',
        },
        { name: 'ssh', href: 'ssh://git@bitbucket.company.com/project/repo.git' },
      ],
    },
  };

  function mockBitbucket(): ReturnType<typeof vi.fn> {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(REPO_BODY))
      .mockResolvedValueOnce(jsonResponse({ displayId: 'develop' }))
      .mockResolvedValueOnce(
        jsonResponse({ values: [{ displayId: 'develop' }, { displayId: 'main' }] }),
      )
      // POST /branches — тестовая ветка создана.
      .mockResolvedValueOnce(
        jsonResponse({ displayId: '_pi_write_test', id: 'refs/heads/_pi_write_test' }),
      )
      // DELETE /branches — уборка.
      .mockResolvedValueOnce(jsonResponse({}, 200));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('scm-формат: маппит поля и ходит в REST API 1.0', async () => {
    const fetchMock = mockBitbucket();

    const info = await new BitbucketResolver(
      'pat',
      'bitbucket.company.com',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(info).toEqual({
      platform: 'bitbucket',
      fullName: 'PROJECT/repo',
      defaultBranch: 'develop',
      branches: ['develop', 'main'],
      language: null,
      description: 'desc',
      stars: 0,
      isPrivate: true,
      cloneUrl: 'https://bitbucket.company.com/scm/project/repo.git',
      writeAccess: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://bitbucket.company.com/rest/api/1.0/projects/project/repos/repo',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://bitbucket.company.com/rest/api/1.0/projects/project/repos/repo/branches/default',
    );
    expect(fetchMock.mock.calls[0][1]).toEqual({
      headers: { Authorization: 'Bearer pat' },
    });
    // Пробная ветка создаётся от default-ветки и удаляется; username не нужен.
    expect(fetchMock.mock.calls[3][0]).toBe(
      'https://bitbucket.company.com/rest/api/1.0/projects/project/repos/repo/branches',
    );
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer pat',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({
      name: expect.stringContaining('_pi_write_test_'),
      startPoint: 'refs/heads/develop',
    });
    expect(fetchMock.mock.calls[4][1]).toMatchObject({ method: 'DELETE' });
  });

  it('projects-формат (browse) распознаётся', async () => {
    const fetchMock = mockBitbucket();

    await new BitbucketResolver('pat', 'bitbucket.company.com').resolve(
      'https://bitbucket.company.com/projects/PROJECT/repos/repo/browse',
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://bitbucket.company.com/rest/api/1.0/projects/PROJECT/repos/repo',
    );
  });

  it('basic auth при username/password без токена', async () => {
    const fetchMock = mockBitbucket();
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;

    const info = await new BitbucketResolver(
      '',
      'bitbucket.company.com',
      'user',
      'pass',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(fetchMock.mock.calls[0][1]).toEqual({
      headers: { Authorization: expected },
    });
    // Пробная ветка создаётся/удаляется тем же Basic-токеном, без username.
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[4][1]).toMatchObject({ method: 'DELETE' });
    expect(info.writeAccess).toBe(true);
  });

  it('без креденшелов не шлёт Authorization', async () => {
    const fetchMock = mockBitbucket();

    await new BitbucketResolver(
      '',
      'bitbucket.company.com',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: {} });
  });

  it('404 → "Repository not found"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ errors: [] }, 404)),
    );

    await expect(
      new BitbucketResolver('pat', 'bitbucket.company.com').resolve(
        'https://bitbucket.company.com/scm/project/repo.git',
      ),
    ).rejects.toThrow('Repository not found');
  });

  it('URL с одним сегментом → понятная ошибка парсинга', async () => {
    await expect(
      new BitbucketResolver('pat', 'bitbucket.company.com').resolve(
        'https://bitbucket.company.com/foo',
      ),
    ).rejects.toThrow('cannot parse bitbucket repository');
  });

  it('branch-create 403 → writeAccess:false (DELETE не шлётся)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(REPO_BODY))
      .mockResolvedValueOnce(jsonResponse({ displayId: 'main' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ displayId: 'main' }] }))
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'forbidden' }] }, 403),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await new BitbucketResolver(
      'pat',
      'bitbucket.company.com',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(info.writeAccess).toBe(false);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'POST' });
    // 4 вызова: metadata, default-branch, branches, неудачный POST — DELETE нет.
    expect(fetchMock.mock.calls).toHaveLength(4);
  });

  it('branch-create 401 → writeAccess:false (DELETE не шлётся)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(REPO_BODY))
      .mockResolvedValueOnce(jsonResponse({ displayId: 'main' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ displayId: 'main' }] }))
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'unauthorized' }] }, 401),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await new BitbucketResolver(
      'pat',
      'bitbucket.company.com',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(info.writeAccess).toBe(false);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'POST' });
    // 4 вызова: metadata, default-branch, branches, неудачный POST — DELETE нет.
    expect(fetchMock.mock.calls).toHaveLength(4);
  });

  it('branch-create 409 (ветка уже существует) → writeAccess:false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(REPO_BODY))
      .mockResolvedValueOnce(jsonResponse({ displayId: 'main' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ displayId: 'main' }] }))
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'branch already exists' }] }, 409),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await new BitbucketResolver(
      'pat',
      'bitbucket.company.com',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(info.writeAccess).toBe(false);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'POST' });
    // 4 вызова: metadata, default-branch, branches, конфликтный POST — DELETE нет.
    expect(fetchMock.mock.calls).toHaveLength(4);
  });

  it('DELETE упал после успешного POST → всё равно writeAccess:true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(REPO_BODY))
      .mockResolvedValueOnce(jsonResponse({ displayId: 'main' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ displayId: 'main' }] }))
      // POST /branches — тестовая ветка создана, права подтверждены.
      .mockResolvedValueOnce(
        jsonResponse({ displayId: '_pi_write_test', id: 'refs/heads/_pi_write_test' }),
      )
      // DELETE /branches — уборка падает по сети, но это best-effort.
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const info = await new BitbucketResolver(
      'pat',
      'bitbucket.company.com',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(info.writeAccess).toBe(true);
    expect(fetchMock.mock.calls[4][1]).toMatchObject({ method: 'DELETE' });
    expect(fetchMock.mock.calls).toHaveLength(5);
  });

  it('сетевая ошибка при POST (fetch throws) → writeAccess:false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(REPO_BODY))
      .mockResolvedValueOnce(jsonResponse({ displayId: 'main' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ displayId: 'main' }] }))
      // POST /branches — сеть отвалилась до ответа.
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const info = await new BitbucketResolver(
      'pat',
      'bitbucket.company.com',
    ).resolve('https://bitbucket.company.com/scm/project/repo.git');

    expect(info.writeAccess).toBe(false);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'POST' });
    // 4 вызова: metadata, default-branch, branches, упавший POST — DELETE нет.
    expect(fetchMock.mock.calls).toHaveLength(4);
  });

  it('ssh-фолбек: два сегмента без scm/projects → project/repo', async () => {
    const fetchMock = mockBitbucket();

    await new BitbucketResolver('pat', 'bitbucket.company.com').resolve(
      'ssh://git@bitbucket.company.com:7999/proj/app.git',
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://bitbucket.company.com/rest/api/1.0/projects/proj/repos/app',
    );
  });

  it('bitbucket.org → делегирует в Cloud API 2.0', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          full_name: 'atlassian/python-bitbucket',
          mainbranch: { name: 'main' },
          language: 'python',
          description: 'Bitbucket API client',
          is_private: false,
          links: {
            clone: [
              {
                name: 'https',
                href: 'https://bitbucket.org/atlassian/python-bitbucket.git',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ values: [{ name: 'main' }, { name: 'develop' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await new BitbucketResolver('pat', 'bitbucket.org').resolve(
      'https://bitbucket.org/atlassian/python-bitbucket',
    );

    expect(info).toEqual({
      platform: 'bitbucket',
      fullName: 'atlassian/python-bitbucket',
      defaultBranch: 'main',
      branches: ['main', 'develop'],
      language: 'python',
      description: 'Bitbucket API client',
      stars: 0,
      isPrivate: false,
      cloneUrl: 'https://bitbucket.org/atlassian/python-bitbucket.git',
      writeAccess: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/atlassian/python-bitbucket',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/atlassian/python-bitbucket/refs/branches?pagelen=100',
    );
  });
});

describe('BitbucketCloudResolver', () => {
  const CLOUD_REPO_BODY = {
    full_name: 'atlassian/python-bitbucket',
    mainbranch: { name: 'main' },
    language: 'python',
    description: 'Bitbucket API client',
    is_private: false,
    links: {
      html: { href: 'https://bitbucket.org/atlassian/python-bitbucket' },
      clone: [
        {
          name: 'https',
          href: 'https://bitbucket.org/atlassian/python-bitbucket.git',
        },
        {
          name: 'ssh',
          href: 'git@bitbucket.org:atlassian/python-bitbucket.git',
        },
      ],
    },
  };

  function mockCloud(): ReturnType<typeof vi.fn> {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CLOUD_REPO_BODY))
      .mockResolvedValueOnce(
        jsonResponse({ values: [{ name: 'main' }, { name: 'develop' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('маппит поля Cloud-ответа и ходит в API 2.0', async () => {
    const fetchMock = mockCloud();

    const info = await new BitbucketCloudResolver('pat').resolve(
      'https://bitbucket.org/atlassian/python-bitbucket',
    );

    expect(info).toEqual({
      platform: 'bitbucket',
      fullName: 'atlassian/python-bitbucket',
      defaultBranch: 'main',
      branches: ['main', 'develop'],
      language: 'python',
      description: 'Bitbucket API client',
      stars: 0,
      isPrivate: false,
      cloneUrl: 'https://bitbucket.org/atlassian/python-bitbucket.git',
      writeAccess: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/atlassian/python-bitbucket',
    );
    expect(fetchMock.mock.calls[0][1]).toEqual({
      headers: { Authorization: 'Bearer pat' },
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/atlassian/python-bitbucket/refs/branches?pagelen=100',
    );
  });

  it('.git-суффикс и ssh-стиль распознаются', async () => {
    const fetchMock = mockCloud();

    await new BitbucketCloudResolver('pat').resolve(
      'git@bitbucket.org:atlassian/python-bitbucket.git',
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/atlassian/python-bitbucket',
    );
  });

  it('basic auth при username/password без токена', async () => {
    const fetchMock = mockCloud();
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;

    await new BitbucketCloudResolver('', 'user', 'pass').resolve(
      'https://bitbucket.org/atlassian/python-bitbucket',
    );

    expect(fetchMock.mock.calls[0][1]).toEqual({
      headers: { Authorization: expected },
    });
  });

  it('fallback на defaultBranch, если список веток недоступен', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CLOUD_REPO_BODY))
      .mockResolvedValueOnce(jsonResponse({}, 500));
    vi.stubGlobal('fetch', fetchMock);

    const info = await new BitbucketCloudResolver('pat').resolve(
      'https://bitbucket.org/atlassian/python-bitbucket',
    );

    expect(info.branches).toEqual(['main']);
  });

  it('404 → "Repository not found"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 404)),
    );

    await expect(
      new BitbucketCloudResolver('pat').resolve(
        'https://bitbucket.org/atlassian/python-bitbucket',
      ),
    ).rejects.toThrow('Repository not found');
  });

  it('401 → "Access denied"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 401)),
    );

    await expect(
      new BitbucketCloudResolver('pat').resolve(
        'https://bitbucket.org/atlassian/python-bitbucket',
      ),
    ).rejects.toThrow('Access denied');
  });
});

describe('createRepoResolver', () => {
  it('github/gitlab по платформе, токены из env', () => {
    expect(createRepoResolver('https://github.com/a/b', {})).toBeInstanceOf(
      GitHubResolver,
    );
    expect(
      createRepoResolver('https://gitlab.com/a/b', { GITLAB_TOKEN: 't' }),
    ).toBeInstanceOf(GitLabResolver);
  });

  it('нераспознанный URL → throw "Unsupported platform"', () => {
    expect(() => createRepoResolver('not a url', {})).toThrow(
      'Unsupported platform',
    );
  });

  it('неизвестный self-hosted хост → BitbucketResolver', () => {
    expect(createRepoResolver('https://example.com/a/b', {})).toBeInstanceOf(
      BitbucketResolver,
    );
  });

  it('bitbucket по платформе, креды из env', () => {
    expect(
      createRepoResolver('https://bitbucket.company.com/scm/a/b.git', {
        BITBUCKET_TOKEN: 'pat',
      }),
    ).toBeInstanceOf(BitbucketResolver);
  });
});

describe('validateRepos', () => {
  const factory: RepoResolverFactory = () => new FakeRepoResolver(GITHUB_INFO);

  it('смесь валидных/невалидных URL', async () => {
    const results = await validateRepos(
      [
        'https://github.com/acme/app',
        'https://example.com/self/hosted',
        'not a url',
        'https://gitlab.com/group/app',
      ],
      {},
      factory,
    );

    expect(results).toEqual([
      { url: 'https://github.com/acme/app', valid: true, platform: 'github', info: GITHUB_INFO },
      {
        url: 'https://example.com/self/hosted',
        valid: true,
        platform: 'bitbucket',
        info: GITHUB_INFO,
      },
      {
        url: 'not a url',
        valid: false,
        platform: 'unknown',
        error: 'Unsupported platform',
      },
      { url: 'https://gitlab.com/group/app', valid: true, platform: 'gitlab', info: GITHUB_INFO },
    ]);
  });

  it('ошибка резолвера → valid:false с сообщением, не reject', async () => {
    const failing: RepoResolverFactory = () => {
      const resolver = new FakeRepoResolver(GITHUB_INFO);
      resolver.failNextWith(new Error('Repository not found'));
      return resolver;
    };

    const results = await validateRepos(
      ['https://github.com/acme/app'],
      {},
      failing,
    );

    expect(results[0]).toMatchObject({
      url: 'https://github.com/acme/app',
      valid: false,
      platform: 'github',
      error: 'Repository not found',
    });
  });

  it('сетевой throw в fetch не роняет пакет', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );

    const results = await validateRepos(
      ['https://github.com/acme/app'],
      {},
    );

    expect(results[0]).toMatchObject({
      valid: false,
      error: 'network down',
    });
  });

  it('writeAccess прокидывается из резолвера; без поля → false', async () => {
    const allowed = await validateRepos(
      ['https://github.com/acme/app'],
      {},
      () => new FakeRepoResolver({ ...GITHUB_INFO, writeAccess: true }),
    );
    expect(allowed[0].info?.writeAccess).toBe(true);

    const denied = await validateRepos(
      ['https://github.com/acme/app'],
      {},
      () => new FakeRepoResolver({ ...GITHUB_INFO, writeAccess: false }),
    );
    expect(denied[0].info?.writeAccess).toBe(false);

    // Старый/самописный резолвер без поля → false, а не undefined.
    const legacy = await validateRepos(
      ['https://github.com/acme/app'],
      {},
      () => ({
        resolve: async () => {
          const { writeAccess: _omitted, ...rest } = GITHUB_INFO;
          return rest as RepoInfo;
        },
      }),
    );
    expect(legacy[0].info?.writeAccess).toBe(false);
  });
});