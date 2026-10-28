import { describe, expect, it, vi } from 'vitest';
import {
  FakeMrClient,
  HttpMrClient,
  detectGitHost,
  formatPrPublishErrors,
  type MrClient,
  type MrCreateInput,
  type MrFindInput,
  type MrUpdateInput,
} from '../src/pr/mr';

const input = (overrides: Partial<MrCreateInput> = {}): MrCreateInput => ({
  repositoryUrl: 'git@gitlab.example.com:files-web.git',
  baseBranch: 'main',
  headBranch: 'issue-resolver/abc',
  title: 'Fix EXP-1',
  description: 'Generated MR description',
  token: 'secret-token',
  source: 'gitlab',
  ...overrides,
});

describe('detectGitHost', () => {
  it('https://github.com/org/repo.git → github', () => {
    expect(detectGitHost('https://github.com/org/repo.git')).toBe('github');
  });

  it('https://gitlab.com/g/rep/blob/master/x → gitlab', () => {
    expect(detectGitHost('https://gitlab.com/g/rep/blob/master/x')).toBe('gitlab');
  });

  it('git@github.com:org/repo.git → github', () => {
    expect(detectGitHost('git@github.com:org/repo.git')).toBe('github');
  });

  it('git@gitlab.example.com:files-web.git → gitlab', () => {
    expect(detectGitHost('git@gitlab.example.com:files-web.git')).toBe('gitlab');
  });

  it('https://b.yadro.com/scm/kos/some-repo.git → bitbucket', () => {
    expect(detectGitHost('https://b.yadro.com/scm/kos/some-repo.git')).toBe(
      'bitbucket',
    );
  });

  it('git@bitbucket.org:team/repo.git → bitbucket', () => {
    expect(detectGitHost('git@bitbucket.org:team/repo.git')).toBe('bitbucket');
  });

  it('web-URL PR на self-hosted хосте → bitbucket', () => {
    expect(
      detectGitHost(
        'https://b.yadro.com/projects/KOS/repos/some-repo/pull-requests/218',
      ),
    ).toBe('bitbucket');
    expect(
      detectGitHost(
        'https://b.yadro.com/browse/projects/KOS/repos/some-repo/pull-requests/218/activity',
      ),
    ).toBe('bitbucket');
  });

  it('repositoryUrl + web-URL PR → bitbucket даже без /scm/ в клоне', () => {
    expect(
      detectGitHost(
        'https://b.yadro.com/kos/some-repo.git',
        'https://b.yadro.com/projects/KOS/repos/some-repo/pull-requests/218',
      ),
    ).toBe('bitbucket');
  });

  it('неизвестный хост → throws', () => {
    expect(() => detectGitHost('https://unknown.io/x')).toThrow(
      'unknown git host',
    );
  });
});

describe('FakeMrClient', () => {
  it('createMr → { mrUrl, id } и фиксирует входные поля', async () => {
    const client = new FakeMrClient();

    const result = await client.createMr(input());

    expect(typeof result.mrUrl).toBe('string');
    expect(result.mrUrl.length).toBeGreaterThan(0);
    expect(typeof result.id).toBe('string');
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      title: 'Fix EXP-1',
      description: 'Generated MR description',
      baseBranch: 'main',
      headBranch: 'issue-resolver/abc',
      source: 'gitlab',
      token: 'secret-token',
    });
  });

  it('failNextWith → createMr rejects', async () => {
    const client = new FakeMrClient();
    client.failNextWith(new Error('mr api down'));

    await expect(client.createMr(input())).rejects.toThrow('mr api down');
  });

  it('bitbucket source → URL вида /projects/{project}/repos/{repo}/pull-requests', async () => {
    const client = new FakeMrClient();

    const result = await client.createMr(
      input({
        repositoryUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
        source: 'bitbucket',
      }),
    );

    expect(result.mrUrl).toBe(
      'https://b.yadro.com/projects/kos/repos/some-repo/pull-requests/mr-1',
    );
  });
});

