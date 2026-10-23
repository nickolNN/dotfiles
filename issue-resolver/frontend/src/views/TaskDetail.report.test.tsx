import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Issue, Iteration } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [],
    pipeline_steps: ['resolve'],
    status: 'completed',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function makeIteration(overrides: Partial<Iteration> = {}): Iteration {
  return {
    id: 'iter-1',
    issue_id: 'issue-1',
    number: 1,
    context: 'first try',
    review_context: '',
    is_review_need: false,
    steps: ['resolve'],
    status: 'completed',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function textResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}

/**
 * Ответ HEAD-проба `/result`: только статус и заголовки, без тела.
 * По умолчанию — свежий HTML из корня воркспейса.
 */
function headResponse(artifact: {
  status?: number;
  contentType?: string;
  source?: string | null;
  mtime?: string | null;
} = {}): Response {
  const entries: Record<string, string | null> = {
    'content-type': artifact.contentType ?? 'text/html; charset=utf-8',
    'x-artifact-source':
      'source' in artifact ? (artifact.source ?? null) : 'root',
    'x-artifact-mtime': artifact.mtime ?? null,
  };
  const status = artifact.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => entries[name.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

/** Минимальный фейк EventSource: ручная отдача onmessage. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function stubFetch(options: {
  reportStatus?: () => Response;
  onReportPost?: () => Response;
  artifact?: Parameters<typeof headResponse>[0];
  /** Снапшот GET /iterations/:id/control (по умолчанию — нет сессии). */
  controlSnapshot?: unknown;
} = {}) {
  const issue = makeIssue();
  const iteration = makeIteration();

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/report/status')) {
      return Promise.resolve(
        options.reportStatus
          ? options.reportStatus()
          : jsonResponse({ status: 'idle' }),
      );
    }
    if (url.endsWith('/report')) {
      return Promise.resolve(
        options.onReportPost
          ? options.onReportPost()
          : jsonResponse({ ok: true, reportRunId: 'issue-1/report' }),
      );
    }
    if (url.endsWith('/control') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ ok: true, data: {} }));
    }
    if (url.endsWith('/control')) {
      // Нет снапшота → форма не проходит `isControlSnapshot` → панель скрыта.
      return Promise.resolve(
        jsonResponse(options.controlSnapshot ?? { error: 'no session' }),
      );
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.endsWith('/result') && init?.method === 'HEAD') {
      return Promise.resolve(headResponse(options.artifact));
    }
    if (url.endsWith('/result')) {
      return Promise.resolve(textResponse('<html>report</html>'));
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Публикует `log`-чанк report-агента (синтетический stepRunId). */
function emitReportLog(text: string, stream: 'stdout' | 'stderr' = 'stdout') {
  act(() => {
    FakeEventSource.instances[0].emit({
      type: 'log',
      issueId: 'issue-1',
      stepRunId: 'issue-1/report',
      stream,
      data: text,
      ts: '2026-10-09T00:00:00.000Z',
    });
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Открывает модалку отчёта кнопкой «Показать отчёт»: кнопка активна только
 * когда есть completed-итерация, поэтому сначала ждём снятия disabled.
 */
async function clickOpenReport(): Promise<void> {
  const button = await screen.findByTestId('open-result');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('TaskDetail — секция «Отчёт»', () => {
  it('нет report.md → секция видна, кнопка активна', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const section = await screen.findByTestId('report-section');
    expect(section).toHaveTextContent('Отчёт');
    expect(screen.getByTestId('report-idle')).toBeInTheDocument();
    expect(screen.getByTestId('refresh-report')).toBeEnabled();
    expect(screen.queryByTestId('report-ready')).toBeNull();
  });

  it('клик «Обновить» → POST /report + «Генерируется» с SessionView', async () => {
    const fetchMock = stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('refresh-report'));

    // Кнопка уходит в disabled, показывается индикатор генерации.
    await waitFor(() =>
      expect(screen.getByTestId('report-generating')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('refresh-report')).toBeDisabled();

    // POST ушёл на report-роут.
    const posted = fetchMock.mock.calls.some(
      ([input]) => String(input).endsWith('/issues/issue-1/report'),
    );
    expect(posted).toBe(true);

    // Живые stdout-чанки попадают в SessionView как text-события.
    emitReportLog('Collecting iteration narratives...\n');
    emitReportLog('report.md written\n');
    const session = await screen.findByTestId('report-session');
    expect(session).toHaveTextContent('Collecting iteration narratives...');
    expect(session).toHaveTextContent('report.md written');
  });

  it('живой вывод генерации показан в шапке задачи', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('refresh-report'));
    await waitFor(() =>
      expect(screen.getByTestId('report-generating')).toBeInTheDocument(),
    );
    emitReportLog('building report…\n');

    const session = await screen.findByTestId('report-session');
    expect(session.closest('header')).not.toBeNull();
  });

  it('report.md готов → «✓ Сгенерирован» + MD', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await screen.findByTestId('report-ready');
    expect(screen.getByTestId('report-ready')).toHaveTextContent(
      'Сгенерирован',
    );
    expect(screen.getByTestId('open-result')).toHaveTextContent(
      'Показать отчёт',
    );
    expect(screen.getByTestId('report-md')).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/md/download',
    );
    expect(screen.queryByTestId('report-generating')).toBeNull();
  });

  it('warnings от серверных детектов → красная строка в секции отчёта', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
          warnings: [
            'model-like id leaked into report.md',
            'anchored on previous report: reports/x/report.md',
          ],
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const warn = await screen.findByTestId('report-warnings');
    expect(warn).toHaveTextContent('model-like id leaked into report.md');
    expect(warn).toHaveTextContent('anchored on previous report');
  });

  it('наблюдённая модель показана в UI, но не в артефакте', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
          observedModel: 'provider1/some-model',
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const meta = await screen.findByTestId('report-observed-model');
    expect(meta).toHaveTextContent('provider1/some-model');
    expect(screen.queryByTestId('report-warnings')).toBeNull();
  });

  it('👁 HTML открывает модалку отчёта', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await clickOpenReport();
    expect(await screen.findByTestId('result-modal')).toBeInTheDocument();
  });

  it('HEAD 404 → «отчёта ещё нет», iframe не рендерится', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
        }),
      artifact: { status: 404, contentType: 'application/json', source: null },
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await clickOpenReport();
    expect(await screen.findByTestId('result-missing')).toBeInTheDocument();
    expect(screen.queryByTestId('result-html')).toBeNull();
  });

  it('HEAD text/markdown → markdown в HTML-iframe не попадает', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
        }),
      artifact: {
        contentType: 'text/markdown; charset=utf-8',
        source: 'iteration-snapshot',
        mtime: '2026-10-23T08:21:07.878Z',
      },
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await clickOpenReport();
    expect(await screen.findByTestId('result-not-html')).toBeInTheDocument();
    expect(screen.queryByTestId('result-html')).toBeNull();
  });

  it('x-artifact-source: iteration-snapshot → бейдж «предыдущая версия»', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
        }),
      artifact: {
        source: 'iteration-snapshot',
        mtime: '2026-10-23T08:21:07.878Z',
      },
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await clickOpenReport();
    await screen.findByTestId('result-html');
    const badge = await screen.findByTestId('artifact-source-badge');
    expect(badge).toHaveTextContent('предыдущая версия');
    expect(badge).toHaveTextContent('2026-10-23T08:21:07.878Z');
  });

  it('ошибка POST /report → красный текст, генерация снята', async () => {
    stubFetch({
      onReportPost: () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: 'report generation already in progress' }),
        }) as Response,
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('refresh-report'));

    const error = await screen.findByTestId('report-error');
    expect(error).toHaveTextContent('report generation already in progress');
    await waitFor(() =>
      expect(screen.getByTestId('refresh-report')).toBeEnabled(),
    );
  });
});

