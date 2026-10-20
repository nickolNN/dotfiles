/**
 * PR/MR-сервис (Фаза 4): pr-шаг генерирует описание, бэкенд создаёт MR/PR.
 * Хост определяется из формата URL, реальный клиент ходит в REST API
 * GitLab/GitHub через global fetch — без новых зависимостей.
 */

export interface MrCreateInput {
  /** 'git@gitlab...:project.git' (ssh) или https-URL. */
  repositoryUrl: string;
  /** Target branch. */
  baseBranch: string;
  /** Ветка с изменениями. */
  headBranch: string;
  title: string;
  description: string;
  /** MR-токен (в реальном коде — из secrets/конфига). */
  token: string;
  /** Выводится из repositoryUrl через detectGitHost. */
  source: 'gitlab' | 'github' | 'bitbucket';
}

export interface MrCreateResult {
  mrUrl: string;
  id: string;
}

/** Комментарий ревью из PR/MR. */
export interface MrComment {
  /** Файл, к которому относится комментарий (или null для общих). */
  file: string | null;
  /** Строка в файле (или null для общих комментариев). */
  line: number | null;
  /** Текст комментария. */
  body: string;
  /** Автор комментария. */
  author: string;
  /** ISO-дата создания. */
  created_at: string;
}

export interface MrFetchCommentsInput {
  /** Полный URL MR/PR (например https://github.com/owner/repo/pull/42). */
  mrUrl: string;
  token: string;
}

export interface MrFindInput {
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  token: string;
  source: 'gitlab' | 'github' | 'bitbucket';
}

export interface MrClient {
  createMr(input: MrCreateInput): Promise<MrCreateResult>;
  /** Получить комментарии ревью из MR/PR. */
  fetchComments(input: MrFetchCommentsInput): Promise<MrComment[]>;
  /**
   * Найти открытый MR/PR по source-ветке (head). Если MR существует —
   * возвращает его URL; если нет — null. Используется, чтобы не создавать
   * дубликат при повторном push в ту же ветку (следующая итерация задачи).
   */
  findOpenMr(input: MrFindInput): Promise<MrCreateResult | null>;
}

/** Ошибка публикации результата pr-шага по конкретному репозиторию. */
export interface PrPublishError {
  repositoryUrl: string;
  /** Человекочитаемая причина: фаза (commit/push или MR) + текст ошибки. */
  message: string;
}

/** Человекочитаемая сводка ошибок публикации для отчёта/UI. */
export function formatPrPublishErrors(errors: PrPublishError[]): string {
  return errors.map((error) => error.message).join('; ');
}

/**
 * Токены MR по хостам-источникам. Используются как fallback, когда
 * per-call `input.token` пуст: приоритет `input.token > tokens[source] > token`.
 */
export interface MrTokens {
  gitlab?: string;
  github?: string;
  bitbucket?: string;
}

/** Хост из https-URL или ssh-стиля `git@host:path`. */
export function hostOf(repositoryUrl: string): string {
  const trimmed = repositoryUrl.trim();
  if (!trimmed) throw new Error('unknown git host');

  const sshMatch = /^[^@/]+@([^:/]+)[:/]/.exec(trimmed);
  if (sshMatch) return sshMatch[1].toLowerCase();

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    throw new Error('unknown git host');
  }
}

/**
 * Определяет хост по URL/ssh-строке репозитория.
 * - host содержит 'github' → 'github'
 * - host содержит 'gitlab' → 'gitlab'
 * - host содержит 'bitbucket'/'stash' или путь `/scm/` (Bitbucket Server)
 *   → 'bitbucket'
 * - иначе → throw Error('unknown git host')
 *
 * ssh-стиль `git@...` обрабатывается так же, как https (сравнение по хосту),
 * поэтому self-hosted `git@gitlab.example.com:files-web.git` → gitlab.
 */
export function detectGitHost(
  repositoryUrl: string,
): 'gitlab' | 'github' | 'bitbucket' {
  const host = hostOf(repositoryUrl);
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  if (
    host.includes('bitbucket') ||
    host.includes('stash') ||
    /\/scm\//.test(repositoryUrl)
  ) {
    return 'bitbucket';
  }
  throw new Error('unknown git host');
}

/**
 * In-memory-клиент для тестов: запоминает вызовы, возвращает синтетический
 * MR-URL. `failNextWith` позволяет проверить путь ошибки.
 */
export class FakeMrClient implements MrClient {
  readonly calls: MrCreateInput[] = [];
  private pendingError: Error | null = null;

