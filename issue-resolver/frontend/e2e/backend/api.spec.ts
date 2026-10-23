/**
 * Backend integration/E2E: HTTP-сценарии против выделенного E2E-сервера
 * (`backend/test/e2e-server.ts`) — реальные роуты и движок поверх
 * детерминированных фейков. Файл сам поднимает свой инстанс на свободном порту
 * (общий `playwright.config.ts` стартует мок-стек :8095/:5195), поэтому
 * сценарии не требуют Docker/git/pi, не ходят в сеть и не зависят от чужих
 * серверов. Ответы агента задаются `POST /e2e/scenarios` до создания задачи.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';

// Каждый прогон — свежий бэкенд на своём порту: переиспользование залежавшегося
// инстанса ломает детерминизм (в его БД repo уже `run_instructions: generated`,
// поэтому подготовка не воспроизводится). 8080 занят живым dev-сервером.
const API_PORT = Number(
  process.env.E2E_API_PORT ?? 20100 + Math.floor(Math.random() * 8000),
);
const API_ORIGIN = `http://localhost:${API_PORT}`;
const API = `${API_ORIGIN}/issue-resolver/api/v1`;
const repoRoot = join(import.meta.dirname, '..', '..', '..');

let e2eServer: ChildProcess | null = null;

async function serverIsUp(): Promise<boolean> {
  try {
    return (await fetch(`${API_ORIGIN}/ping`)).ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  e2eServer = spawn('npx', ['tsx', 'backend/test/e2e-server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      ISSUE_RESOLVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'ir-e2e-')),
      // Пауза в подготовке: клиент успевает открыть SSE до вопроса агента.
      E2E_BOOTSTRAP_HOLD_MS: '400',
    },
    stdio: 'ignore',
    // Своя группа процессов: `npx → tsx → node` иначе переживёт kill родителя.
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await serverIsUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('E2E backend did not start');
});

test.afterAll(() => {
  const pid = e2eServer?.pid;
  e2eServer = null;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM'); // вся группа процессов
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // уже мёртв
    }
  }
});

/** Терминальные статусы задачи. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

interface SseEnvelope {
  type: string;
  issueId: string;
  iterationId?: string;
  stepRunId?: string;
  stream?: string;
  data: string;
  ts: string;
}

let repoSeq = 0;

/** Уникальный URL на тест: своя запись `run_instructions`, своя подготовка. */
function uniqueRepoUrl(): string {
  repoSeq += 1;
  return `https://github.com/e2e/${Date.now().toString(36)}-${repoSeq}.git`;
}

/** Имя репозитория так же, как его выводит `extractRepoNameFromUrl` на беке. */
function repoNameOf(url: string): string {
  return url
    .replace(/\/+$/, '')
    .split('/')
    .pop()!
    .replace(/\.git$/i, '');
}

async function createRepo(
  request: APIRequestContext,
  url = uniqueRepoUrl(),
): Promise<{
  id: string;
  url: string;
  connectionStatus: string;
  name: string;
}> {
  const res = await request.post(`${API}/repositories`, { data: { url } });
  expect(res.status(), await res.text()).toBe(201);
  const saved = (await res.json()) as {
    id: string;
    url: string;
    connectionStatus: string;
  };
  return { ...saved, name: repoNameOf(saved.url ?? url) };
}

async function createIssue(
  request: APIRequestContext,
  data: Record<string, unknown>,
): Promise<{ id: string; status: string }> {
  const res = await request.post(`${API}/issues`, { data });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** Задаёт сценарий ответов мок-агента (встроенное имя или inline-шаги). */
async function setScenario(
  request: APIRequestContext,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`${API_ORIGIN}/e2e/scenarios`, { data });
  expect(res.status(), await res.text()).toBe(200);
}

/** Возвращает сценарий к `all-success`, чтобы он не протекал между тестами. */
async function resetScenario(request: APIRequestContext): Promise<void> {
  await request.post(`${API_ORIGIN}/e2e/reset`);
}

