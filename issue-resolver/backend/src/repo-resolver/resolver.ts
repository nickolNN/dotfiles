/**
 * Валидация репозиториев через API хостинг-платформы
 * (GitHub/GitLab/Bitbucket Server). Реальные резолверы ходят в REST API через
 * global fetch (Node 24) — без новых зависимостей. Токены опциональны: без них
 * запрос работает, но упирается в rate limit; 404/401/403 маппятся в понятные
 * ошибки.
 */

import type { RepoInfo, RepoPlatform } from '@issue-resolver/shared';

export interface RepoResolver {
  /** Проверяет существование репозитория и возвращает его метаданные. */
  resolve(url: string): Promise<RepoInfo>;
}

/** Фабрика резолверов: по URL и env выбирает реализацию (шов инъекции в тестах). */
export type RepoResolverFactory = (
  url: string,
  env: NodeJS.ProcessEnv,
) => RepoResolver;

const DEFAULT_GITLAB_HOST = 'gitlab.com';
const DEFAULT_BITBUCKET_HOST = 'bitbucket.org';

/** Хост из https-URL или ssh-стиля `git@host:path` ('' — не распознан). */
function hostOf(url: string): string {
  const trimmed = url.trim();
  const sshMatch = /^[^@/]+@([^:/]+)[:/]/.exec(trimmed);
  if (sshMatch) {
    return sshMatch[1].toLowerCase();
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Путь репозитория без хоста и хвоста `.git` (для https и ssh-стиля). */
function repoPathOf(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  const sshMatch = /^[^@/]+@[^:/]+[:/](.+)$/.exec(trimmed);
  if (sshMatch) {
    return sshMatch[1].replace(/^\/+/, '');
  }
  try {
    return new URL(trimmed).pathname.replace(/^\/+/, '');
  } catch {
    throw new Error(`cannot parse repository url: ${url}`);
  }
}

/** `owner/repo` из https- или ssh-URL GitHub. */
function githubOwnerRepo(url: string): { owner: string; repo: string } {
  const segments = repoPathOf(url)
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`cannot parse github repository: ${url}`);
  }
  return { owner: segments[0], repo: segments[1] };
}

/** Cloud-хост Bitbucket (публичное облако, API 2.0) в отличие от Server/DC. */
function isBitbucketCloudHost(host: string): boolean {
  return host === 'bitbucket.org';
}

/**
 * `project`/`repo` из URL Bitbucket Server/Data Center или Bitbucket Cloud.
 * Cloud (`bitbucket.org`): `/<owner>/<repo>` — первые два сегмента пути.
 * Server/DC поддержаны:
 * - `https://<host>/projects/<PROJECT>/repos/<REPO>/browse`
 * - `https://<host>/scm/<project>/<repo>.git`
 * - http clone URL `https://<host>/scm/<project>/<repo>.git`
 */
function bitbucketProjectRepo(url: string): { project: string; repo: string } {
  const segments = repoPathOf(url)
    .split('/')
    .filter((segment) => segment.length > 0);

  if (isBitbucketCloudHost(hostOf(url))) {
    if (segments.length < 2) {
      throw new Error(`cannot parse bitbucket repository: ${url}`);
    }
    return { project: segments[0], repo: segments[1] };
  }

  if (segments[0]?.toLowerCase() === 'scm') {
    if (segments.length < 3) {
      throw new Error(`cannot parse bitbucket repository: ${url}`);
    }
    return { project: segments[1], repo: segments[2] };
  }

  const projectsIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === 'projects',
  );
  const reposIndex = segments.findIndex(
    (segment, index) =>
      index > projectsIndex && segment.toLowerCase() === 'repos',
  );
  if (projectsIndex !== -1 && reposIndex !== -1) {
    return {
      project: segments[projectsIndex + 1],
      repo: segments[reposIndex + 1],
    };
  }

  // Self-hosted SSH URL: `ssh://host:port/<project>/<repo>.git`
  // — два сегмента пути без scm/projects-префикса.
  if (segments.length >= 2) {
    return { project: segments[0], repo: segments[1] };
  }

  throw new Error(`cannot parse bitbucket repository: ${url}`);
}

