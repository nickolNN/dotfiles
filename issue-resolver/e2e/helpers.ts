/**
 * Общие helpers для edge-case e2e-тестов (`tests/edge-cases/*`).
 *
 * Edge-case-сценарии (пустое состояние, два одновременных issue,
 * переподключение SSE, bootstrap-прогресс по двум репозиториям) должны быть
 * детерминированными, поэтому API и SSE перехватываются Playwright'ом поверх
 * мок-стека (`playwright.config.ts` → `backend/test/e2e-server.ts`). Реальные
 * Docker/git/pi/сеть не используются; `tests/flow.spec.ts` идёт через
 * vite-прокси на тот же мок-бэкенд.
 *
 * Все пути — относительно Vite-origin (`baseURL: http://localhost:5196`),
 * фронт ходит в `'/issue-resolver/api/v1'`.
 */
import { expect, type Page, type Route } from '@playwright/test';

export const API_PREFIX = '/issue-resolver/api/v1';

// --- локальные duck-typed копии shared-типов (e2e не зависит от shared) ---

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'preparing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'question';

export type PipelineStep = 'refine' | 'resolve' | 'review' | 'test' | 'pr';
export type DesiredResult = 'md' | 'html' | 'pr';
export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'needs_input'
  | 'skipped'
  | 'aborted';

export interface FakeRepo {
  id: string;
  url: string;
  platform: string | null;
  fullName: string | null;
  defaultBranch: string | null;
  cloneUrl: string | null;
  language: string | null;
  description: string | null;
  isPrivate: boolean | null;
  connectionStatus: 'ok' | 'error' | 'unknown';
  lastValidatedAt: string | null;
  runInstructions: string | null;
  runInstructionsStatus: 'unknown' | 'generated' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface FakeIssue {
  id: string;
  title: string;
  jira_issue_url: string | null;
  source?: string | null;
  description?: string;
  desired_result?: DesiredResult;
  repositories: Array<{
    id: string;
    repository_url: string;
    branch_name: string;
    create_mr: boolean;
    bootstrap_enabled: boolean;
    created_at: string;
    updated_at: string;
  }>;
  pipeline_steps: PipelineStep[];
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  workspace_missing?: boolean;
}

export interface FakeIteration {
  id: string;
  issue_id: string;
  number: number;
  context: string;
  review_context: string;
  is_review_need: boolean;
  steps: PipelineStep[];
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface FakeStepRun {
  id: string;
  iteration_id: string;
  step: PipelineStep;
  attempt: number;
  status: StepRunStatus;
  context: string;
  feedback: string | null;
  created_at: string;
  updated_at: string;
  stdout: string;
  stderr: string;
  events: unknown[];
  stats: null;
  report: string | null;
  screenshots_dir: string | null;
}

/** SSE-кадр — форма `SSEEvent` из shared. */
export interface FakeSseEvent {
  type:
    | 'log'
    | 'step_status'
    | 'step_event'
    | 'iteration_status'
    | 'workspace_progress'
    | 'bootstrap_log';
  issueId: string;
  iterationId?: string;
  stepRunId?: string;
  stream?: 'stdout' | 'stderr' | 'rpc' | 'mr' | 'system';
  data: string;
  ts: string;
}

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Date.now().toString(36)}`;
}
const now = (): string => new Date().toISOString();

/**
 * Управляемый in-memory бэкенд. `install(page)` вешает один catch-all роут
 * на `**\/issue-resolver/api/v1/**`; всё, что не описано явно, отдаёт 404
 * `{ error }` (фронт такие ответы либо глушит, либо показывает ожидаемо).
 */
export class FakeApi {
  repos: FakeRepo[] = [];
  issues: FakeIssue[] = [];
  iterations = new Map<string, FakeIteration[]>();
  stepRuns = new Map<string, FakeStepRun[]>();
  /** HTML-артефакт по issueId (для `desired_result: 'html'`). */
  resultHtml = new Map<string, string>();
  /** Markdown-артефакт по issueId. */
  resultMd = new Map<string, string>();

  private sseQueue = new Map<string, FakeSseEvent[]>();
  private sseDelivered = new Set<string>();
  /** issueId, для которых SSE-соединение «порвано» (эмуляция падения backend). */
  sseDown = new Set<string>();
  /** История запросов `METHOD path` — удобно для ассертов. */
  requests: string[] = [];

  // ---------------- фабрики данных ----------------

