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

/**
 * Обновление заголовка/описания уже открытого MR. Нужно потому, что ветка
 * публикации стабильна для задачи (`featureBranchName` несёт суффикс `issueId`),
 * а payload MR растёт с каждой итерацией: `commitAndPush` делает `reset --soft
 * origin/<base>`, то есть в MR лежит ВСЯ задача, а не последняя итерация.
 * Пуш обновляет дифф, но не текст — без этого MR второй итерации описывал бы
 * первую.
 */
export interface MrUpdateInput {
  repositoryUrl: string;
  /** id из `MrCreateResult`: gitlab `iid`, github `number`, bitbucket `id`. */
  mrId: string;
  title: string;
  description: string;
  token: string;
  source: 'gitlab' | 'github' | 'bitbucket';
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
  /**
   * URL репозитория из того же артефакта. Позволяет долечить сохранённые
   * ссылки без project-ключа (`/projects/repos/x/pull-requests/1`) — их писал
   * старый safety-net в движке.
   */
  repositoryUrl?: string;
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
  /**
   * Записать свежие title/description в уже открытый MR (см. `MrUpdateInput`).
   * Вызывается после push того же head-branch, чтобы описание соответствовало
   * накопленному payload, а не итерации, на которой MR создавался.
   */
  updateMr(input: MrUpdateInput): Promise<void>;
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
 * - host содержит 'bitbucket'/'stash', путь `/scm/` (Bitbucket Server) или
 *   web-форма PR `/projects/{P}/repos/{R}/pull-requests/` → 'bitbucket'
 * - иначе → throw Error('unknown git host')
 *
 * ssh-стиль `git@...` обрабатывается так же, как https (сравнение по хосту),
 * поэтому self-hosted `git@gitlab.example.com:files-web.git` → gitlab.
 *
 * Второй аргумент — web-URL MR/PR. Он нужен для self-hosted Bitbucket: хост
 * вроде `b.yadro.com` ни в имени не содержит 'bitbucket', ни пути `/scm/`
 * (клон — `/scm/kos/x.git`, а страница PR — `/projects/KOS/repos/x/pull-requests/1`),
 * поэтому по одному только URL репозитория такие инсталляции не опознать.
 */
export function detectGitHost(
  repositoryUrl: string,
  mrUrl = '',
): 'gitlab' | 'github' | 'bitbucket' {
  const host = hostOf(repositoryUrl);
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  // Web-форма PR сама по себе опознаёт self-hosted Bitbucket: у хоста нет
  // узнаваемого имени, а клон и страница PR выглядят по-разному.
  const isBitbucketPrPath = (url: string) =>
    /\/projects\/[^/]+\/repos\/[^/]+\/pull-requests\//.test(
      bitbucketPullPath(url),
    );
  if (
    host.includes('bitbucket') ||
    host.includes('stash') ||
    /\/scm\//.test(repositoryUrl) ||
    isBitbucketPrPath(repositoryUrl) ||
    isBitbucketPrPath(mrUrl)
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

  /** Обновления открытого MR: тесты сверяют запись вызовов. */
  readonly updateCalls: MrUpdateInput[] = [];
  private pendingUpdateError: Error | null = null;

  /** Следующий `updateMr` отклонится этой ошибкой (путь best-effort). */
  failNextUpdateWith(err: Error): void {
    this.pendingUpdateError = err;
  }

  async updateMr(input: MrUpdateInput): Promise<void> {
    // Попытка записывается до броска: тесты должны видеть, что движок
    // обращался к API, даже когда сам вызов отклонён.
    this.updateCalls.push(input);
    if (this.pendingUpdateError) {
      const err = this.pendingUpdateError;
      this.pendingUpdateError = null;
      throw err;
    }
  }

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    this.calls.push(input);
    const id = `mr-${this.calls.length}`;
    // Формы web-URL как в реальном API (см. links.self в ответах Bitbucket/GitHub).
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

interface BitbucketPrResponse {
  id: number;
  links?: { self?: Array<{ href?: string }> };
}

/**
 * Web-путь Pull Request в Bitbucket Server — `/browse/projects/...` или
 * `/dashboard/projects/...` зависят от того, как пользователь зашёл в PR
 * (ссылка из письма, из дашборда, из списка). Хост и REST-путь от этого не
 * меняются, поэтому для парсинга и конструирования URL нормализуем префикс:
 * ищем `/projects/{PROJECT}/repos/{REPO}/pull-requests/{ID}` в любом месте URL.
 */
function bitbucketPullPath(mrUrl: string): string {
  try {
    return new URL(mrUrl.trim()).pathname;
  } catch {
    return mrUrl;
  }
}

/**
 * `{project}/{repo}/{id}` из web-URL PR (см. `bitbucketPullPath`). Бросает
 * ошибку с списком подходящих форм — ссылка сохранена в `result.json`, и без
 * неё не понять, какая именно форма была на этот раз.
 */
function bitbucketProjectRepoFromMrUrl(mrUrl: string): {
  project: string;
  repo: string;
  id: string;
} {
  const path = bitbucketPullPath(mrUrl);
  const match =
    /\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?=\/|$)/.exec(
      path,
    );
  if (!match) {
    throw new Error(
      `cannot parse bitbucket pr url: ${mrUrl} — expected "projects/<PROJECT>/repos/<REPO>/pull-requests/<ID>" anywhere in the path`,
    );
  }
  return { project: match[1], repo: match[2], id: match[3] };
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
    // Источник истины — URL репозитория из того же артефакта: web-ссылка PR
    // на self-hosted Bitbucket (`b.yadro.com/projects/...`) не содержит ни
    // 'bitbucket' в хосте, ни `/scm/` в пути, и по ней одной хост не опознать.
    const source = detectGitHost(input.repositoryUrl || input.mrUrl, input.mrUrl);
    const token = input.token || this.tokens[source] || this.token;

    if (source === 'github') {
      return this.fetchGitHubComments(input.mrUrl, token, input.repositoryUrl);
    }
    if (source === 'gitlab') {
      return this.fetchGitLabComments(input.mrUrl, token, input.repositoryUrl);
    }
    // Bitbucket: comments API
    return this.fetchBitbucketComments(input.mrUrl, token, input.repositoryUrl);
  }

