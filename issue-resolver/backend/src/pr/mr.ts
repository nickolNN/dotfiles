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

export interface MrClient {
  createMr(input: MrCreateInput): Promise<MrCreateResult>;
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

  /** Следующий createMr отклонится этой ошибкой. */
  failNextWith(err: Error): void {
    this.pendingError = err;
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