describe('HttpMrClient', () => {
  const authHeaderOfFirstCall = (
    fetchMock: ReturnType<typeof vi.fn>,
  ): string => {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return (init.headers as Record<string, string>).Authorization;
  };

  it('совместим с интерфейсом MrClient (сигнатура компилируется)', () => {
    const client: MrClient = new HttpMrClient();
    expect(typeof client.createMr).toBe('function');
  });

  it('bitbucket: POST в REST API v1 и Bearer-токен', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 42 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new HttpMrClient();

      const result = await client.createMr(
        input({
          repositoryUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
          source: 'bitbucket',
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://b.yadro.com/rest/api/1.0/projects/kos/repos/some-repo/pull-requests',
      );
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer secret-token',
      });
      expect(JSON.parse(String(init.body))).toEqual({
        title: 'Fix EXP-1',
        description: 'Generated MR description',
        fromRef: { id: 'issue-resolver/abc' },
        toRef: { id: 'main' },
      });
      expect(result).toEqual({
        mrUrl:
          'https://b.yadro.com/projects/kos/repos/some-repo/pull-requests/42',
        id: '42',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bitbucket: приоритет input.token > tokens[source] > общий token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 7 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const bitbucketInput = input({
        repositoryUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
        source: 'bitbucket',
      });
      const client = new HttpMrClient('default-token', {
        bitbucket: 'bitbucket-token',
      });

      await client.createMr(bitbucketInput);
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer secret-token');

      fetchMock.mockClear();
      await client.createMr({ ...bitbucketInput, token: '' });
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer bitbucket-token');

      fetchMock.mockClear();
      await new HttpMrClient('default-token').createMr({
        ...bitbucketInput,
        token: '',
      });
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer default-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tokens[source] выбирается по хосту (gitlab-токен не берёт bitbucket)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ iid: 5, web_url: 'https://gitlab/mr/5' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new HttpMrClient('', {
        bitbucket: 'bitbucket-token',
        gitlab: 'gitlab-token',
      });

      await client.createMr(input({ token: '', source: 'gitlab' }));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe(
        'gitlab-token',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bitbucket: не-ok ответ → throws с кодом и телом ответа', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Token expired',
      }),
    );
    try {
      const client = new HttpMrClient();

      await expect(
        client.createMr(
          input({
            repositoryUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
            source: 'bitbucket',
          }),
        ),
      ).rejects.toThrow(
        'bitbucket pr failed: 401 — POST /rest/api/1.0/projects/kos/repos/some-repo/pull-requests — Token expired',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('github: POST на api.github.com, заголовки и тело PR', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        number: 42,
        html_url: 'https://github.com/acme/app/pull/42',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new HttpMrClient();

      const result = await client.createMr(
        input({
          repositoryUrl: 'https://github.com/acme/app.git',
          source: 'github',
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/repos/acme/app/pulls');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer secret-token',
        Accept: 'application/vnd.github+json',
      });
      expect(JSON.parse(String(init.body))).toEqual({
        head: 'issue-resolver/abc',
        base: 'main',
        title: 'Fix EXP-1',
        body: 'Generated MR description',
      });
      expect(result).toEqual({
        mrUrl: 'https://github.com/acme/app/pull/42',
        id: '42',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('github enterprise: URL содержит /api/v3/ вместо api.github.com', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        number: 7,
        html_url: 'https://git.company.com/acme/app/pull/7',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new HttpMrClient();

      await client.createMr(
        input({
          repositoryUrl: 'https://git.company.com/acme/app.git',
          source: 'github',
        }),
      );

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://git.company.com/api/v3/repos/acme/app/pulls');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('github: приоритет input.token > tokens[source] > общий token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        number: 1,
        html_url: 'https://github.com/acme/app/pull/1',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const githubInput = input({
        repositoryUrl: 'https://github.com/acme/app.git',
        source: 'github',
      });
      const client = new HttpMrClient('default-token', {
        github: 'github-token',
      });

      await client.createMr(githubInput);
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer secret-token');

      fetchMock.mockClear();
      await client.createMr({ ...githubInput, token: '' });
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer github-token');

      fetchMock.mockClear();
      await new HttpMrClient('default-token').createMr({
        ...githubInput,
        token: '',
      });
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer default-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('github: не-ok ответ → throws с кодом', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => 'Validation Failed',
      }),
    );
    try {
      const client = new HttpMrClient();

      await expect(
        client.createMr(
          input({
            repositoryUrl: 'https://github.com/acme/app.git',
            source: 'github',
          }),
        ),
      ).rejects.toThrow(
        /github pr failed: 422 — POST \/repos\/acme\/app\/pulls — Validation Failed/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('сетевая ошибка createMr → rejects (причина дойдёт до шага как pr_error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    try {
      const client = new HttpMrClient();

      await expect(
        client.createMr(
          input({
            repositoryUrl: 'https://github.com/acme/app.git',
            source: 'github',
          }),
        ),
      ).rejects.toThrow('ECONNREFUSED');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('formatPrPublishErrors', () => {
  it('пустой список ошибок → пустая строка', () => {
    expect(formatPrPublishErrors([])).toBe('');
  });

  it('склеивает причины по репозиториям через "; "', () => {
    const message = formatPrPublishErrors([
      {
        repositoryUrl: 'https://github.com/acme/app.git',
        message:
          'https://github.com/acme/app.git — commit/push: push rejected',
      },
      {
        repositoryUrl: 'git@gitlab.example.com:team/lib.git',
        message: 'git@gitlab.example.com:team/lib.git — MR: pr failed: 403',
      },
    ]);

    expect(message).toBe(
      'https://github.com/acme/app.git — commit/push: push rejected; ' +
        'git@gitlab.example.com:team/lib.git — MR: pr failed: 403',
    );
  });
});

describe('FakeMrClient GitHub URLs', () => {
  it('github source → URL /pull/ формата', async () => {
    const client = new FakeMrClient();

    const result = await client.createMr(
      input({
        repositoryUrl: 'https://github.com/acme/app.git',
        source: 'github',
      }),
    );

    expect(result.mrUrl).toBe('https://github.com/acme/app/pull/mr-1');
    expect(result.id).toBe('mr-1');
  });

  it('github enterprise → правильный хост в URL', async () => {
    const client = new FakeMrClient();

    const result = await client.createMr(
      input({
        repositoryUrl: 'https://git.company.com/acme/app.git',
        source: 'github',
      }),
    );

    expect(result.mrUrl).toBe('https://git.company.com/acme/app/pull/mr-1');
    expect(result.id).toBe('mr-1');
  });
});

describe('findOpenMr', () => {
  const findInput = (overrides: Partial<MrFindInput> = {}): MrFindInput => ({
    repositoryUrl: 'https://github.com/acme/app.git',
    headBranch: 'feature/fix-bug-abc123',
    baseBranch: 'main',
    token: 'secret-token',
    source: 'github',
    ...overrides,
  });

  describe('FakeMrClient', () => {
    it('openMrs пуст → null', async () => {
      const client = new FakeMrClient();
      const result = await client.findOpenMr(findInput());
      expect(result).toBeNull();
    });

    it('совпадение по repositoryUrl + headBranch + baseBranch → mrUrl', async () => {
      const client = new FakeMrClient();
      client.openMrs = [
        {
          repositoryUrl: 'https://github.com/acme/app.git',
          headBranch: 'feature/fix-bug-abc123',
          baseBranch: 'main',
          mrUrl: 'https://github.com/acme/app/pull/42',
        },
      ];
      const result = await client.findOpenMr(findInput());
      expect(result).toEqual({
        mrUrl: 'https://github.com/acme/app/pull/42',
        id: 'https://github.com/acme/app/pull/42',
      });
    });

    it('несовпадение headBranch → null', async () => {
      const client = new FakeMrClient();
      client.openMrs = [
        {
          repositoryUrl: 'https://github.com/acme/app.git',
          headBranch: 'feature/other-branch',
          baseBranch: 'main',
          mrUrl: 'https://github.com/acme/app/pull/42',
        },
      ];
      const result = await client.findOpenMr(findInput());
      expect(result).toBeNull();
    });

    it('несовпадение baseBranch → null', async () => {
      const client = new FakeMrClient();
      client.openMrs = [
        {
          repositoryUrl: 'https://github.com/acme/app.git',
          headBranch: 'feature/fix-bug-abc123',
          baseBranch: 'develop',
          mrUrl: 'https://github.com/acme/app/pull/42',
        },
      ];
      const result = await client.findOpenMr(findInput());
      expect(result).toBeNull();
    });
  });

  describe('HttpMrClient — GitHub', () => {
    it('находит открытый PR по head + base → возвращает URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { number: 42, html_url: 'https://github.com/acme/app/pull/42' },
        ],
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new HttpMrClient();
        const result = await client.findOpenMr(findInput());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toContain(
          'head=acme%3Afeature%2Ffix-bug-abc123',
        );
        expect(url).toContain('base=main');
        expect(url).toContain('state=open');
        expect(result).toEqual({
          mrUrl: 'https://github.com/acme/app/pull/42',
          id: '42',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('нет открытых PR → null', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new HttpMrClient();
        const result = await client.findOpenMr(findInput());
        expect(result).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('ошибка API → null (не роняем)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new HttpMrClient();
        const result = await client.findOpenMr(findInput());
        expect(result).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('HttpMrClient — GitLab', () => {
    it('находит открытый MR → возвращает URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { iid: 7, web_url: 'https://gitlab.example.com/team/lib/-/merge_requests/7' },
        ],
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new HttpMrClient();
        const result = await client.findOpenMr(
          findInput({
            repositoryUrl: 'git@gitlab.example.com:team/lib.git',
            source: 'gitlab',
          }),
        );

        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toContain('source_branch=feature%2Ffix-bug-abc123');
        expect(url).toContain('target_branch=main');
        expect(url).toContain('state=opened');
        expect(result).toEqual({
          mrUrl: 'https://gitlab.example.com/team/lib/-/merge_requests/7',
          id: '7',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('HttpMrClient — Bitbucket', () => {
    it('находит открытый PR по source-ветке → возвращает URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          values: [
            {
              id: 99,
              fromRef: { id: 'refs/heads/feature/fix-bug-abc123' },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new HttpMrClient();
        const result = await client.findOpenMr(
          findInput({
            repositoryUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
            headBranch: 'feature/fix-bug-abc123',
            baseBranch: 'main',
            source: 'bitbucket',
          }),
        );

        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toContain('direction=OUTGOING');
        expect(url).toContain('at=refs/heads/main');
        expect(url).toContain('state=OPEN');
        expect(result).toEqual({
          mrUrl: 'https://b.yadro.com/projects/kos/repos/some-repo/pull-requests/99',
          id: '99',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('PR есть, но fromRef не совпадает → null', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          values: [
            {
              id: 99,
              fromRef: { id: 'refs/heads/feature/other-branch' },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new HttpMrClient();
        const result = await client.findOpenMr(
          findInput({
            repositoryUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
            headBranch: 'feature/fix-bug-abc123',
            baseBranch: 'main',
            source: 'bitbucket',
          }),
        );
        expect(result).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe('HttpMrClient.fetchComments — bitbucket', () => {
  const repositoryUrl = 'https://b.yadro.com/scm/kos/kc_docs_editor_front.git';
  const canonicalUrl =
    'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218';
  const activitiesBody = {
    values: [
      {
        action: 'COMMENT',
        commentAction: 'ADDED',
        comment: {
          text: 'Зачем тут Eager?',
          author: { name: 'Artem Gusev' },
          createdDate: 1761040800000,
          anchors: { line: { path: 'src/app.ts', line: 12, lineTgt: 12 } },
        },
      },
      {
        action: 'COMMENT',
        commentAction: 'ADDED',
        comment: {
          text: 'Общий комментарий',
          author: { name: 'Nickol' },
          createdDate: '2026-10-20T10:00:00+0000',
        },
      },
      { action: 'UPDATED', comment: { text: 'не комментарий' } },
      {
        action: 'COMMENT',
        commentAction: 'ADDED',
        comment: { text: 'черновик', pending: true },
      },
      {
        action: 'COMMENT',
        commentAction: 'DELETED',
        comment: { text: 'удалённый' },
      },
    ],
    isLastPage: true,
  };

  const singlePageFetch = (body: unknown = activitiesBody) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  const fetchComments = (mrUrl: string, withRepo = true) =>
    new HttpMrClient().fetchComments({
      mrUrl,
      token: 'secret-token',
      ...(withRepo ? { repositoryUrl } : {}),
    });

  const firstUrl = (fetchMock: ReturnType<typeof vi.fn>) =>
    (fetchMock.mock.calls[0] as [string])[0];

  it('canonical-ссылка → GET /activities, комментарии мапятся', async () => {
    const fetchMock = singlePageFetch();
    try {
      const comments = await fetchComments(canonicalUrl);
      expect(firstUrl(fetchMock)).toBe(
        'https://b.yadro.com/rest/api/1.0/projects/KOS/repos/kc_docs_editor_front/pull-requests/218/activities?limit=500&start=0',
      );
      expect(comments).toEqual([
        {
          file: 'src/app.ts',
          line: 12,
          body: 'Зачем тут Eager?',
          author: 'Artem Gusev',
          created_at: new Date(1761040800000).toISOString(),
        },
        {
          file: null,
          line: null,
          body: 'Общий комментарий',
          author: 'Nickol',
          created_at: '2026-10-20T10:00:00+0000',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('черновики, удалённые и не-comment события отфильтрованы', async () => {
    singlePageFetch();
    try {
      const comments = await fetchComments(canonicalUrl);
      expect(comments.map((c) => c.body)).toEqual([
        'Зачем тут Eager?',
        'Общий комментарий',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('строка lineTgt используется, когда line нет', async () => {
    singlePageFetch({
      values: [
        {
          action: 'COMMENT',
          comment: {
            text: 'x',
            anchors: { line: { path: 'a.ts', lineTgt: 7 } },
          },
        },
      ],
      isLastPage: true,
    });
    try {
      const comments = await fetchComments(canonicalUrl);
      expect(comments[0]).toMatchObject({ file: 'a.ts', line: 7 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('плоский anchor и поля на верхнем уровне события тоже мапятся', async () => {
    singlePageFetch({
      values: [
        {
          action: 'COMMENT',
          commentAction: 'ADDED',
          text: 'поля прямо в событии',
          author: { name: 'Ann' },
          createdDate: 1761040800000,
          anchor: { path: 'src/b.ts', lineSrc: 4 },
        },
        {
          action: 'COMMENT',
          comment: {
            text: 'вложенный',
            author: { name: 'Bob' },
            anchors: { line: { path: 'src/c.ts', lineTgt: 9 } },
          },
        },
      ],
      isLastPage: true,
    });
    try {
      const comments = await fetchComments(canonicalUrl);
      expect(comments).toEqual([
        {
          file: 'src/b.ts',
          line: 4,
          body: 'поля прямо в событии',
          author: 'Ann',
          created_at: new Date(1761040800000).toISOString(),
        },
        {
          file: 'src/c.ts',
          line: 9,
          body: 'вложенный',
          author: 'Bob',
          created_at: '',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('черновик в верхнем уровне (`pending: true`) пропускается', async () => {
    singlePageFetch({
      values: [{ action: 'COMMENT', text: 'x', pending: true }],
      isLastPage: true,
    });
    try {
      expect(await fetchComments(canonicalUrl)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('форма /browse/... и хвост /activity тоже разбираются', async () => {
    const fetchMock = singlePageFetch();
    try {
      await fetchComments(
        'https://b.yadro.com/browse/projects/KOS/repos/kc_docs_editor_front/pull-requests/218/activity#comments',
      );
      expect(firstUrl(fetchMock)).toContain(
        '/rest/api/1.0/projects/KOS/repos/kc_docs_editor_front/pull-requests/218/activities',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('битая ссылка без project-ключа долечивается по repositoryUrl', async () => {
    const fetchMock = singlePageFetch();
    try {
      await fetchComments(
        'https://b.yadro.com/projects/repos/kc_docs_editor_front/pull-requests/218',
      );
      expect(firstUrl(fetchMock)).toContain(
        '/rest/api/1.0/projects/kos/repos/kc_docs_editor_front/pull-requests/218/activities',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('битая ссылка без repositoryUrl не чинится молча', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
    );
    try {
      await expect(
        fetchComments('https://b.yadro.com/pull-requests/218', false),
      ).rejects.toThrow(/unknown git host|cannot parse bitbucket pr url/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('страницы обходятся до isLastPage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          values: [
            { action: 'COMMENT', comment: { text: 'первый' } },
            { action: 'COMMENT', comment: { text: 'второй' } },
          ],
          isLastPage: false,
          nextPageStart: 2,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          values: [{ action: 'COMMENT', comment: { text: 'третий' } }],
          isLastPage: true,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const comments = await fetchComments(canonicalUrl);
      expect(comments.map((c) => c.body)).toEqual(['первый', 'второй', 'третий']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1] as [string])[0]).toContain('start=2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('не-ok → в ошибке виден REST-путь', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
    );
    try {
      await expect(
        fetchComments(
          'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/999',
        ),
      ).rejects.toThrow(
        'bitbucket comments failed: 404 — GET /rest/api/1.0/projects/KOS/repos/kc_docs_editor_front/pull-requests/999/activities?limit=500&start=0',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HttpMrClient — web-URL созданного/дубликата PR', () => {
  const createInput = (overrides: Partial<MrCreateInput> = {}) =>
    input({
      repositoryUrl: 'https://b.yadro.com/scm/kos/kc_docs_editor_front.git',
      headBranch: 'feature/changes-182dd3',
      baseBranch: 'dev',
      source: 'bitbucket',
      ...overrides,
    });

  it('ссылка берётся из links.self ответа сервера', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          id: 218,
          links: {
            self: [
              {
                href: 'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218',
              },
            ],
          },
        }),
      }),
    );
    try {
      const result = await new HttpMrClient().createMr(createInput());
      expect(result.mrUrl).toBe(
        'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218',
      );
      expect(result.id).toBe('218');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('409 duplicate → существующий PR, а не ссылка без project-ключа', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () =>
          '{"errors":[],"existingPullRequest":{"id":218}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          values: [
            {
              id: 220,
              fromRef: { id: 'refs/heads/someone-elses-branch' },
            },
            {
              id: 218,
              fromRef: { id: 'refs/heads/feature/changes-182dd3' },
              links: {
                self: [
                  {
                    href: 'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218',
                  },
                ],
              },
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await new HttpMrClient().createMr(createInput());
      expect(result).toEqual({
        mrUrl: 'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218',
        id: '218',
      });
      expect((fetchMock.mock.calls[1] as [string])[0]).toContain(
        'pull-requests?direction=OUTGOING&at=refs/heads/dev',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('409 и пустой список → id из тела ошибки дочитывается через REST', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => '{"existingPullRequest":{"id":218}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 218,
          links: {
            self: [
              {
                href: 'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218',
              },
            ],
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await new HttpMrClient().createMr(createInput());
      expect(result.mrUrl).toBe(
        'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218',
      );
      expect((fetchMock.mock.calls[2] as [string])[0]).toBe(
        'https://b.yadro.com/rest/api/1.0/projects/kos/repos/kc_docs_editor_front/pull-requests/218',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('409 без опознаваемых признаков → исходная ошибка не теряется', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          text: async () => 'Version conflict',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ values: [] }),
        }),
    );
    try {
      await expect(new HttpMrClient().createMr(createInput())).rejects.toThrow(
        'bitbucket pr failed: 409',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe('HttpMrClient — bitbucket Cloud (api.bitbucket.org/2.0)', () => {
  const repositoryUrl = 'https://bitbucket.org/kos/kc_cloud_demo.git';
  const mrUrl = 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/5';
  const cloud = new HttpMrClient();

  const commentsBody = {
    values: [
      {
        content: { raw: 'Зачем тут Eager?' },
        user: { display_name: 'Artem Gusev', account: 'gusev' },
        created_on: '2026-10-20T10:00:00.000+0000',
        inline: { path: 'src/app.ts', from: null, to: 12 },
      },
      {
        content: { raw: 'Общий комментарий' },
        user: { account: 'nickol' },
        created_on: '2026-10-20T11:00:00.000+0000',
      },
      { content: { raw: 'удалён' }, deleted: { raw: '' } },
      { content: { raw: 'черновик' }, pending: { content: { raw: '' } } },
    ],
  };

  it('comments → GET /2.0/.../pullrequests/5/comments, маппинг content.raw/inline', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => commentsBody });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const comments = await cloud.fetchComments({
        mrUrl,
        token: 'secret-token',
        repositoryUrl,
      });
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
        'https://api.bitbucket.org/2.0/repositories/kos/kc_cloud_demo/pullrequests/5/comments?pagelen=100',
      );
      expect(comments).toEqual([
        {
          file: 'src/app.ts',
          line: 12,
          body: 'Зачем тут Eager?',
          author: 'Artem Gusev',
          created_at: '2026-10-20T10:00:00.000+0000',
        },
        {
          file: null,
          line: null,
          body: 'Общий комментарий',
          author: 'nickol',
          created_at: '2026-10-20T11:00:00.000+0000',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Cloud листает страницы по курсору `next`', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string) => {
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () =>
          call === 1
            ? {
                values: [{ content: { raw: 'первый' } }],
                next: 'https://api.bitbucket.org/2.0/page2',
              }
            : { values: [{ content: { raw: 'второй' } }] },
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const comments = await cloud.fetchComments({
        mrUrl,
        token: 't',
        repositoryUrl,
      });
      expect(comments.map((c) => c.body)).toEqual(['первый', 'второй']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
        'https://api.bitbucket.org/2.0/page2',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('битая Cloud-ссылка долечивается по repositoryUrl', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ values: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await cloud.fetchComments({
        mrUrl: 'https://bitbucket.org/pull-requests/5',
        token: 't',
        repositoryUrl,
      });
      expect((fetchMock.mock.calls[0] as [string])[0]).toContain(
        '/2.0/repositories/kos/kc_cloud_demo/pullrequests/5/comments',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('createMr → POST /pullrequests с source/destination.branch, html_url как ссылка', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 5,
        html_url: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/5',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await cloud.createMr(
        input({
          repositoryUrl,
          source: 'bitbucket',
          headBranch: 'feature/x',
          baseBranch: 'dev',
        }),
      );
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.bitbucket.org/2.0/repositories/kos/kc_cloud_demo/pullrequests',
      );
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        title: 'Fix EXP-1',
        summary: 'Generated MR description',
        source: {
          branch: { name: 'feature/x' },
          repository: { full_name: 'kos/kc_cloud_demo' },
        },
        destination: { branch: { name: 'dev' } },
      });
      expect(result).toEqual({
        mrUrl: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/5',
        id: '5',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('createMr: на успехе тело читается один раз (text() не трогается)', async () => {
    const textSpy = vi.fn(async () => 'should-not-be-read');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 5, html_url: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/5' }),
      text: textSpy,
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await cloud.createMr(
        input({
          repositoryUrl,
          source: 'bitbucket',
          headBranch: 'feature/x',
          baseBranch: 'dev',
        }),
      );
      expect(result.id).toBe('5');
      expect(textSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('createMr: 400 «already exists» → найденный открытый PR, а не ошибка', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST'
        ? {
            ok: false,
            status: 400,
            text: async () =>
              '{"error":{"message":"A pull request already exists for gusev:feature/x."}}',
          }
        : {
            ok: true,
            status: 200,
            json: async () => ({
              values: [
                {
                  id: 7,
                  html_url: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/7',
                  source: { branch: { name: 'feature/x' } },
                  destination: { branch: { name: 'dev' } },
                },
              ],
            }),
          },
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await cloud.createMr(
        input({
          repositoryUrl,
          source: 'bitbucket',
          headBranch: 'feature/x',
          baseBranch: 'dev',
        }),
      );
      expect(result).toEqual({
        mrUrl: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/7',
        id: '7',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('findOpenMr: фильтр по паре веток на клиенте (у Cloud нет фильтра в query)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        values: [
          {
            id: 1,
            html_url: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/1',
            source: { branch: { name: 'feature/other' } },
            destination: { branch: { name: 'dev' } },
          },
          {
            id: 2,
            html_url: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/2',
            source: { branch: { name: 'feature/x' } },
            destination: { branch: { name: 'main' } },
          },
          {
            id: 3,
            html_url: 'https://bitbucket.org/kos/kc_cloud_demo/pull-requests/3',
            source: { branch: { name: 'feature/x' } },
            destination: { branch: { name: 'dev' } },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const found = await cloud.findOpenMr({
        repositoryUrl,
        headBranch: 'feature/x',
        baseBranch: 'dev',
        token: 't',
        source: 'bitbucket',
      } as MrFindInput);
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
        'https://api.bitbucket.org/2.0/repositories/kos/kc_cloud_demo/pullrequests?state=OPEN&pagelen=100',
      );
      expect(found?.id).toBe('3');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('updateMr: PUT /pullrequests/{id} с {title, summary}, version не нужна', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const update: MrUpdateInput = {
      repositoryUrl,
      mrId: '5',
      title: 'new title',
      description: 'new description',
      token: 't',
      source: 'bitbucket',
    };
    try {
      await cloud.updateMr(update);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.bitbucket.org/2.0/repositories/kos/kc_cloud_demo/pullrequests/5',
      );
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        title: 'new title',
        summary: 'new description',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('обновление Cloud падает с PUT и текстом ответа в ошибке', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Insufficient permissions',
      }),
    );
    try {
      await expect(
        cloud.updateMr({
          repositoryUrl,
          mrId: '5',
          title: 't',
          description: 'd',
          token: 't',
          source: 'bitbucket',
        } as MrUpdateInput),
      ).rejects.toThrow(
        'bitbucket cloud pr update failed: 403 — PUT /2.0/repositories/kos/kc_cloud_demo/pullrequests/5 — Insufficient permissions',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HttpMrClient.updateMr — Server / GitLab / GitHub', () => {
  const client = new HttpMrClient();

  it('Bitbucket Server: читает version, потом PUT с ней', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ version: 6 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await client.updateMr({
        repositoryUrl: 'https://b.yadro.com/scm/kos/kc_docs_editor_front.git',
        mrId: '218',
        title: 't',
        description: 'd',
        token: 't',
        source: 'bitbucket',
      } as MrUpdateInput);
      const base =
        'https://b.yadro.com/rest/api/1.0/projects/kos/repos/kc_docs_editor_front/pull-requests/218';
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe(base);
      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        title: 't',
        description: 'd',
        version: 6,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Bitbucket Server: чтение PR упало → ошибки PUT нет', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, text: async () => 'nope' });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        client.updateMr({
          repositoryUrl: 'https://b.yadro.com/scm/kos/x.git',
          mrId: '1',
          title: 't',
          description: 'd',
          token: 't',
          source: 'bitbucket',
        } as MrUpdateInput),
      ).rejects.toThrow('bitbucket pr read failed: 404');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GitLab: PUT /api/v4/projects/{path}/merge_requests/{iid}', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await client.updateMr({
        repositoryUrl: 'https://gitlab.com/group/project.git',
        mrId: '9',
        title: 't',
        description: 'd',
        token: 'gl-token',
        source: 'gitlab',
      } as MrUpdateInput);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests/9',
      );
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        title: 't',
        description: 'd',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GitHub: PATCH /repos/{owner}/{repo}/pulls/{number}, Enterprise — на своём хосте', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await client.updateMr({
        repositoryUrl: 'https://github.com/org/repo.git',
        mrId: '42',
        title: 't',
        description: 'd',
        token: 'gh-token',
        source: 'github',
      } as MrUpdateInput);
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
        'https://api.github.com/repos/org/repo/pulls/42',
      );
      await client.updateMr({
        repositoryUrl: 'https://github.example.com/org/repo.git',
        mrId: '42',
        title: 't',
        description: 'd',
        token: 'gh-token',
        source: 'github',
      } as MrUpdateInput);
      expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
        'https://github.example.com/api/v3/repos/org/repo/pulls/42',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HttpMrClient.fetchComments — пагинация GitHub/GitLab', () => {
  const client = new HttpMrClient();
  const page = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({
      body: `${prefix}${i}`,
      user: { login: 'gusev' },
      created_at: '2026-10-20T10:00:00Z',
    }));

  const stubPages = (
    pick: (url: string) => unknown[],
    fail?: (url: string) => number | undefined,
  ) => {
    const fetchMock = vi.fn(async (url: string) => {
      const status = fail?.(url);
      if (status) {
        return { ok: false, status, statusText: 'err', text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => pick(url) };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('GitHub: review+issue комментарии листаются по page', async () => {
    const fetchMock = stubPages((url) => {
      if (url.includes('/pulls/7/comments')) {
        return url.includes('page=2') ? page(2, 'r') : page(100, 'r');
      }
      return page(3, 'i');
    });
    try {
      const comments = await client.fetchComments({
        mrUrl: 'https://github.com/org/repo/pull/7',
        token: 'gh',
        repositoryUrl: 'https://github.com/org/repo.git',
      });
      expect(comments).toHaveLength(105);
      const urls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toBe(
        'https://api.github.com/repos/org/repo/pulls/7/comments?per_page=100&page=1',
      );
      expect(urls[1]).toContain('page=2');
      expect(urls[2]).toContain('/issues/7/comments?per_page=100&page=1');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GitHub: Enterprise-ссылка разбирается (не только github.com)', async () => {
    const fetchMock = stubPages(() => []);
    try {
      await client.fetchComments({
        mrUrl: 'https://github.example.com/org/repo/pull/7/files#issuecomment-1',
        token: 'gh',
        repositoryUrl: 'https://github.example.com/org/repo.git',
      });
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
        'https://github.example.com/api/v3/repos/org/repo/pulls/7/comments?per_page=100&page=1',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GitHub: 500 на review-комментах — ошибка, а не пустой список', async () => {
    stubPages(
      () => [],
      (url) => (url.includes('/pulls/') ? 500 : undefined),
    );
    try {
      await expect(
        client.fetchComments({
          mrUrl: 'https://github.com/org/repo/pull/7',
          token: 'gh',
          repositoryUrl: 'https://github.com/org/repo.git',
        }),
      ).rejects.toThrow(
        'github review comments failed: 500 — GET /repos/org/repo/pulls/7/comments',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GitLab: заметки листаются по page=2..N', async () => {
    const fetchMock = stubPages((url) =>
      url.includes('page=2')
        ? [{ body: 'хвост', author: { name: 'Ann' }, created_at: 'x' }]
        : page(100, 'n'),
    );
    try {
      const comments = await client.fetchComments({
        mrUrl: 'https://gitlab.com/group/project/-/merge_requests/9',
        token: 'gl',
        repositoryUrl: 'https://gitlab.com/group/project.git',
      });
      expect(comments).toHaveLength(101);
      const urls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toBe(
        'https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests/9/notes?sort=asc&per_page=100&page=1',
      );
      expect(urls[1]).toContain('page=2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GitLab: ссылка без /-/ долечивается по repositoryUrl', async () => {
    const fetchMock = stubPages(() => []);
    try {
      await client.fetchComments({
        mrUrl: 'https://gitlab.com/merge_requests/9',
        token: 'gl',
        repositoryUrl: 'https://gitlab.com/group/project.git',
      });
      expect((fetchMock.mock.calls[0] as [string])[0]).toContain(
        '/api/v4/projects/group%2Fproject/merge_requests/9/notes',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GitLab: в тексте ошибки виден REST-путь', async () => {
    stubPages(
      () => [],
      () => 404,
    );
    try {
      await expect(
        client.fetchComments({
          mrUrl: 'https://gitlab.com/group/project/-/merge_requests/9',
          token: 'gl',
          repositoryUrl: 'https://gitlab.com/group/project.git',
        }),
      ).rejects.toThrow(
        'gitlab notes failed: 404 — GET /api/v4/projects/group%2Fproject/merge_requests/9/notes',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('капп страниц: сервер, зациклившийся на одной странице, — ошибка', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        values: [{ action: 'COMMENT', comment: { text: 'x' } }],
        isLastPage: false,
        nextPageStart: 0,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        client.fetchComments({
          mrUrl: 'https://b.yadro.com/projects/KOS/repos/kc_docs_editor_front/pull-requests/218',
          token: 't',
          repositoryUrl: 'https://b.yadro.com/scm/kos/kc_docs_editor_front.git',
        }),
      ).rejects.toThrow(/pagination cap \(50 pages\) reached/);
      expect(fetchMock).toHaveBeenCalledTimes(50);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
