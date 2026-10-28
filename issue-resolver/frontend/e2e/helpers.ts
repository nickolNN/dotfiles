import {
  expect,
  type APIRequestContext,
  type Page,
  type Route,
} from '@playwright/test';

export const API = '/issue-resolver/api/v1';

export const TEST_REPO_URL = 'https://github.com/octocat/Hello-World';
export const TEST_REPO_NAME = 'Hello-World';

export interface EnsuredRepo {
  id: string;
  url: string;
  defaultBranch: string;
}

type Json = Record<string, unknown>;

export function uniqueTitle(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export async function ensureSavedRepo(
  request: APIRequestContext,
): Promise<EnsuredRepo> {
  const listRes = await request.get(`${API}/repositories`);
  if (listRes.ok()) {
    const list = (await listRes.json()) as Array<Json>;
    const existing = list.find(
      (repo) =>
        repo.url === TEST_REPO_URL || repo.url === `${TEST_REPO_URL}.git`,
    );
    if (existing) {
      return {
        id: String(existing.id),
        url: String(existing.url),
        defaultBranch: String(existing.defaultBranch ?? 'master'),
      };
    }
  }

  const createRes = await request.post(`${API}/repositories`, {
    data: { url: TEST_REPO_URL },
  });
  const body = (await createRes.json()) as Json;
  const repo = (body.repository ?? body) as Json;
  return {
    id: String(repo.id),
    url: String(repo.url ?? TEST_REPO_URL),
    defaultBranch: String(repo.defaultBranch ?? 'master'),
  };
}

export interface CreateIssueOptions {
  title: string;
  description?: string;
  bootstrapEnabled?: boolean;
  repoId?: string;
  refine?: boolean;
}

export async function createIssueViaUI(
  page: Page,
  options: CreateIssueOptions,
): Promise<string> {
  const repo = options.repoId
    ? { id: options.repoId, url: TEST_REPO_URL, defaultBranch: 'master' }
    : await ensureSavedRepo(page.request);

  await page.goto('/#/tasks');
  await expect(
    page.getByRole('heading', { name: 'Мои задачи' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Создание задачи' }),
  ).toBeVisible();

  await page.getByLabel('Заголовок').fill(options.title);
  if (options.description) {
    await page.getByLabel('Описание задачи').fill(options.description);
  }
  if (options.refine) {
    await page.getByLabel('Планирование').check();
  }

  await page.getByRole('button', { name: 'Добавить репозиторий' }).click();
  const select = page.getByTestId('repository-select-0');
  await expect(select).toBeEnabled();
  await select.selectOption(repo.id);

  await expect(page.getByTestId('repository-branch-0')).not.toHaveValue('');

  if (options.bootstrapEnabled === false) {
    await page.getByRole('switch', { name: /Запустить/ }).click();
  }

  await page
    .getByRole('button', { name: 'Запустить', exact: true })
    .click();

  await expect(page.getByRole('heading', { name: options.title })).toBeVisible();

  const match = /#\/tasks\/([^/?#]+)/.exec(page.url());
  if (!match) {
    throw new Error(`не удалось определить issueId из URL: ${page.url()}`);
  }
  return decodeURIComponent(match[1]);
}

export async function waitForStatus(
  page: Page,
  status: string,
  timeout = 30_000,
): Promise<void> {
  await expect(
    page.getByTestId('task-island').getByTestId('issue-status'),
  ).toHaveAttribute('data-status', status, { timeout });
}

export const issueDetailPattern =
  /\/issue-resolver\/api\/v1\/issues\/[0-9a-fA-F-]+$/;

export const E2E_API_ORIGIN =
  process.env.E2E_API_ORIGIN ?? 'http://localhost:8095';

export interface ScenarioRequest {
  scenario?: string;
  steps?: Array<Record<string, unknown>>;
  bootstrap?: 'success' | 'failure';
  questionTimeoutMs?: number;
}

export async function setScenario(
  request: APIRequestContext,
  scenario: ScenarioRequest,
): Promise<void> {
  const res = await request.post(`${E2E_API_ORIGIN}/e2e/scenarios`, {
    data: scenario,
  });
  expect(res.ok(), await res.text()).toBe(true);
}

export async function resetScenario(
  request: APIRequestContext,
): Promise<void> {
  const res = await request.post(`${E2E_API_ORIGIN}/e2e/reset`);
  expect(res.ok(), await res.text()).toBe(true);
}

export async function pollIssueStatus(
  request: APIRequestContext,
  issueId: string,
  want: (status: string) => boolean,
  timeout = 20_000,
): Promise<string> {
  let last = '';
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const res = await request.get(`${API}/issues/${issueId}`);
    if (res.ok()) {
      last = ((await res.json()) as { status?: string }).status ?? '';
      if (want(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`issue ${issueId} status stayed "${last}"`);
}

type SseEvent = Record<string, unknown>;

const now = () => new Date().toISOString();

export function sseBody(events: SseEvent[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

export function workspaceProgress(
  step: string,
  status: string,
  repo?: string,
  message?: string,
): SseEvent {
  return {
    type: 'workspace_progress',
    issueId: 'e2e',
    data: JSON.stringify({ step, status, repo, message }),
    ts: now(),
  };
}

export function logChunk(
  stepRunId: string,
  text: string,
  stream: 'stdout' | 'stderr' = 'stdout',
): SseEvent {
  return {
    type: 'log',
    issueId: 'e2e',
    stepRunId,
    stream,
    data: text,
    ts: now(),
  };
}

export function iterationStatus(status: string): SseEvent {
  return {
    type: 'iteration_status',
    issueId: 'e2e',
    data: JSON.stringify({ status, needsInput: status === 'question' }),
    ts: now(),
  };
}

export async function mockStreamBatches(
  page: Page,
  pattern: string | RegExp,
  batches:
    | SseEvent[][]
    | ((call: number, issueId: string) => SseEvent[]),
  onCall?: (call: number) => void,
): Promise<void> {
  let call = 0;
  await page.route(pattern, (route: Route) => {
    call += 1;
    onCall?.(call);
    const issueId =
      /issues\/([^/?#]+)\/stream/.exec(route.request().url())?.[1] ?? 'e2e';
    const batch =
      typeof batches === 'function'
        ? batches(call, issueId)
        : call <= batches.length
          ? batches[call - 1]
          : [];
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(batch),
    });
  });
}