  addRepo(input: Partial<FakeRepo> & { url: string }): FakeRepo {
    const derivedName = input.url
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/\.git$/, '');
    const repo: FakeRepo = {
      id: uid('repo'),
      platform: 'github',
      fullName: derivedName || 'acme/repo',
      defaultBranch: 'main',
      cloneUrl: `${input.url.replace(/\.git$/, '')}.git`,
      language: null,
      description: null,
      isPrivate: false,
      connectionStatus: 'ok',
      lastValidatedAt: now(),
      runInstructions: null,
      runInstructionsStatus: 'unknown',
      createdAt: now(),
      updatedAt: now(),
      ...input,
      url: input.url,
    };
    this.repos.push(repo);
    return repo;
  }

  /**
   * Сеет задачу. По умолчанию сразу создаёт итерацию #1 — так карточка
   * детали рисуется полноценно (кнопка «Повторить» и т.п.).
   */
  addIssue(
    input: Partial<FakeIssue> & { title: string },
  ): { issue: FakeIssue; iteration: FakeIteration } {
    const issue: FakeIssue = {
      id: uid('issue'),
      jira_issue_url: null,
      desired_result: 'md',
      repositories: [],
      pipeline_steps: ['refine', 'resolve'],
      status: 'preparing',
      created_at: now(),
      updated_at: now(),
      ...input,
      title: input.title,
    };
    this.issues.push(issue);
    const iteration = this.addIteration(issue.id, {
      number: 1,
      status: input.status ?? 'preparing',
      steps: issue.pipeline_steps,
    });
    return { issue, iteration };
  }

  addIteration(
    issueId: string,
    input: Partial<FakeIteration> = {},
  ): FakeIteration {
    const list = this.iterations.get(issueId) ?? [];
    const iteration: FakeIteration = {
      id: uid('iter'),
      issue_id: issueId,
      number: list.length + 1,
      context: '',
      review_context: '',
      is_review_need: false,
      steps: ['refine', 'resolve'],
      status: 'pending',
      created_at: now(),
      updated_at: now(),
      ...input,
    };
    list.push(iteration);
    this.iterations.set(issueId, list);
    return iteration;
  }

  addStepRun(
    iterationId: string,
    input: Partial<FakeStepRun> & { step: PipelineStep },
  ): FakeStepRun {
    const list = this.stepRuns.get(iterationId) ?? [];
    const run: FakeStepRun = {
      id: uid('run'),
      iteration_id: iterationId,
      attempt: 1,
      status: 'success',
      context: '',
      feedback: null,
      created_at: now(),
      updated_at: now(),
      stdout: '',
      stderr: '',
      events: [],
      stats: null,
      report: JSON.stringify({ status: 'pass', summary: 'ok' }),
      screenshots_dir: null,
      ...input,
      step: input.step,
    };
    list.push(run);
    this.stepRuns.set(iterationId, list);
    return run;
  }

  /** Ставит задаче терминальный статус и её активной итерации. */
  finishIssue(issueId: string, status: TaskStatus = 'completed'): void {
    const issue = this.issues.find((item) => item.id === issueId);
    if (issue) issue.status = status;
    for (const iteration of this.iterations.get(issueId) ?? []) {
      iteration.status = status;
    }
  }

  // ---------------- SSE ----------------

  /** Очередь событий, которую получит SSE-подписчик issue. */
  setSse(
    issueId: string,
    events: Array<Omit<FakeSseEvent, 'issueId' | 'ts'>>,
  ): void {
    this.sseQueue.set(
      issueId,
      events.map((event) => ({ ...event, issueId, ts: now() })),
    );
    this.sseDelivered.delete(issueId);
  }

  pushSse(issueId: string, event: Omit<FakeSseEvent, 'issueId' | 'ts'>): void {
    const list = this.sseQueue.get(issueId) ?? [];
    list.push({ ...event, issueId, ts: now() });
    this.sseQueue.set(issueId, list);
    this.sseDelivered.delete(issueId);
  }

  /** Рвёт SSE: следующий запрос стрима падает (эмуляция «backend умер»). */
  killSse(issueId: string): void {
    this.sseDown.add(issueId);
  }

  /** «Поднимает backend»: следующий реконнект снова доставит события. */
  restartSse(issueId: string): void {
    this.sseDown.delete(issueId);
    this.sseDelivered.delete(issueId);
  }

  // ---------------- роутинг ----------------