  async findOpenMr(input: MrFindInput): Promise<MrCreateResult | null> {
    const token = input.token || this.tokens[input.source] || this.token;

    if (input.source === 'gitlab') {
      return this.findGitLabOpenMr(input, token);
    }
    if (input.source === 'github') {
      return this.findGitHubOpenMr(input, token);
    }
    // Bitbucket: Cloud (`bitbucket.org`, API 2.0) и Server/DC (REST 1.0) —
    // разные пути и разные фильтры «открытого PR по веткам».
    if (isBitbucketCloudHost(hostOf(input.repositoryUrl))) {
      return this.findBitbucketCloudOpenMr(input, token);
    }
    return this.findBitbucketServerOpenMr(input, token);
  }

  private async findBitbucketCloudOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const { project: workspace, repo } = bitbucketProjectRepo(
      input.repositoryUrl,
    );
    // У Cloud нет фильтра по парам веток в query — листаем OPEN и сверяем
    // `source.branch.name`/`destination.branch.name` на клиенте.
    const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests?state=OPEN&pagelen=${MR_PAGE_SIZE}`;
    const values = await this.collectPagedValues<{
      id?: number;
      html_url?: string;
      source?: { branch?: { name?: string } };
      destination?: { branch?: { name?: string } };
    }>(url, { Authorization: `Bearer ${token}`, Accept: 'application/json' }, 'bitbucket pr list');
    const match = values.find(
      (pr) =>
        pr.source?.branch?.name === input.headBranch &&
        pr.destination?.branch?.name === input.baseBranch,
    );
    if (!match || match.id === undefined) return null;
    return {
      mrUrl: bitbucketCloudMrWebUrl(match.html_url, workspace, repo, String(match.id)),
      id: String(match.id),
    };
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

  private async findBitbucketServerOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    // `at` в Bitbucket Server фильтрует по TARGET-ветке, а не source.
    // direction=OUTGOING + at=refs/heads/<base> возвращает PR из этого репо
    // в base-ветку; фильтруем by fromRef.id на клиенте.
    const res = await fetch(
      `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests?direction=OUTGOING&at=refs/heads/${encodeURIComponent(input.baseBranch)}&state=OPEN`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      values?: Array<{
        id: number;
        fromRef?: { id?: string };
        links?: { self?: Array<{ href?: string }> };
      }>;
    };
    if (!data.values || data.values.length === 0) return null;
    const match = data.values.find(
      (pr) => pr.fromRef?.id === `refs/heads/${input.headBranch}`,
    );
    if (!match) return null;
    // REST-объект PR несёт `links.self` — canonical web-URL сервера (с
    // contextPath и портом). Собираем URL сами только как fallback.
    return {
      mrUrl: bitbucketMrWebUrl(
        host,
        project,
        repo,
        String(match.id),
        match.links,
      ),
      id: String(match.id),
    };
  }

  private async fetchGitHubComments(
    mrUrl: string,
    token: string,
    repositoryUrl?: string,
  ): Promise<MrComment[]> {
    const { owner, repo, number, host } = githubPullParts(mrUrl, repositoryUrl);
    const apiBase =
      host === 'github.com'
        ? 'https://api.github.com'
        : `https://${host}/api/v3`;