  /** Симулированные комментарии ревью; возвращаются вызовом fetchComments. */
  reviewComments: MrComment[] = [];

  /** Следующий createMr отклонится этой ошибкой. */
  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async fetchComments(_input: MrFetchCommentsInput): Promise<MrComment[]> {
    return [...this.reviewComments];
  }

  /**
   * Симулированные открытые MR; тесты заполняют этот массив до вызова
   * `runIteration`. Каждая запись проверяется по `repositoryUrl` и
   * `headBranch`; при совпадении возвращается её `mrUrl`.
   */
  openMrs: Array<{
    repositoryUrl: string;
    headBranch: string;
    baseBranch: string;
    mrUrl: string;
  }> = [];

  async findOpenMr(input: MrFindInput): Promise<MrCreateResult | null> {
    const found = this.openMrs.find(
      (mr) =>
        mr.repositoryUrl === input.repositoryUrl &&
        mr.headBranch === input.headBranch &&
        mr.baseBranch === input.baseBranch,
    );
    return found ? { mrUrl: found.mrUrl, id: found.mrUrl } : null;
  }

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    this.calls.push(input);
    const id = `mr-${this.calls.length}`;
    const webBase = input.repositoryUrl
      .replace(/^[^@/]+@/, 'https://')
      .replace(/:/, '/')
      .replace(/\.git$/, '');
    if (input.source === 'bitbucket') {
      const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
      return {
        mrUrl: `https://${hostOf(input.repositoryUrl)}/projects/${project}/repos/${repo}/pull-requests/${id}`,
        id,
      };
    }
    if (input.source === 'github') {
      const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
      return {
        mrUrl: `https://${hostOf(input.repositoryUrl)}/${owner}/${repo}/pull/${id}`,
        id,
      };
    }
    return { mrUrl: `${webBase}/-/merge_requests/${id}`, id };
  }
}

interface GitLabMrResponse {
  iid: number;
  web_url: string;
}

interface GitHubPrResponse {
  number: number;
  html_url: string;
}

interface BitbucketPrResponse {
  id: number;
}

/**
 * Реальная интеграция через global fetch. Юнит-тестами не покрывается —
 * это интеграционный путь.
 *
 * TODO(§10): токен в реальном коде приходит из secrets-конфига (не env).
 *
 * Парсинг адреса реализован: GitLab — encodeURIComponent полного project path
 * без хоста; GitHub — owner/repo из https- или ssh-URL.
 *
 * GitLab: POST {host}/api/v4/projects/{urlencoded_path}/merge_requests
 *   headers: PRIVATE-TOKEN: <token>
 *   body:    { source_branch, target_branch, title, description }
 * GitHub: POST {host}/api/v3/repos/{owner}/{repo}/pulls (Enterprise:
 *   /api/v3/repos/...; github.com: https://api.github.com/repos/...)
 *   headers: Authorization: Bearer <token>, Accept: application/vnd.github+json
 *   body:    { head, base, title, body }
 * Bitbucket Server: POST {host}/rest/api/1.0/projects/{project}/repos/{repo}/pull-requests
 *   headers: Authorization: Bearer <token>
 *   body:    { title, description, fromRef: { id }, toRef: { id } }
 */
export class HttpMrClient implements MrClient {
  /**
   * `token` — общий дефолт из конфига/фабрики; `tokens` — per-host токены
   * (`BITBUCKET_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`). Приоритет:
   * `input.token` > `tokens[source]` > `token`.
   */
  constructor(
    private readonly token = '',
    private readonly tokens: MrTokens = {},
  ) {}

  async fetchComments(input: MrFetchCommentsInput): Promise<MrComment[]> {
    const source = detectGitHost(input.mrUrl);
    const token = input.token || this.tokens[source] || this.token;

    if (source === 'github') {
      return this.fetchGitHubComments(input.mrUrl, token);
    }
    if (source === 'gitlab') {
      return this.fetchGitLabComments(input.mrUrl, token);
    }
    // Bitbucket: comments API
    return this.fetchBitbucketComments(input.mrUrl, token);
  }

  async findOpenMr(input: MrFindInput): Promise<MrCreateResult | null> {
    const token = input.token || this.tokens[input.source] || this.token;

    if (input.source === 'gitlab') {
      return this.findGitLabOpenMr(input, token);
    }
    if (input.source === 'github') {
      return this.findGitHubOpenMr(input, token);
    }
    return this.findBitbucketOpenMr(input, token);
  }