/** Определяет платформу по URL репозитория. */
export function detectPlatform(url: string): RepoPlatform {
  const host = hostOf(url);
  if (!host) {
    return 'unknown';
  }
  if (host.includes('github')) {
    return 'github';
  }
  if (host.includes('gitlab')) {
    return 'gitlab';
  }
  if (host.includes('bitbucket')) {
    return 'bitbucket';
  }
  // Bitbucket Server ранее назывался Stash; self-hosted инстансы часто
  // живут на `stash.*` — это та же REST API Bitbucket Server.
  if (host.includes('stash')) {
    return 'bitbucket';
  }
  // Известные публичные SaaS-хосты — не Bitbucket.
  if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') {
    return 'unknown';
  }
  // Self-hosted/частный хост — по умолчанию Bitbucket Server.
  return 'bitbucket';
}

interface GitHubRepoResponse {
  full_name: string;
  default_branch: string;
  language: string | null;
  description: string | null;
  stargazers_count: number;
  private: boolean;
  clone_url: string;
  /** Отдаётся только для аутентифицированных запросов. */
  permissions?: { push?: boolean };
}

/** GitHub: `GET https://api.github.com/repos/:owner/:repo`. */
export class GitHubResolver implements RepoResolver {
  constructor(private readonly token = '') {}

  async resolve(url: string): Promise<RepoInfo> {
    const { owner, repo } = githubOwnerRepo(url);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'issue-resolver',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      },
    );

    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.status}`);
    }

    const data = (await response.json()) as GitHubRepoResponse;

    let branches: string[] = [data.default_branch];
    try {
      const branchesResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'issue-resolver',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
        },
      );
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as Array<{ name: string }>;
        branches = list.map((b) => b.name);
      }
    } catch {
      // fallback to default branch only
    }

    return {
      platform: 'github',
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      branches,
      language: data.language,
      description: data.description,
      stars: data.stargazers_count,
      isPrivate: data.private,
      cloneUrl: data.clone_url,
      writeAccess: data.permissions?.push === true,
    };
  }
}

interface GitLabRepoResponse {
  path_with_namespace: string;
  default_branch: string;
  language: string | null;
  description: string | null;
  star_count: number;
  visibility: string;
  http_url_to_repo: string;
  permissions?: {
    project_access?: { access_level?: number } | null;
  } | null;
}
/** GitLab: `GET https://<host>/api/v4/projects/:encodeURIComponent(path)`. */
export class GitLabResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly host = DEFAULT_GITLAB_HOST,
  ) {}

  async resolve(url: string): Promise<RepoInfo> {
    const path = repoPathOf(url);
    const response = await fetch(
      `https://${this.host}/api/v4/projects/${encodeURIComponent(path)}`,
      {
        headers: {
          ...(this.token ? { 'PRIVATE-TOKEN': this.token } : {}),
        },
      },
    );

    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`GitLab API request failed: ${response.status}`);
    }

    const data = (await response.json()) as GitLabRepoResponse;

    let branches: string[] = [data.default_branch];
    try {
      const branchesResp = await fetch(
        `https://${this.host}/api/v4/projects/${encodeURIComponent(path)}/repository/branches?per_page=100`,
        {
          headers: {
            ...(this.token ? { 'PRIVATE-TOKEN': this.token } : {}),
          },
        },
      );
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as Array<{ name: string }>;
        branches = list.map((b) => b.name);
      }
    } catch {
      // fallback to default branch only
    }

    return {
      platform: 'gitlab',
      fullName: data.path_with_namespace,
      defaultBranch: data.default_branch,
      branches,
      language: data.language,
      description: data.description,
      stars: data.star_count,
      isPrivate: data.visibility !== 'public',
      cloneUrl: data.http_url_to_repo,
      // Developer+ (30) в GitLab даёт право создавать MR; ниже — только чтение.
      writeAccess: (data.permissions?.project_access?.access_level ?? 0) >= 30,
    };
  }
}

interface BitbucketCloneLink {
  name: string;
  href: string;
}