    // Собираем review comments (на дифф) + issue comments (общие). Обе
    // выборки — постранично: без `per_page` GitHub отдаёт 30 комментариев,
    // и всё сверх первой страницы в ревью не попадало.
    const all: MrComment[] = [];
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };

    // Review comments (привязаны к файлу/строке). Сбой — ошибка, а не пустой
    // список: молчаливый `if (res.ok)` превращал 404/500 в «коментариев нет,
    // код чист».
    const reviewData = await this.collectArrayPages<{
      path?: string;
      line?: number;
      body?: string;
      user?: { login?: string };
      created_at?: string;
    }>(
      `${apiBase}/repos/${owner}/${repo}/pulls/${number}/comments?per_page=${MR_PAGE_SIZE}&page=1`,
      headers,
      'github review comments',
    );
    for (const c of reviewData) {
      all.push({
        file: c.path ?? null,
        line: typeof c.line === 'number' ? c.line : null,
        body: c.body ?? '',
        author: c.user?.login ?? 'unknown',
        created_at: c.created_at ?? '',
      });
    }

    // Issue comments (общие, без привязки к файлу)
    const issueData = await this.collectArrayPages<{
      body?: string;
      user?: { login?: string };
      created_at?: string;
    }>(
      `${apiBase}/repos/${owner}/${repo}/issues/${number}/comments?per_page=${MR_PAGE_SIZE}&page=1`,
      headers,
      'github issue comments',
    );
    for (const c of issueData) {
      all.push({
        file: null,
        line: null,
        body: c.body ?? '',
        author: c.user?.login ?? 'unknown',
        created_at: c.created_at ?? '',
      });
    }

    return all;
  }

  private async fetchGitLabComments(
    mrUrl: string,
    token: string,
    repositoryUrl?: string,
  ): Promise<MrComment[]> {
    // mrUrl: https://gitlab.com/group/project/-/merge_requests/IID
    // или https://gitlab.example.com/group/project/-/merge_requests/IID
    const host = hostOf(repositoryUrl || mrUrl);
    const path = pathOfMrUrl(mrUrl);
    const full = /\/([^/]+(?:\/[^/]+)*)\/-\/merge_requests\/(\d+)/.exec(path);
    let projectPath: string | null = full ? full[1] : null;
    let iid: string | undefined = full?.[2];
    // Битая/усечённая ссылка без `/-/`: iid берём из пути, путь проекта — из
    // URL репозитория задачи.
    if (!projectPath && repositoryUrl) {
      const bare = /\/merge_requests\/(\d+)/.exec(path)?.[1];
      if (bare) {
        projectPath = gitlabProjectPath(repositoryUrl);
        iid = bare;
      }
    }
    if (!projectPath || !iid) {
      throw new Error(
        `cannot parse gitlab mr url: ${mrUrl} — ожидается https://{host}/{group}/{project}/-/merge_requests/{iid}`,
      );
    }
    // Страницы по `per_page=100`: без параметра GitLab отдаёт 20 заметок, и
    // длинное обсуждение обрезалось. `sort=asc` — хронологический порядок.
    const data = await this.collectArrayPages<{
      body?: string;
      author?: { name?: string };
      created_at?: string;
      position?: { new_path?: string; new_line?: number };
      system?: boolean;
    }>(
      `https://${host}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/notes?sort=asc&per_page=${MR_PAGE_SIZE}&page=1`,
      { 'PRIVATE-TOKEN': token },
      'gitlab notes',
    );

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

  /**
   * Постраничный обход Bitbucket-ответов `{values, ...}`. Server листает
   * `?start=` по `isLastPage`/`nextPageStart`, Cloud — по абсолютному `next` с
   * курсором; обе формы обрабатываются здесь, чтобы ни одна страница не
   * потерялась. Капп — `MR_MAX_PAGES`; если он исчерпан, а продолжение есть,
   * это ошибка, а не молчаливый partial: «потерянная половина ревью» выглядит
   * как «ревью чистое».
   */
  private async collectPagedValues<T>(
    firstUrl: string,
    headers: Record<string, string>,
    label: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let pageUrl: string | null = firstUrl;
    for (let page = 0; page < MR_MAX_PAGES && pageUrl !== null; page++) {
      const res = await fetch(pageUrl, { headers });
      if (!res.ok) {
        throw new Error(
          `${label} failed: ${res.status} — GET ${apiPathOf(pageUrl)}`,
        );
      }
      const data = (await res.json()) as {
        values?: T[];
        isLastPage?: boolean;
        nextPageStart?: number;
        next?: string;
      };
      out.push(...(data.values ?? []));
      if (data.next) {
        pageUrl = data.next;
      } else if (data.isLastPage === false) {
        const start = data.nextPageStart ?? out.length;
        pageUrl = setStartParam(pageUrl, label, start);
      } else {
        pageUrl = null;
      }
    }
    if (pageUrl !== null) {
      throw new Error(
        `${label}: pagination cap (${MR_MAX_PAGES} pages) reached at ${apiPathOf(firstUrl)} — часть комментариев могла не прийти`,
      );
    }
    return out;
  }

  /**
   * То же для GitHub/GitLab: страница там — просто массив тел, поэтому
   * признак «есть ещё» — заполненный `per_page`. Идём до неполной страницы.
   */
  private async collectArrayPages<T>(
    firstUrl: string,
    headers: Record<string, string>,
    label: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let pageUrl: string | null = firstUrl;
    for (let page = 0; page < MR_MAX_PAGES && pageUrl !== null; page++) {
      const res = await fetch(pageUrl, { headers });
      if (!res.ok) {
        throw new Error(
          `${label} failed: ${res.status} — GET ${apiPathOf(pageUrl)}`,
        );
      }
      const batch = (await res.json()) as T[];
      out.push(...batch);
      if (batch.length >= MR_PAGE_SIZE) {
        pageUrl = nextPageParam(pageUrl, label);
      } else {
        pageUrl = null;
      }
    }
    if (pageUrl !== null) {
      throw new Error(
        `${label}: pagination cap (${MR_MAX_PAGES} pages) reached at ${apiPathOf(firstUrl)} — часть комментариев могла не прийти`,
      );
    }
    return out;
  }

  /**
   * `{project, repo, id}` из web-URL PR. Ссылки старой версии safety-net'а
   * потеряли project-ключ (`/projects/repos/x/pull-requests/1`) — если URL не
   * разбирается, ключи берём из `repositoryUrl` задачи, PR-номер остаётся тот же.
   */
  private bitbucketPartsOfMrUrl(
    mrUrl: string,
    repositoryUrl?: string,
  ): { project: string; repo: string; id: string } {
    try {
      return bitbucketProjectRepoFromMrUrl(mrUrl);
    } catch (error) {
      const id = /\/pull-requests\/(\d+)/.exec(bitbucketPullPath(mrUrl))?.[1];
      if (repositoryUrl && id) {
        const { project, repo } = bitbucketProjectRepo(repositoryUrl);
        return { project, repo, id };
      }
      throw error;
    }
  }

  private async fetchBitbucketComments(
    mrUrl: string,
    token: string,
    repositoryUrl?: string,
  ): Promise<MrComment[]> {
    // Any Bitbucket Server web URL: https://host/<prefix>/projects/PROJECT/
    // repos/REPO/pull-requests/ID[/...]. The prefix (`browse`, `dashboard`, …)
    // and everything after the ID (`/activity`, `/comments`) are irrelevant to
    // the REST path, so parse them away instead of requiring one exact shape.
    const { project, repo, id } = this.bitbucketPartsOfMrUrl(
      mrUrl,
      repositoryUrl,
    );
    const host = hostOf(repositoryUrl || mrUrl);
    // `bitbucket.org` — Cloud с API 2.0 (другие пути, другая пагинация, другой
    // формат комментария). `repo-resolver` Cloud/Server различает, клиент обязан.
    if (isBitbucketCloudHost(host)) {
      return this.fetchBitbucketCloudComments(mrUrl, token, repositoryUrl);
    }
    // Project/repo keys come from the URL path and may be percent-encoded
    // (`~` in personal project keys is legal as-is, spaces are not).
    //
    // Эндпоинт — `/activities`, НЕ `/comments`: Bitbucket Server 8.9 отдаёт на
    // `GET .../pull-requests/{id}/comments` 400 «The path query parameter is
    // required when retrieving comments» — там комментарии читаются только по
    // конкретному файлу. Через activity проходят все комментарии PR: и общие,
    // и привязанные к строке (проверено на b.yadro.com, PR 218).
    const apiPath = `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${id}/activities`;

    // Server отдаёт страницы по 25 (потолок `limit` — 500). Без обхода
    // `nextPageStart` в длинном обсуждении терялись бы все комментарии после
    // первой страницы.
    //
    // Формы привязки к диффу в REST Bitbucket различаются: в `/activities`
    // строка лежит в `anchors.line`, в `/comments?path=` — плоским `anchor`.
    // Живого COMMENT-события в этом Bitbucket найти не удалось (40 PR × 4
    // репо — ни одного), поэтому читаем обе формы вместо ставки на одну.
    type Anchor = {
      path?: string;
      line?: number;
      lineSrc?: number;
      lineTgt?: number;
    };
    type RawComment = {
      text?: string;
      author?: { name?: string };
      createdDate?: number | string;
      pending?: boolean;
      anchors?: { line?: Anchor } | null;
      anchor?: Anchor | null;
    };
    type RawActivity = RawComment & {
      action?: string;
      commentAction?: string;
      comment?: RawComment;
    };
    const activities = await this.collectPagedValues<RawActivity>(
      `https://${host}${apiPath}?limit=500&start=0`,
      { Authorization: `Bearer ${token}` },
      'bitbucket comments',
    );

    const comments: MrComment[] = [];
    for (const a of activities) {
      // Только комментарии: удалённые и ещё не опубликованные черновики в
      // ревью не нужны.
      if (a.action !== 'COMMENT' || a.commentAction === 'DELETED') {
        continue;
      }
      // Комментарий вложен в `comment`, но отдельные версии кладут поля прямо
      // в событие.
      const c: RawComment = a.comment ?? a;
      if (c.pending === true) continue;
      const anchor = c.anchors?.line ?? c.anchor;
      comments.push({
        file: anchor?.path ?? null,
        line: anchor?.line ?? anchor?.lineTgt ?? anchor?.lineSrc ?? null,
        body: c.text ?? '',
        author: c.author?.name ?? 'unknown',
        created_at: isoDateOf(c.createdDate),
      });
    }
    return comments;
  }

  /**
   * Bitbucket Cloud (`bitbucket.org`), API 2.0. комментарий там лежит в
   * `content.raw`, привязка к диффу — в `inline:{path,from,to}`, пагинация —
   * курсор в `next`. `deleted`/`pending` — непустые объекты, когда комментарий
   * удалён или ещё не опубликован: в ревью их нет.
   */
  private async fetchBitbucketCloudComments(
    mrUrl: string,
    token: string,
    repositoryUrl?: string,
  ): Promise<MrComment[]> {
    const { workspace, repo, id } = bitbucketCloudParts(mrUrl, repositoryUrl);
    const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${id}/comments?pagelen=${MR_PAGE_SIZE}`;
    type RawCloudComment = {
      content?: { raw?: string; markup?: string };
      user?: { display_name?: string; account?: string };
      created_on?: string;
      inline?: { path?: string; from?: number; to?: number } | null;
      deleted?: unknown;
      pending?: unknown;
    };
    const raw = await this.collectPagedValues<RawCloudComment>(
      url,
      { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      'bitbucket comments',
    );
    const comments: MrComment[] = [];
    for (const c of raw) {
      if (c.deleted || c.pending) continue;
      comments.push({
        file: c.inline?.path ?? null,
        line: c.inline?.to ?? c.inline?.from ?? null,
        body: c.content?.raw ?? c.content?.markup ?? '',
        author: c.user?.display_name ?? c.user?.account ?? 'unknown',
        created_at: c.created_on ?? '',
      });
    }
    return comments;
  }

  /**
   * Обновить title/description открытого MR. Bitbucket Server требует
   * оптимистичную блокировку (`version`), поэтому для него сначала читается
   * текущая версия PR, затем PUT. Ошибка — reject: вызывающий слой решает,
   * насколько она критична (для движка это best-effort).
   */
  async updateMr(input: MrUpdateInput): Promise<void> {
    const token = input.token || this.tokens[input.source] || this.token;

    if (input.source === 'gitlab') {
      const path = gitlabProjectPath(input.repositoryUrl);
      const host = hostOf(input.repositoryUrl);
      const response = await fetch(
        `https://${host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests/${encodeURIComponent(input.mrId)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': token,
          },
          body: JSON.stringify({
            title: input.title,
            description: input.description,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`gitlab mr update failed: ${response.status}`);
      }
      return;
    }

    if (input.source === 'github') {
      const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
      const host = hostOf(input.repositoryUrl);
      const apiBase =
        host === 'github.com'
          ? 'https://api.github.com'
          : `https://${host}/api/v3`;
      const response = await fetch(
        `${apiBase}/repos/${owner}/${repo}/pulls/${encodeURIComponent(input.mrId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            title: input.title,
            body: input.description,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`github pr update failed: ${response.status}`);
      }
      return;
    }

    // Bitbucket Cloud и Server/DC живут на разных API; ниже — Server/DC.
    if (isBitbucketCloudHost(hostOf(input.repositoryUrl))) {
      return this.updateBitbucketCloudMr(input, token);
    }

    // Bitbucket Server: PUT без `version` отвечает 409 VERSION_CONFLICT.
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const apiBase = `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${encodeURIComponent(input.mrId)}`;
    const current = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!current.ok) {
      throw new Error(`bitbucket pr read failed: ${current.status}`);
    }
    const { version } = (await current.json()) as { version?: number };
    const response = await fetch(apiBase, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        version,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '(body unavailable)');
      throw new Error(
        `bitbucket pr update failed: ${response.status} — ${body.slice(0, 500)}`,
      );
    }
  }

  /**
   * Cloud: `PUT /2.0/repositories/{ws}/{repo}/pullrequests/{id}` с `{title,
   * summary}` — оптимистичная блокировка `version` как у Server не нужна.
   */
  private async updateBitbucketCloudMr(
    input: MrUpdateInput,
    token: string,
  ): Promise<void> {
    const { project: workspace, repo } = bitbucketProjectRepo(
      input.repositoryUrl,
    );
    const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${encodeURIComponent(input.mrId)}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({ title: input.title, summary: input.description }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '(body unavailable)');
      throw new Error(
        `bitbucket cloud pr update failed: ${response.status} — PUT ${apiPathOf(url)} — ${body.slice(0, 500)}`,
      );
    }
  }

  /**
   * Cloud: `POST /2.0/repositories/{ws}/{repo}/pullrequests`. В отличие от
   * Server, дубликат здесь — не 409, а 400 с текстом «A pull request already
   * exists», поэтому его разрешаем так же: ищем открытый PR по паре веток.
   */
  private async createBitbucketCloudMr(
    input: MrCreateInput,
    token: string,
  ): Promise<MrCreateResult> {
    const { project: workspace, repo } = bitbucketProjectRepo(
      input.repositoryUrl,
    );
    const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        title: input.title,
        summary: input.description,
        source: {
          branch: { name: input.headBranch },
          repository: { full_name: `${workspace}/${repo}` },
        },
        destination: { branch: { name: input.baseBranch } },
      }),
    });
    // Тело ответа читается ровно один раз: `text()` до `json()` на успехе
    // дало бы «body already consumed».
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 409 || /already exists/i.test(body)) {
        const existing = await this.findBitbucketCloudOpenMr(input, token);
        if (existing) return existing;
      }
      throw new Error(
        `bitbucket cloud pr failed: ${response.status} — POST ${apiPathOf(url)} — ${body.slice(0, 500)}`,
      );
    }
    const data = (await response.json()) as {
      id?: number;
      html_url?: string;
    };
    const id = String(data.id ?? '');
    return {
      mrUrl: bitbucketCloudMrWebUrl(data.html_url, workspace, repo, id),
      id,
    };
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
        const body = await response.text().catch(() => '(body unavailable)');
        throw new Error(
          `gitlab mr failed: ${response.status} — POST /projects/${encodeURIComponent(path)}/merge_requests — ${body.slice(0, 500)}`,
        );
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
      const response = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls`, {
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
      });
      if (!response.ok) {
        // The body carries GitHub's reason ("No commits between …", "Bad
        // credentials") — without it a 422 is a number nobody can act on.
        const body = await response.text().catch(() => '(body unavailable)');
        throw new Error(
          `github pr failed: ${response.status} — POST /repos/${owner}/${repo}/pulls — ${body.slice(0, 500)}`,
        );
      }
      const data = (await response.json()) as GitHubPrResponse;
      return { mrUrl: data.html_url, id: String(data.number) };
    }

    // Bitbucket: Cloud (`bitbucket.org`, API 2.0) или Server/Stash (REST 1.0).
    if (isBitbucketCloudHost(hostOf(input.repositoryUrl))) {
      return this.createBitbucketCloudMr(input, token);
    }

    // Bitbucket Server/Stash: project/repo — из пути `/scm/{project}/{repo}`.
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const createPath = `/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests`;
    const response = await fetch(`https://${host}${createPath}`, {
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
    });
    if (response.status === 409) {
      // DuplicatePullRequestException: PR из этих refs уже открыт (findOpenMr
      // его не нашёл — гонка или фильтр). Это не ошибка публикации: разрешаем
      // существующий PR здесь, а не в вызывающем коде. Форма web-URL —
      // ответственность клиента; ручная склейка её в движке как раз и съела
      // однажды project-ключ.
      const existing = await this.resolveBitbucketDuplicate(
        input,
        token,
        response,
      );
      if (existing) return existing;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '(body unavailable)');
      throw new Error(
        `bitbucket pr failed: ${response.status} — POST ${createPath} — ${body.slice(0, 500)}`,
      );
    }
    const data = (await response.json()) as BitbucketPrResponse;
    return {
      mrUrl: bitbucketMrWebUrl(
        host,
        project,
        repo,
        String(data.id),
        data.links,
      ),
      id: String(data.id),
    };
  }

  /**
   * Найти PR, о котором сообщает 409: сначала по пару refs (тот же запрос, что
   * и `findOpenMr`), затем по id из тела ошибки (`existingPullRequest.id`).
   * Возвращает null, если ничего не нашли — вызывающий путь бросит исходную
   * ошибку с полным телом.
   */
  private async resolveBitbucketDuplicate(
    input: MrCreateInput,
    token: string,
    response: Response,
  ): Promise<MrCreateResult | null> {
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const base = `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests`;

    const open = await this.findBitbucketServerOpenMr(input, token);
    if (open) return open;

    const body = await response.text().catch(() => '');
    const idFromError =
      /"existingPullRequest"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/i.exec(body)?.[1] ??
      /"pullRequestId"\s*:\s*(\d+)/i.exec(body)?.[1];
    if (!idFromError) return null;

    // Читаем PR через REST ради canonical links.self — его id из текста ошибки
    // может и не совпадать с id в пути.
    const pr = await fetch(`${base}/${idFromError}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (pr?.ok) {
      const data = (await pr.json()) as BitbucketPrResponse;
      const id = String(data.id ?? idFromError);
      return {
        mrUrl: bitbucketMrWebUrl(host, project, repo, id, data.links),
        id,
      };
    }
    return {
      mrUrl: bitbucketMrWebUrl(host, project, repo, idFromError),
      id: idFromError,
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
function githubOwnerRepo(repositoryUrl: string): {
  owner: string;
  repo: string;
} {
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

/**
 * epoch-миллисекунды Bitbucket → ISO-строка. Число приходит и в `createdDate`,
 * и в `lastModified`; строку оставляем как есть, пустое — пустая строка.
 */function isoDateOf(value: number | string | undefined): string {
  if (value === undefined || value === '') return '';
  if (typeof value === 'string' && !/^\d+$/.test(value)) return value;
  const ms = Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

/** pathname web-ссылки без origin/хвостов — по нему разбирают PR все клиенты. */
function pathOfMrUrl(mrUrl: string): string {
  try {
    return new URL(mrUrl).pathname;
  } catch {
    return mrUrl;
  }
}

/**
 * `{owner}/{repo}` и номер PR из web-ссылки. Разбор был привязан к
 * `github.com`, поэтому GitHub Enterprise (`github.example.com/o/r/pull/1`)
 * не разбирался вовсе — форма пути у обоих одна и та же. Если ссылка битая,
 * owner/repo берём из `repositoryUrl` задачи.
 */
function githubPullParts(
  mrUrl: string,
  repositoryUrl?: string,
): { owner: string; repo: string; number: string; host: string } {
  const host = hostOf(repositoryUrl || mrUrl);
  const path = pathOfMrUrl(mrUrl);
  const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(path);
  if (match) {
    return {
      owner: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2]).replace(/\.git$/, ''),
      number: match[3],
      host,
    };
  }
  const number = /\/pull\/(\d+)/.exec(path)?.[1];
  if (repositoryUrl && number) {
    const { owner, repo } = githubOwnerRepo(repositoryUrl);
    return { owner, repo, number, host };
  }
  throw new Error(
    `cannot parse github pr url: ${mrUrl} — ожидается https://{host}/{owner}/{repo}/pull/{number}`,
  );
}

