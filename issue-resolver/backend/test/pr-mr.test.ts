import { describe, expect, it, vi } from 'vitest';
import {
  FakeMrClient,
  HttpMrClient,
  detectGitHost,
  formatPrPublishErrors,
  type MrClient,
  type MrCreateInput,
  type MrFindInput,
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
  /** Authorization-заголовок первого вызова stub-нутого fetch. */
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

      // per-call токен выигрывает у per-host и общего.
      await client.createMr(bitbucketInput);
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer secret-token');

      // пустой per-call → per-host токен (BITBUCKET_TOKEN).
      fetchMock.mockClear();
      await client.createMr({ ...bitbucketInput, token: '' });
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer bitbucket-token');

      // нет per-host токена → общий token.
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
      ).rejects.toThrow('bitbucket pr failed: 401 — Token expired');
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

      // per-call токен выигрывает у per-host и общего.
      await client.createMr(githubInput);
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer secret-token');

      // пустой per-call → per-host токен (GITHUB_TOKEN).
      fetchMock.mockClear();
      await client.createMr({ ...githubInput, token: '' });
      expect(authHeaderOfFirstCall(fetchMock)).toBe('Bearer github-token');

      // нет per-host токена → общий token.
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
      ).rejects.toThrow('github pr failed: 422');
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
    it('находит открытый PR → возвращает URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ values: [{ id: 99 }] }),
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new HttpMrClient();
        const result = await client.findOpenMr(
          findInput({
            repositoryUrl: 'https://b.yadro.com/scm/kos/some-repo.git',
            source: 'bitbucket',
          }),
        );

        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toContain('at=refs/heads/feature%2Ffix-bug-abc123');
        expect(url).toContain('state=OPEN');
        expect(result).toEqual({
          mrUrl: 'https://b.yadro.com/projects/kos/repos/some-repo/pull-requests/99',
          id: '99',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});