interface BitbucketRepoResponse {
  slug: string;
  name: string;
  project: { key: string; name: string };
  description: string | null;
  public: boolean;
  links: { clone: BitbucketCloneLink[] };
}

interface BitbucketBranchResponse {
  displayId: string;
}

/** Authorization Bitbucket: Bearer (PAT), иначе Basic (app password). */
function bitbucketAuthHeaders(
  token: string,
  username: string,
  password: string,
): Record<string, string> {
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  if (username) {
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

/**
 * Bitbucket Server / Data Center:
 * - `GET https://<host>/rest/api/1.0/projects/<project>/repos/<repo>`
 * - `GET https://<host>/rest/api/1.0/projects/<project>/repos/<repo>/branches/default`
 *
 * Авторизация: Bearer (Personal Access Token) при заданном `token`, иначе
 * Basic (App Password) при заданных username/password.
 * `language` и `stars` в Server API не отдаются → `null` и `0`.
 */
export class BitbucketResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly host = DEFAULT_BITBUCKET_HOST,
    private readonly username = '',
    private readonly password = '',
  ) {}

  private headers(): Record<string, string> {
    return bitbucketAuthHeaders(this.token, this.username, this.password);
  }

  /**
   * Право на запись токена в репозиторий. Bitbucket Server не отдаёт это в
   * метаданных, поэтому проверяем пробной операцией: создать временную ветку
   * от default-ветки и сразу её удалить. Токен (Bearer PAT / Basic app
   * password) сам аутентифицирует пользователя — `BITBUCKET_USERNAME` не нужен.
   * Не-2xx (в т.ч. 401/403) или сбой сети → false, валидацию не роняем.
   */
  private async hasWriteAccess(
    project: string,
    repo: string,
    startPoint: string,
  ): Promise<boolean> {
    const testBranch = `_pi_write_test_${Date.now()}`;
    const base = `https://${this.host}/rest/api/1.0/projects/${project}/repos/${repo}`;
    const headers = this.headers();
    try {
      const createResp = await fetch(`${base}/branches`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: testBranch, startPoint }),
      });
      if (!createResp.ok) return false;
      // Best-effort уборка тестовой ветки; её результат не влияет на ответ.
      try {
        await fetch(`${base}/branches`, {
          method: 'DELETE',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `refs/heads/${testBranch}` }),
        });
      } catch {
        // уборка не удалась — это не признак отсутствия прав
      }
      return true;
    } catch {
      return false;
    }
  }

  async resolve(url: string): Promise<RepoInfo> {
    // `bitbucket.org` — Cloud с API 2.0; `this.host` — Server/DC REST 1.0.
    if (isBitbucketCloudHost(hostOf(url) || this.host)) {
      return new BitbucketCloudResolver(
        this.token,
        this.username,
        this.password,
      ).resolve(url);
    }

    const { project, repo } = bitbucketProjectRepo(url);
    const base = `https://${this.host}/rest/api/1.0/projects/${project}/repos/${repo}`;

    const response = await fetch(base, { headers: this.headers() });
    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`Bitbucket API request failed: ${response.status}`);
    }
    const data = (await response.json()) as BitbucketRepoResponse;

    const branchResponse = await fetch(`${base}/branches/default`, {
      headers: this.headers(),
    });
    const branch = branchResponse.ok
      ? ((await branchResponse.json()) as BitbucketBranchResponse)
      : null;

    const httpClone = data.links?.clone?.find(
      (link) => link.name === 'http',
    );

    let branches: string[] = [branch?.displayId ?? 'main'];
    try {
      const branchesResp = await fetch(`${base}/branches?limit=100`, {
        headers: this.headers(),
      });
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as {
          values?: Array<{ displayId: string }>;
        };
        if (list.values) {
          branches = list.values.map((b) => b.displayId);
        }
      }
    } catch {
      // fallback to default branch only
    }

    const defaultBranch = branch?.displayId ?? 'main';

    return {
      platform: 'bitbucket',
      fullName: `${data.project?.key ?? project}/${data.slug ?? repo}`,
      defaultBranch,
      branches,
      language: null,
      description: data.description ?? null,
      stars: 0,
      isPrivate: !data.public,
      cloneUrl:
        httpClone?.href ?? `https://${this.host}/scm/${project}/${repo}.git`,
      writeAccess: await this.hasWriteAccess(
        project,
        repo,
        `refs/heads/${defaultBranch}`,
      ),
    };
  }
}