/** Снапшот управления report-сессией: панель контроля в модалке отчёта. */
function makeControlSnapshot() {
  return {
    state: {
      model: 'Claude Sonnet 4',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
      thinkingLevel: 'medium',
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      autoCompactionEnabled: true,
      autoRetryEnabled: null,
      isStreaming: true,
      sessionName: 'Report',
    },
    models: [
      { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    ],
    thinkingLevels: ['low', 'medium', 'high'],
    commands: [],
  };
}

/** Публикует `stats`-эмит report-сессии (конверт `step_event`). */
function emitReportStats() {
  act(() => {
    FakeEventSource.instances[0].emit({
      type: 'step_event',
      issueId: 'issue-1',
      stepRunId: 'issue-1/report',
      stream: 'system',
      data: JSON.stringify({
        stepRunId: 'issue-1/report',
        event: {
          type: 'stats',
          stats: {
            model: 'Claude Sonnet 4',
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: 3,
            toolResults: 3,
            totalMessages: 2,
            tokens: {
              input: 1000,
              output: 200,
              cacheRead: 50,
              cacheWrite: 10,
              total: 1260,
            },
            cost: 0.01,
            contextUsage: { tokens: 4200, contextWindow: 10000, percent: 42 },
            avgTokensPerSecond: 30,
          },
        },
      }),
      ts: '2026-10-09T00:00:00.000Z',
    });
  });
}

describe('TaskDetail — контроль и статистика report-агента', () => {
  it('stats-эмит → строка статистики в секции отчёта', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('refresh-report'));
    await screen.findByTestId('report-generating');
    emitReportStats();

    const stats = await screen.findByTestId('session-stats');
    expect(stats).toHaveTextContent('CTX 42%');
    expect(stats).toHaveTextContent('Claude Sonnet 4');
  });

  it('«Развернуть» открывает модалку с живым выводом и контролем', async () => {
    stubFetch({ controlSnapshot: makeControlSnapshot() });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('refresh-report'));
    await screen.findByTestId('report-generating');
    emitReportLog('building report…\n');

    fireEvent.click(await screen.findByTestId('report-expand'));

    expect(await screen.findByTestId('step-log-modal')).toBeInTheDocument();
    expect(await screen.findByTestId('modal-session')).toHaveTextContent(
      'building report…',
    );
    // Тот же контроль, что у шагов: модель/thinking/compact.
    expect(await screen.findByTestId('live-controls')).toBeInTheDocument();
    expect(screen.getByTestId('control-model')).toBeInTheDocument();
    expect(screen.getByTestId('control-thinking')).toBeInTheDocument();
  });
});