/** Итерации задачи (в порядке создания). */
async function listIterations(
  request: APIRequestContext,
  issueId: string,
): Promise<Array<{ id: string; status: string }>> {
  const res = await request.get(`${API}/issues/${issueId}/iterations`);
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

async function getIssue(
  request: APIRequestContext,
  id: string,
): Promise<{ id: string; status: string; repositories: Array<Record<string, unknown>> }> {
  const res = await request.get(`${API}/issues/${id}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

/** Поллит задачу, пока её статус не удовлетворит предикату. */
async function waitForIssueStatus(
  request: APIRequestContext,
  id: string,
  want: (status: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await getIssue(request, id)).status;
    if (want(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`issue ${id} status stayed "${last}"`);
}

/** Открывает SSE-стрим задачи и собирает события до `until` или таймаута. */
async function collectSse(
  issueId: string,
  timeoutMs: number,
  until: (events: SseEnvelope[]) => boolean,
): Promise<SseEnvelope[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: SseEnvelope[] = [];
  let buffer = '';
  try {
    const res = await fetch(`${API}/issues/${issueId}/stream`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    const reader = res.body?.getReader();
    if (!reader) return events;
    const decoder = new TextDecoder();
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = block
          .split('\n')
          .find((candidate) => candidate.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice('data: '.length)));
          } catch {
            // сердцебиение/неполный блок — пропускаем
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // abort по таймауту — отдаём то, что успели собрать
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

const hasType = (events: SseEnvelope[], type: string): boolean =>
  events.some((event) => event.type === type);

/** `iteration_status` с живым статусом `question` (агент ждёт ответа). */
const isQuestionStatus = (event: SseEnvelope): boolean => {
  if (event.type !== 'iteration_status') return false;
  try {
    return (JSON.parse(event.data) as { status?: string }).status === 'question';
  } catch {
    return false;
  }
};

test.describe('backend API', () => {
  test.afterEach(async ({ request }) => {
    await resetScenario(request);
  });

  test('создание репозитория → валидация → задача доходит до терминала', async ({
    request,
  }) => {
    const repo = await createRepo(request);
    expect(repo.connectionStatus).toBe('ok');

    const validated = await request.post(
      `${API}/repositories/${repo.id}/validate`,
    );
    expect(validated.status()).toBe(200);

    const issue = await createIssue(request, {
      title: 'E2E: базовый поток',
      repositories: [{ repo_id: repo.id, base_branch: 'main' }],
      pipeline_steps: ['resolve'],
    });
    expect(issue.status).toBe('pending');

    const final = await waitForIssueStatus(
      request,
      issue.id,
      (status) => status !== 'pending',
    );
    expect(['preparing', 'running', ...TERMINAL]).toContain(final);
  });

  test('bootstrap_enabled:false сохраняется per-repo и задача не зависает', async ({
    request,
  }) => {
    const repo = await createRepo(request);
    const issue = await createIssue(request, {
      title: 'E2E: без bootstrap',
      repositories: [
        { repo_id: repo.id, base_branch: 'main', bootstrap_enabled: false },
      ],
      pipeline_steps: ['resolve'],
    });

    const saved = await getIssue(request, issue.id);
    expect(saved.repositories[0].bootstrap_enabled).toBe(false);

    const final = await waitForIssueStatus(
      request,
      issue.id,
      (status) => status !== 'pending',
    );
    expect(final).not.toBe('pending');
  });

  test('вопрос агента: SSE iteration_status question, ответ сохраняется', async ({
    request,
  }) => {
    await setScenario(request, { scenario: 'agent-question' });
    const repo = await createRepo(request);
    const issue = await createIssue(request, {
      title: 'E2E вопрос',
      additional_context: 'контекст',
      repositories: [{ repo_id: repo.id, base_branch: 'main' }],
      pipeline_steps: ['resolve'],
    });

    // Живой признак «агент ждёт ответа» — SSE-событие iteration_status
    // `question`: REST-статус задачи выводится из статуса итерации
    // (`statusOfIssue`) и во время ожидания остаётся `running`.
    const events = await collectSse(
      issue.id,
      20_000,
      (acc) => acc.some(isQuestionStatus),
    );
    const questionEvent = events.find(isQuestionStatus);
    expect(questionEvent, 'ожидалось SSE iteration_status question').toBeTruthy();
    expect(
      (JSON.parse(questionEvent!.data) as { needsInput?: boolean }).needsInput,
    ).toBe(true);

    const iterations = await listIterations(request, issue.id);
    expect(iterations.length).toBeGreaterThan(0);
    const iterationId = iterations[0].id;

    const answer = await request.post(
      `${API}/iterations/${iterationId}/ui-response`,
      { data: { id: 'e2e-question-1', value: 'e2e-answer' } },
    );
    expect(answer.status(), await answer.text()).toBe(200);

    const answers = await request.get(
      `${API}/iterations/${iterationId}/question-answers`,
    );
    expect(answers.ok()).toBe(true);
    expect((await answers.json()).answered_ids).toContain('e2e-question-1');

    // Ответ доходит до мок-агента, и задача завершается.
    expect(
      await waitForIssueStatus(request, issue.id, (status) =>
        TERMINAL.has(status),
      ),
    ).toBe('completed');
  });

  test('параллельные вопросы двух задач разрешаются независимо', async ({
    request,
  }) => {
    await setScenario(request, { scenario: 'concurrent-questions' });
    const repo = await createRepo(request);
    const issueA = await createIssue(request, {
      title: 'E2E параллельный вопрос A',
      repositories: [{ repo_id: repo.id, base_branch: 'main' }],
      pipeline_steps: ['resolve'],
    });
    const issueB = await createIssue(request, {
      title: 'E2E параллельный вопрос B',
      repositories: [{ repo_id: repo.id, base_branch: 'main' }],
      pipeline_steps: ['resolve'],
    });

    const [eventsA, eventsB] = await Promise.all([
      collectSse(issueA.id, 20_000, (acc) => acc.some(isQuestionStatus)),
      collectSse(issueB.id, 20_000, (acc) => acc.some(isQuestionStatus)),
    ]);
    expect(eventsA.some(isQuestionStatus)).toBe(true);
    expect(eventsB.some(isQuestionStatus)).toBe(true);

    for (const [issueId, suffix] of [
      [issueA.id, 'a'],
      [issueB.id, 'b'],
    ] as const) {
      const [iteration] = await listIterations(request, issueId);
      const answer = await request.post(
        `${API}/iterations/${iteration.id}/ui-response`,
        { data: { id: `e2e-cq-${suffix}`, value: 'да' } },
      );
      expect(answer.status(), await answer.text()).toBe(200);
    }

    const [finalA, finalB] = await Promise.all([
      waitForIssueStatus(request, issueA.id, (status) => TERMINAL.has(status)),
      waitForIssueStatus(request, issueB.id, (status) => TERMINAL.has(status)),
    ]);
    expect([finalA, finalB]).toEqual(['completed', 'completed']);
  });

  test('CRUD репозиториев: create → list → update → delete', async ({
    request,
  }) => {
    const repo = await createRepo(request);

    const list = await request.get(`${API}/repositories`);
    expect(list.ok()).toBe(true);
    const items = (await list.json()) as Array<{ id: string }>;
    expect(items.some((item) => item.id === repo.id)).toBe(true);

    const updatedUrl = 'https://github.com/e2e/renamed.git';
    const updated = await request.put(`${API}/repositories/${repo.id}`, {
      data: { url: updatedUrl },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).url).toBe(updatedUrl);

    const deleted = await request.delete(`${API}/repositories/${repo.id}`);
    expect(deleted.status()).toBe(204);

    const gone = await request.get(`${API}/repositories/${repo.id}`);
    expect(gone.status()).toBe(404);
  });

  test('SSE: workspace_progress, log DevOps и iteration_status', async ({
    request,
  }) => {
    const repo = await createRepo(request);
    const issue = await createIssue(request, {
      title: 'E2E: SSE',
      repositories: [{ repo_id: repo.id, base_branch: 'main' }],
      pipeline_steps: ['resolve'],
    });

    const events = await collectSse(
      issue.id,
      20_000,
      (acc) =>
        hasType(acc, 'workspace_progress') &&
        acc.some(
          (event) =>
            event.type === 'log' &&
            event.stepRunId === `${issue.id}/devops`,
        ) &&
        hasType(acc, 'iteration_status'),
    );

    expect(hasType(events, 'workspace_progress')).toBe(true);
    expect(hasType(events, 'iteration_status')).toBe(true);

    // DevOps-вывод идёт обычными `log`-событиями с синтетическим stepRunId
    // `{issueId}/devops`, stream = stdout/stderr (старого `devops_log` нет).
    const logs = events.filter(
      (event) =>
        event.type === 'log' && event.stepRunId === `${issue.id}/devops`,
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((event) => event.stream === 'stdout')).toBe(true);
    for (const event of logs) {
      expect(['stdout', 'stderr']).toContain(event.stream);
      expect(event.data.length).toBeGreaterThan(0);
    }
    expect(events.some((event) => event.type === 'devops_log')).toBe(false);
  });

  test('повтор итерации создаёт вторую', async ({ request }) => {
    const repo = await createRepo(request);
    const issue = await createIssue(request, {
      title: 'E2E: повтор',
      repositories: [{ repo_id: repo.id, base_branch: 'main' }],
      pipeline_steps: ['resolve'],
    });
    await waitForIssueStatus(request, issue.id, (status) => TERMINAL.has(status));

    const second = await request.post(`${API}/issues/${issue.id}/iterations`, {
      data: { context: 'второй раунд' },
    });
    expect(second.status(), await second.text()).toBe(201);

    const iterationsRes = await request.get(`${API}/issues/${issue.id}/iterations`);
    const iterations = (await iterationsRes.json()) as Array<{ id: string }>;
    expect(iterations.length).toBe(2);
  });

  test('ошибки валидации: URL, отсутствие title, неизвестный repo_id', async ({
    request,
  }) => {
    const badUrl = await request.post(`${API}/repositories`, {
      data: { url: 'not-a-url' },
    });
    expect(badUrl.status()).toBe(400);

    const noTitle = await request.post(`${API}/issues`, { data: {} });
    expect(noTitle.status()).toBe(400);

    const missingRepo = await request.post(`${API}/issues`, {
      data: {
        title: 'E2E: неизвестный repo_id',
        repositories: [
          {
            repo_id: '11111111-1111-4111-8111-111111111111',
            base_branch: 'main',
          },
        ],
      },
    });
    expect(missingRepo.status()).toBe(422);

    const emptyUrls = await request.post(`${API}/repos/validate`, {
      data: { urls: [] },
    });
    expect(emptyUrls.status()).toBe(400);
  });
});