  async install(page: Page): Promise<void> {
    await page.route(`**${API_PREFIX}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = safeUrl(request.url());
    if (!url) {
      await this.json(route, { error: 'bad request url' }, 400);
      return;
    }
    const match = url.pathname.match(
      /\/issue-resolver\/api\/v1\/(.*)$/,
    );
    const path = match ? match[1] : '';
    const segments = path.split('/').filter(Boolean);
    const method = request.method();
    this.requests.push(`${method} ${path}`);

    const body = ['POST', 'PUT', 'PATCH'].includes(method)
      ? safeJson(request.postData())
      : undefined;

    try {
      const handled = await this.route(route, segments, method, body);
      if (!handled) {
        await this.json(route, { error: `fake api: no route for ${method} ${path}` }, 404);
      }
    } catch (error) {
      await this.json(route, { error: `fake api crashed: ${String(error)}` }, 500);
    }
  }

  /** @returns true, если маршрут обработан. */
  private async route(
    route: Route,
    segments: string[],
    method: string,
    body: any,
  ): Promise<boolean> {
    const [head, id, tail, tail2] = segments;

    if (head === 'models' && method === 'GET') {
      await this.json(route, [{ id: 'user-default', name: 'Default' }]);
      return true;
    }

    if (head === 'repos' && id === 'validate' && method === 'POST') {
      const urls: string[] = Array.isArray(body?.urls) ? body.urls : [];
      await this.json(route, {
        results: urls.map((raw) => {
          const normalized = raw.replace(/\.git$/, '');
          const fullName = normalized.replace(/^https?:\/\/[^/]+\//, '');
          return {
            url: raw,
            valid: true,
            platform: 'github',
            info: {
              platform: 'github',
              fullName,
              defaultBranch: 'main',
              branches: ['main', 'develop'],
              cloneUrl: `${normalized}.git`,
              language: null,
              description: null,
              stars: 0,
              isPrivate: false,
            },
          };
        }),
      });
      return true;
    }

    if (head === 'repositories') {
      if (!id && method === 'GET') {
        await this.json(route, this.repos);
        return true;
      }
      if (!id && method === 'POST') {
        const repo = this.addRepo({
          url: String(body?.url ?? 'https://github.com/acme/repo'),
        });
        await this.json(route, repo, 201);
        return true;
      }
      const repo = this.repos.find((item) => item.id === id);
      if (repo && tail === 'branches' && method === 'GET') {
        await this.json(route, { branches: [repo.defaultBranch ?? 'main'] });
        return true;
      }
      if (repo && tail === 'validate' && method === 'POST') {
        await this.json(route, repo);
        return true;
      }
      if (repo && !tail && method === 'PUT') {
        repo.url = String(body?.url ?? repo.url);
        repo.updatedAt = now();
        await this.json(route, repo);
        return true;
      }
      if (repo && !tail && method === 'DELETE') {
        this.repos = this.repos.filter((item) => item.id !== id);
        await route.fulfill({ status: 204, body: '' });
        return true;
      }
    }

    if (head === 'issues') {
      if (!id && method === 'GET') {
        await this.json(route, this.issues);
        return true;
      }
      if (!id && method === 'POST') {
        const { issue } = this.addIssue({
          title: String(body?.title ?? 'без названия'),
          repositories: Array.isArray(body?.repositories)
            ? body.repositories
            : [],
          desired_result: body?.desired_result ?? 'md',
          pipeline_steps: body?.pipeline_steps ?? ['refine', 'resolve'],
          status: 'preparing',
        });
        await this.json(route, issue, 201);
        return true;
      }
      const issue = this.issues.find((item) => item.id === id);
      if (issue && !tail && method === 'GET') {
        await this.json(route, issue);
        return true;
      }
      if (issue && !tail && method === 'DELETE') {
        this.issues = this.issues.filter((item) => item.id !== id);
        this.iterations.delete(id);
        await route.fulfill({ status: 204, body: '' });
        return true;
      }
      if (issue && tail === 'stream' && method === 'GET') {
        await this.stream(route, id);
        return true;
      }
      if (issue && tail === 'iterations') {
        if (method === 'GET') {
          await this.json(route, this.iterations.get(id) ?? []);
          return true;
        }
        if (method === 'POST') {
          const created = this.addIteration(id, {
            context: String(body?.context ?? ''),
            status: 'running',
          });
          await this.json(route, created, 201);
          return true;
        }
      }
      if (issue && tail === 'result' && method === 'GET') {
        const html = this.resultHtml.get(id);
        const md = this.resultMd.get(id);
        if (html) {
          await this.raw(route, html, 'text/html');
          return true;
        }
        if (md) {
          await this.raw(route, md, 'text/markdown');
          return true;
        }
        await this.json(route, { error: 'result not found' }, 404);
        return true;
      }
      if (issue && tail === 'result' && tail2 === 'files' && method === 'GET') {
        await this.json(route, []);
        return true;
      }
      if (issue && tail === 'files' && method === 'GET') {
        await this.json(route, []);
        return true;
      }
    }

    if (head === 'iterations' && id) {
      if (tail === 'step-runs' && method === 'GET') {
        await this.json(route, this.stepRuns.get(id) ?? []);
        return true;
      }
      if (tail === 'agents' && method === 'GET') {
        await this.json(route, []);
        return true;
      }
      if (tail === 'question-answers' && method === 'GET') {
        await this.json(route, { answered_ids: [] });
        return true;
      }
      if (tail === 'repeat' && method === 'POST') {
        const source = this.findIteration(id);
        const created = this.addIteration(source?.iteration.issue_id ?? 'unknown', {
          context: source?.iteration.context ?? '',
          steps: source?.iteration.steps ?? ['refine', 'resolve'],
          status: 'running',
        });
        await this.json(route, created, 201);
        return true;
      }
      if (
        ['message', 'prompt', 'control', 'abort', 'ui-response'].includes(
          tail ?? '',
        ) &&
        method === 'POST'
      ) {
        await this.json(route, { ok: true });
        return true;
      }
    }

    return false;
  }

  private findIteration(
    iterationId: string,
  ): { iteration: FakeIteration; issueId: string } | null {
    for (const [issueId, list] of this.iterations) {
      const iteration = list.find((item) => item.id === iterationId);
      if (iteration) return { iteration, issueId };
    }
    return null;
  }

  private async stream(route: Route, issueId: string): Promise<void> {
    if (this.sseDown.has(issueId)) {
      await route.abort('connectionfailed');
      return;
    }
    const already = this.sseDelivered.has(issueId);
    this.sseDelivered.add(issueId);
    const events = already ? [] : (this.sseQueue.get(issueId) ?? []);
    const body = events.length
      ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
      : ': keep-alive\n\n';
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body,
    });
  }

  private async json(route: Route, data: unknown, status = 200): Promise<void> {
    await route.fulfill({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  private async raw(
    route: Route,
    body: string,
    contentType: string,
  ): Promise<void> {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': contentType },
      body,
    });
  }
}

function safeJson(raw: string | null): any {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** `new URL()` бросает на мусоре — возвращаем null, а не роняем роут. */
function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Кадр SSE `workspace_progress` (шаг разовой подготовки). */
export function wsProgress(
  step: string,
  status: 'running' | 'done' | 'error',
  repo?: string,
): Omit<FakeSseEvent, 'issueId' | 'ts'> {
  return {
    type: 'workspace_progress',
    data: JSON.stringify({ step, repo, status }),
  };
}

/** Кадр SSE `bootstrap_log` (живой stdout/stderr бутстрапера по репо). */
export function bsLog(
  repo: string,
  text: string,
  kind: 'stdout' | 'stderr' = 'stdout',
): Omit<FakeSseEvent, 'issueId' | 'ts'> {
  return {
    type: 'bootstrap_log',
    data: JSON.stringify({ repo, text, kind }),
  };
}

// ---------------------------- публичные helpers ----------------------------

/**
 * Создаёт сохранённый репозиторий через страницу «Репозитории»
 * (модалка → живая валидация URL → «Сохранить»).
 *
 * `branch` — ожидаемая базовая ветка; используется вызывающим тестом как
 * подсказка (сама форма валидации отдаёт ветки из фейкового API).
 */
export async function createRepo(
  page: Page,
  url: string,
  branch = 'main',
): Promise<void> {
  void branch;
  await page.goto('/#/repositories');
  await expect(page.getByTestId('repositories-page')).toBeVisible();

  await page.getByTestId('repo-add').click();
  await expect(page.getByTestId('repo-form')).toBeVisible();

  const field = page.getByTestId('repo-url-field');
  await field.fill(url);

  // Живая валидация дебаунсится — ждём зелёную галочку.
  await expect(page.getByTestId('repo-url-valid')).toBeVisible({
    timeout: 10_000,
  });

  await page.getByTestId('repo-form-save').click();
  await expect(page.getByTestId('repo-form')).toBeHidden();
  await expect(page.getByTestId('repo-card').last()).toBeVisible();
}

/**
 * Ждёт, пока App переключится на деталь задачи, и возвращает id из URL
 * (`#/tasks/<id>`).
 */
export async function getLatestIssueId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/#\/tasks\/([^/?#]+)/, { timeout: 15_000 });
  const match = page.url().match(/#\/tasks\/([^/?#]+)/);
  if (!match) {
    throw new Error(`не удалось извлечь issueId из URL: ${page.url()}`);
  }
  return match[1];
}

/**
 * Ждёт, пока выбранная итерация в карточке задачи покажет `status`
 * (сырой статус итерации из `Iteration`, как его рисует TaskDetail).
 */
export async function pollIterationStatus(
  page: Page,
  status: TaskStatus,
  timeout = 20_000,
): Promise<void> {
  await expect(
    page
      .getByTestId('iterations-island')
      .getByText(status, { exact: true })
      .first(),
  ).toBeVisible({ timeout });
}