interface BitbucketCloudRepoResponse {
  full_name: string;
  mainbranch?: { name: string } | null;
  language: string | null;
  description: string | null;
  is_private: boolean;
  links?: { clone?: BitbucketCloneLink[] };
}

/**
 * Bitbucket Cloud (`bitbucket.org`) — API 2.0 (не Server/DC):
 * - `GET https://api.bitbucket.org/2.0/repositories/<owner>/<repo>`
 * - `GET https://api.bitbucket.org/2.0/repositories/<owner>/<repo>/refs/branches?pagelen=100`
 *
 * Авторизация: Bearer (PAT) или Basic (app password). `stars` в базовом
 * ответе нет (отдельный эндпоинт) → `0`.
 */
export class BitbucketCloudResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly username = '',
    private readonly password = '',
  ) {}

  async resolve(url: string): Promise<RepoInfo> {
    const { project: owner, repo } = bitbucketProjectRepo(url);
    const base = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}`;
    const headers = bitbucketAuthHeaders(
      this.token,
      this.username,
      this.password,
    );

    const response = await fetch(base, { headers });
    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`Bitbucket API request failed: ${response.status}`);
    }
    const data = (await response.json()) as BitbucketCloudRepoResponse;

    const defaultBranch = data.mainbranch?.name ?? 'main';

    let branches: string[] = [defaultBranch];
    try {
      const branchesResp = await fetch(`${base}/refs/branches?pagelen=100`, {
        headers,
      });
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as {
          values?: Array<{ name: string }>;
        };
        if (list.values) {
          branches = list.values.map((b) => b.name);
        }
      }
    } catch {
      // fallback to default branch only
    }

    const httpsClone = data.links?.clone?.find(
      (link) => link.name === 'https',
    );

    return {
      platform: 'bitbucket',
      fullName: data.full_name,
      defaultBranch,
      branches,
      language: data.language ?? null,
      description: data.description ?? null,
      stars: 0,
      isPrivate: data.is_private,
      cloneUrl:
        httpsClone?.href ?? `https://bitbucket.org/${owner}/${repo}.git`,
      // Cloud в базовом ответе прав не отдаёт — считаем права отсутствующими.
      writeAccess: false,
    };
  }
}

/** Фабрика: по `detectPlatform(url)` возвращает нужный резолвер. */
export function createRepoResolver(
  url: string,
  env: NodeJS.ProcessEnv,
): RepoResolver {
  const platform = detectPlatform(url);
  if (platform === 'github') {
    return new GitHubResolver(env.GITHUB_TOKEN ?? '');
  }
  if (platform === 'gitlab') {
    return new GitLabResolver(
      env.GITLAB_TOKEN ?? '',
      hostOf(url) || DEFAULT_GITLAB_HOST,
    );
  }
  if (platform === 'bitbucket') {
    return new BitbucketResolver(
      env.BITBUCKET_TOKEN ?? '',
      hostOf(url) || DEFAULT_BITBUCKET_HOST,
      env.BITBUCKET_USERNAME ?? '',
      env.BITBUCKET_PASSWORD ?? '',
    );
  }
  throw new Error('Unsupported platform');
}

/**
 * In-memory-резолвер для тестов: запоминает вызовы, отдаёт заданные
 * метаданные. `failNextWith` позволяет проверить путь ошибки.
 */
export class FakeRepoResolver implements RepoResolver {
  readonly calls: string[] = [];
  private pendingError: Error | null = null;

  constructor(private readonly info: RepoInfo) {}

  /** Следующий resolve отклонится этой ошибкой. */
  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async resolve(url: string): Promise<RepoInfo> {
    this.calls.push(url);
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    // Fake-резолвер по умолчанию считает, что право на запись есть.
    return { ...this.info, writeAccess: this.info.writeAccess ?? true };
  }
}