/**
 * Web-URL PR: серверный `links.self` предпочтителен (он содержит contextPath
 * и порт, которые невозможно вывести из репозитория), наша сборка — fallback.
 * Форма — `/projects/{PROJECT}/repos/{REPO}/pull-requests/{id}`: ровно её
 * отдаёт сам Bitbucket в `links.self` (проверено на b.yadro.com, PR 218).
 */
function bitbucketMrWebUrl(
  host: string,
  project: string,
  repo: string,
  id: string,
  links?: BitbucketPrResponse['links'],
): string {
  const self = links?.self?.find((link) => link.href)?.href;
  if (self) return self;
  return `https://${host}/projects/${project}/repos/${repo}/pull-requests/${id}`;
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

/**
 * Размер страницы для API, где страница — массив тел (GitHub/GitLab `per_page`,
 * Cloud `pagelen`). 100 — потолок и там, и там; раньше запрос шел без
 * параметра, то есть по 20 (GitLab) / 30 (GitHub) заметок, и всё сверх первой
 * страницы в ревью не попадало.
 */
const MR_PAGE_SIZE = 100;

/** Капп страниц: защита от сервера, зацикливающегося на одной и той же странице. */
const MR_MAX_PAGES = 50;

/** Bitbucket Cloud (`bitbucket.org`) — API 2.0, не Server/DC REST 1.0. */
const BITBUCKET_CLOUD_API = 'https://api.bitbucket.org/2.0';

/**
 * Публичное облако Bitbucket отличается от Server/Data Center путями REST и
 * формой ответов, поэтому различать их обязан и MR-клиент (в `repo-resolver`
 * есть те же `isBitbucketCloudHost`/`BitbucketCloudResolver`).
 */
function isBitbucketCloudHost(host: string): boolean {
  return host === 'bitbucket.org';
}

/** pathname+search без origin — чтобы в тексте ошибки был видно, куда ходили. */
function apiPathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * Следующая страница Server-пагинации (`?start=`) и page-based API
 * (`?page=N+1`). Не разобран URL — явная ошибка с меткой, а не молчаливый
 * повтор первой страницы.
 */
function setStartParam(url: string, label: string, start: number): string {
  const u = parsePageUrl(url, label);
  u.searchParams.set('start', String(start));
  return u.toString();
}

function nextPageParam(url: string, label: string): string {
  const u = parsePageUrl(url, label);
  const page = Number(u.searchParams.get('page') ?? '1');
  u.searchParams.set('page', String((Number.isFinite(page) ? page : 1) + 1));
  return u.toString();
}

function parsePageUrl(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${label}: не разобран URL следующей страницы — ${url}`);
  }
}

/**
 * `{workspace}/{repo}` и номер PR из Cloud-ссылки
 * `https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}`. Если ссылка
 * битая — ключи берём из `repositoryUrl` (тот же приём, что для Server).
 */
function bitbucketCloudParts(
  mrUrl: string,
  repositoryUrl?: string,
): { workspace: string; repo: string; id: string } {
  const match = /\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(mrUrl);
  if (match) {
    return {
      workspace: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2]).replace(/\.git$/, ''),
      id: match[3],
    };
  }
  const id = /\/pull-requests\/(\d+)/.exec(mrUrl)?.[1];
  if (repositoryUrl && id) {
    const { project, repo } = bitbucketProjectRepo(repositoryUrl);
    return { workspace: project, repo, id };
  }
  throw new Error(
    `cannot parse bitbucket cloud pr url: ${mrUrl} — ожидается https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}`,
  );
}

/** Web-URL Cloud PR: серверный `html_url` надёжнее нашей сборки. */
function bitbucketCloudMrWebUrl(
  htmlUrl: string | undefined,
  workspace: string,
  repo: string,
  id: string,
): string {
  return (
    htmlUrl ??
    `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pull-requests/${id}`
  );
}