  private async findGitLabOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const path = gitlabProjectPath(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const res = await fetch(
      `https://${host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests?source_branch=${encodeURIComponent(input.headBranch)}&target_branch=${encodeURIComponent(input.baseBranch)}&state=opened&per_page=1`,
      { headers: { 'PRIVATE-TOKEN': token } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ iid: number; web_url: string }>;
    if (data.length === 0) return null;
    return { mrUrl: data[0].web_url, id: String(data[0].iid) };
  }

  private async findGitHubOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const apiBase =
      host === 'github.com'
        ? 'https://api.github.com'
        : `https://${host}/api/v3`;
    // GitHub требует head в формате owner:branch.
    const res = await fetch(
      `${apiBase}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.headBranch}`)}&base=${encodeURIComponent(input.baseBranch)}&state=open&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      number: number;
      html_url: string;
    }>;
    if (data.length === 0) return null;
    return { mrUrl: data[0].html_url, id: String(data[0].number) };
  }

  private async findBitbucketOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const res = await fetch(
      `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests?at=refs/heads/${encodeURIComponent(input.headBranch)}&state=OPEN`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      values?: Array<{ id: number }>;
    };
    if (!data.values || data.values.length === 0) return null;
    return {
      mrUrl: `https://${host}/projects/${project}/repos/${repo}/pull-requests/${data.values[0].id}`,
      id: String(data.values[0].id),
    };
  }

  private async fetchGitHubComments(mrUrl: string, token: string): Promise<MrComment[]> {
    // mrUrl: https://github.com/owner/repo/pull/NUMBER
    const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(mrUrl);
    if (!match) throw new Error(`cannot parse github pr url: ${mrUrl}`);
    const [, owner, repo, number] = match;

    const host = hostOf(mrUrl);
    const apiBase = host === 'github.com'
      ? 'https://api.github.com'
      : `https://${host}/api/v3`;

    // Собираем review comments (на дифф) + issue comments (общие).
    const all: MrComment[] = [];

    // Review comments (привязаны к файлу/строке)
    const reviewRes = await fetch(
      `${apiBase}/repos/${owner}/${repo}/pulls/${number}/comments`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    );
    if (reviewRes.ok) {
      const reviewData = (await reviewRes.json()) as Array<{
        path?: string; line?: number; body?: string;
        user?: { login?: string }; created_at?: string;
      }>;
      for (const c of reviewData) {
        all.push({
          file: c.path ?? null,
          line: typeof c.line === 'number' ? c.line : null,
          body: c.body ?? '',
          author: c.user?.login ?? 'unknown',
          created_at: c.created_at ?? '',
        });
      }
    }

    // Issue comments (общие, без привязки к файлу)
    const issueRes = await fetch(
      `${apiBase}/repos/${owner}/${repo}/issues/${number}/comments`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    );
    if (issueRes.ok) {
      const issueData = (await issueRes.json()) as Array<{
        body?: string; user?: { login?: string }; created_at?: string;
      }>;
      for (const c of issueData) {
        all.push({
          file: null,
          line: null,
          body: c.body ?? '',
          author: c.user?.login ?? 'unknown',
          created_at: c.created_at ?? '',
        });
      }
    }

    return all;
  }

  private async fetchGitLabComments(mrUrl: string, token: string): Promise<MrComment[]> {
    // mrUrl: https://gitlab.com/group/project/-/merge_requests/IID
    // или https://gitlab.example.com/group/project/-/merge_requests/IID
    const match = /\/([^/]+(?:\/[^/]+)*)\/-\/merge_requests\/(\d+)/.exec(mrUrl);
    if (!match) throw new Error(`cannot parse gitlab mr url: ${mrUrl}`);
    const [, projectPath, iid] = match;

    const host = hostOf(mrUrl);
    const res = await fetch(
      `https://${host}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/notes?sort=asc`,
      { headers: { 'PRIVATE-TOKEN': token } },
    );
    if (!res.ok) throw new Error(`gitlab notes failed: ${res.status}`);

    const data = (await res.json()) as Array<{
      body?: string; author?: { name?: string }; created_at?: string;
      position?: { new_path?: string; new_line?: number };
      system?: boolean;
    }>;

    return data
      .filter((c) => !c.system) // исключаем системные заметки (merge, assign, ...)
      .map((c) => ({
        file: c.position?.new_path ?? null,
        line: c.position?.new_line ?? null,
        body: c.body ?? '',
        author: c.author?.name ?? 'unknown',
        created_at: c.created_at ?? '',
      }));
  }

  private async fetchBitbucketComments(mrUrl: string, token: string): Promise<MrComment[]> {
    // mrUrl: https://host/projects/PROJECT/repos/REPO/pull-requests/ID
    const match = /\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/.exec(mrUrl);
    if (!match) throw new Error(`cannot parse bitbucket pr url: ${mrUrl}`);
    const [, project, repo, id] = match;

    const host = hostOf(mrUrl);
    const res = await fetch(
      `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${id}/comments`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`bitbucket comments failed: ${res.status}`);

    const data = (await res.json()) as { values?: Array<{
      text?: string; author?: { name?: string }; createdDate?: string;
      anchor?: { path?: string; line?: number };
    }> };

    return (data.values ?? []).map((c) => ({
      file: c.anchor?.path ?? null,
      line: c.anchor?.line ?? null,
      body: c.text ?? '',
      author: c.author?.name ?? 'unknown',
      created_at: c.createdDate ?? '',
    }));
  }

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    const token = input.token || this.tokens[input.source] || this.token;

    if (input.source === 'gitlab') {
      const path = gitlabProjectPath(input.repositoryUrl);
      const host = hostOf(input.repositoryUrl);
      const response = await fetch(
        `https://${host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': token,
          },
          body: JSON.stringify({
            source_branch: input.headBranch,
            target_branch: input.baseBranch,
            title: input.title,
            description: input.description,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`gitlab mr failed: ${response.status}`);
      }
      const data = (await response.json()) as GitLabMrResponse;
      return { mrUrl: data.web_url, id: String(data.iid) };
    }

    if (input.source === 'github') {
      const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
      const host = hostOf(input.repositoryUrl);
      // github.com живёт на api.github.com, GitHub Enterprise Server —
      // на собственном хосте под /api/v3.
      const apiBase =
        host === 'github.com'
          ? 'https://api.github.com'
          : `https://${host}/api/v3`;
      const response = await fetch(
        `${apiBase}/repos/${owner}/${repo}/pulls`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            head: input.headBranch,
            base: input.baseBranch,
            title: input.title,
            body: input.description,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`github pr failed: ${response.status}`);
      }
      const data = (await response.json()) as GitHubPrResponse;
      return { mrUrl: data.html_url, id: String(data.number) };
    }

    // Bitbucket Server/Stash: project/repo — из пути `/scm/{project}/{repo}`.
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const response = await fetch(
      `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          fromRef: { id: input.headBranch },
          toRef: { id: input.baseBranch },
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '(body unavailable)');
      throw new Error(`bitbucket pr failed: ${response.status} — ${body.slice(0, 500)}`);
    }
    const data = (await response.json()) as BitbucketPrResponse;
    return {
      mrUrl: `https://${host}/projects/${project}/repos/${repo}/pull-requests/${data.id}`,
      id: String(data.id),
    };
  }
}

