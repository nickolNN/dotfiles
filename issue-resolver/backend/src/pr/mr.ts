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
  source: 'gitlab' | 'github';
}

export interface MrCreateResult {
  mrUrl: string;
  id: string;
}

export interface MrClient {
  createMr(input: MrCreateInput): Promise<MrCreateResult>;
}

/** Хост из https-URL или ssh-стиля `git@host:path`. */
function hostOf(repositoryUrl: string): string {
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
 * - иначе → throw Error('unknown git host')
 *
 * ssh-стиль `git@...` обрабатывается так же, как https (сравнение по хосту),
 * поэтому self-hosted `git@gitlab.example.com:files-web.git` → gitlab.
 */
export function detectGitHost(repositoryUrl: string): 'gitlab' | 'github' {
  const host = hostOf(repositoryUrl);
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
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
 */
export class HttpMrClient implements MrClient {
  /** Токен по умолчанию из конфига/фабрики; input.token имеет приоритет. */
  constructor(private readonly token = '') {}

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    const token = input.token || this.token;

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

    const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
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