/** 'group/sub/project' из https- или ssh-URL GitLab. */
function gitlabProjectPath(repositoryUrl: string): string {
  const trimmed = repositoryUrl.trim().replace(/\.git$/, '');
  const sshMatch = /^[^@/]+@[^:/]+[:/](.+)$/.exec(trimmed);
  if (sshMatch) return sshMatch[1];
  try {
    const pathname = new URL(trimmed).pathname;
    return pathname.replace(/^\/+/, '');
  } catch {
    throw new Error(`cannot parse repository url: ${repositoryUrl}`);
  }
}

/** owner/repo из https- или ssh-URL GitHub. */
function githubOwnerRepo(repositoryUrl: string): { owner: string; repo: string } {
  const path = gitlabProjectPath(repositoryUrl);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`cannot parse github repository: ${repositoryUrl}`);
  }
  return {
    owner: segments[segments.length - 2],
    repo: segments[segments.length - 1],
  };
}

/** `{project}/{repo}` из URL Bitbucket Server — `/scm/{project}/{repo}`. */
function bitbucketProjectRepo(repositoryUrl: string): {
  project: string;
  repo: string;
} {
  const path = gitlabProjectPath(repositoryUrl);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  // Клон Bitbucket Server лежит под `/scm/{project}/{repo}` — префикс отбрасываем.
  const cleaned =
    segments[0]?.toLowerCase() === 'scm' ? segments.slice(1) : segments;
  if (cleaned.length < 2) {
    throw new Error(`cannot parse bitbucket repository: ${repositoryUrl}`);
  }
  return {
    project: cleaned[cleaned.length - 2],
    repo: cleaned[cleaned.length - 1],
  };
}