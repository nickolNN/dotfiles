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

const noArtifact = { present: false, bytes: 0, mtime: null };

const runningStatus = () =>
  jsonResponse({
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: { md: noArtifact, html: noArtifact },
  });

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
  onReembed?: () => Response;
  artifact?: Parameters<typeof headResponse>[0];
  resultBody?: string;
  reportRun?: unknown;
  controlSnapshot?: unknown;
} = {}) {
  const issue = makeIssue();
  const iteration = makeIteration();

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/report/reembed') && init?.method === 'POST') {
      return Promise.resolve(
        options.onReembed
          ? options.onReembed()
          : jsonResponse({ ok: true, warnings: [], embed: 'inlined 1' }),
      );
    }
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
          : jsonResponse({ ok: true, reportRunId: 'issue.issue-1.report' }),
      );
    }
    if (url.endsWith('/control') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ ok: true, data: {} }));
    }
    if (url.endsWith('/control')) {
      return Promise.resolve(
        jsonResponse(options.controlSnapshot ?? { error: 'no session' }),
      );
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.endsWith('/report/run')) {
      return Promise.resolve(
        options.reportRun
          ? jsonResponse(options.reportRun)
          : ({
              ok: false,
              status: 404,
              json: async () => ({ error: 'report run not found' }),
            } as Response),
      );
    }
    if (url.endsWith('/result') && init?.method === 'HEAD') {
      return Promise.resolve(headResponse(options.artifact));
    }
    if (url.endsWith('/result')) {
      return Promise.resolve(
        textResponse(options.resultBody ?? '<html>report</html>'),
      );
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function emitReportLog(text: string, stream: 'stdout' | 'stderr' = 'stdout') {
  act(() => {
    FakeEventSource.instances[0].emit({
      type: 'log',
      issueId: 'issue-1',
      stepRunId: 'issue.issue-1.report',
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
    const fetchMock = stubFetch({ reportStatus: runningStatus });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('refresh-report'));

    await waitFor(() =>
      expect(screen.getByTestId('report-generating')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('refresh-report')).toBeEnabled(),
    );

    const posted = fetchMock.mock.calls.some(
      ([input]) => String(input).endsWith('/issues/issue-1/report'),
    );
    expect(posted).toBe(true);

    emitReportLog('Collecting iteration narratives...\n');
    emitReportLog('report.md written\n');
    const session = await screen.findByTestId('report-session');
    expect(session).toHaveTextContent('Collecting iteration narratives...');
    expect(session).toHaveTextContent('report.md written');
  });

  it('живой вывод генерации показан в шапке задачи', async () => {
    stubFetch({ reportStatus: runningStatus });
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

  it('идёт прогон → «Обновить» доступна, а не заблокирована статусом', async () => {
    stubFetch({ reportStatus: runningStatus });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('report-generating')).toBeInTheDocument();
    expect(screen.getByTestId('refresh-report')).toBeEnabled();
    expect(screen.queryByTestId('report-stale')).toBeNull();
  });

  it('прогон без сердцебиения → «нет активности» и повтор разрешён', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'running',
          startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          artifacts: { md: noArtifact, html: noArtifact },
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const stale = await screen.findByTestId('report-stale');
    expect(stale).toHaveTextContent('нет активности 5 мин');
    expect(screen.getByTestId('refresh-report')).toBeEnabled();
  });

  it('report.md готов, html нет → «Только markdown» + MD', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
          artifacts: {
            md: { present: true, bytes: 100, mtime: '2026-10-27T14:01:42Z' },
            html: { present: false, bytes: 0, mtime: null },
          },
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await screen.findByTestId('report-md-only');
    expect(screen.getByTestId('report-md-only')).toHaveTextContent(
      'Только markdown',
    );
    expect(screen.queryByTestId('report-ready')).toBeNull();
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
          artifacts: {
            md: { present: true, bytes: 21, mtime: '2026-10-27T14:01:42Z' },
            html: { present: false, bytes: 0, mtime: null },
          },
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
    expect(warn).toHaveAttribute('role', 'status');
    expect(warn.className).not.toContain('#FF0033');
  });

  it('наблюдённая модель показана в UI, но не в артефакте', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
          artifacts: {
            md: { present: true, bytes: 21, mtime: '2026-10-27T14:01:42Z' },
            html: { present: false, bytes: 0, mtime: null },
          },
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

  it('HEAD text/markdown → markdown рендерится в модалке, iframe нет', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
        }),
      artifact: {
        contentType: 'text/markdown; charset=utf-8',
        source: 'root',
        mtime: '2026-10-23T08:21:07.878Z',
      },
      resultBody: '# Отчёт\n\nТело отчёта из report.md.\n',
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await clickOpenReport();
    expect(await screen.findByTestId('result-not-html')).toBeInTheDocument();
    const markdown = await screen.findByTestId('result-markdown');
    expect(markdown.textContent).toContain('Тело отчёта из report.md.');
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

function emitReportStats() {
  act(() => {
    FakeEventSource.instances[0].emit({
      type: 'step_event',
      issueId: 'issue-1',
      stepRunId: 'issue.issue-1.report',
      stream: 'system',
      data: JSON.stringify({
        stepRunId: 'issue.issue-1.report',
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
  it('идёт прогон → живой транскрипт, итога ещё нет', async () => {
    stubFetch({ reportStatus: runningStatus });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('refresh-report'));
    await screen.findByTestId('report-generating');
    emitReportStats();

    expect(await screen.findByTestId('report-session')).toBeInTheDocument();
    expect(screen.queryByTestId('report-summary')).toBeNull();
  });



  it('«Развернуть» открывает модалку с живым выводом и контролем', async () => {
    stubFetch({
      controlSnapshot: makeControlSnapshot(),
      reportStatus: runningStatus,
    });
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
    expect(await screen.findByTestId('live-controls')).toBeInTheDocument();
    expect(screen.getByTestId('control-model')).toBeInTheDocument();
    expect(screen.getByTestId('control-thinking')).toBeInTheDocument();
  });
});
describe('TaskDetail — исход прогона отчёта', () => {
  const absent = { present: false, bytes: 0, mtime: null };

  const makeReportRun = (overrides: Record<string, unknown> = {}) => ({
    id: 'report-run-1',
    issue_id: 'issue-1',
    iteration_id: null,
    step: 'report',
    attempt: 1,
    status: 'failed',
    context: 'manual',
    feedback: 'report failed: report.md отсутствует после прогона',
    created_at: '2026-10-27T15:42:19.000Z',
    updated_at: '2026-10-27T16:01:09.000Z',
    stdout: '',
    stderr: '',
    events: [{ type: 'text', text: 'строка из сохранённой сессии' }],
    stats: null,
    report: null,
    screenshots_dir: null,
    ...overrides,
  });

  it('прогон упал → «✕ Прогон упал» + причина, а не зелёный успех', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'failed',
          feedback: 'report failed: report.md отсутствует после прогона',
          artifacts: { md: absent, html: absent },
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('report-failed')).toBeInTheDocument();
    expect(screen.getByTestId('report-feedback')).toHaveTextContent(
      'report.md отсутствует',
    );
    expect(screen.queryByTestId('report-ready')).toBeNull();
    expect(screen.queryByTestId('report-md-only')).toBeNull();
  });

  it('прогон прерван, но отчёт есть → бейдж «Отчёт есть» и MD доступен', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'failed',
          feedback: 'interrupted by server restart',
          artifacts: {
            md: { present: true, bytes: 18259, mtime: '2026-10-28T07:07:41Z' },
            html: { present: true, bytes: 1208650, mtime: '2026-10-28T07:34:40Z' },
          },
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('report-failed-with-artifacts')).toHaveTextContent(
      'Отчёт есть',
    );
    expect(screen.getByTestId('report-md')).toBeInTheDocument();
    expect(screen.queryByTestId('report-failed')).toBeNull();
  });

  it('есть и html, и md → «✓ Готов: HTML + MD»', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          artifacts: {
            md: { present: true, bytes: 21, mtime: '2026-10-27T14:01:42Z' },
            html: { present: true, bytes: 42, mtime: '2026-10-27T14:02:00Z' },
          },
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const ready = await screen.findByTestId('report-ready');
    expect(ready).toHaveTextContent('HTML + MD');
  });

  it('прогон завершён → итог карточкой и строка статистики, транскрипта нет', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'success',
          lastRunAt: new Date().toISOString(),
          artifacts: {
            md: { present: true, bytes: 300, mtime: '2026-10-27T14:01:42Z' },
            html: { present: true, bytes: 900, mtime: '2026-10-27T14:01:43Z' },
          },
        }),
      reportRun: makeReportRun({
        status: 'success',
        report: JSON.stringify({
          status: 'pass',
          summary: 'Доска и логин проверены',
        }),
        stats: {
          model: 'Claude Sonnet 4',
          userMessages: 1,
          assistantMessages: 2,
          toolCalls: 2,
          toolResults: 2,
          totalMessages: 5,
          tokens: {
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1500,
          },
          cost: 0.01,
          contextUsage: { tokens: 1500, contextWindow: 200000, percent: 42 },
        },
      }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const summary = await screen.findByTestId('report-summary');
    expect(summary).toHaveTextContent('PASS');
    expect(summary).toHaveTextContent('Доска и логин проверены');
    expect(screen.queryByTestId('report-session')).toBeNull();
    expect(await screen.findByTestId('report-tokens')).toHaveTextContent(
      'CTX 42%',
    );
  });

  it('сохранённый прогон поднимает сессию из БД после перезагрузки', async () => {
    stubFetch({
      reportStatus: () =>
        jsonResponse({
          status: 'failed',
          feedback: 'report failed: report.md отсутствует после прогона',
          startedAt: '2026-10-27T15:42:19.000Z',
          artifacts: { md: absent, html: absent },
        }),
      reportRun: makeReportRun(),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('report-expand')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('report-expand'));

    const session = await screen.findByTestId('modal-session');
    expect(session).toHaveTextContent('строка из сохранённой сессии');
  });
});

describe('TaskDetail — прогон не притворяется живым', () => {
  function overrideReportStatus(
    fetchMock: ReturnType<typeof stubFetch>,
    next: () => Promise<Response>,
  ): void {
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/report/status')
        ? next()
        : base
          ? base(input, init)
          : Promise.resolve(jsonResponse({})),
    );
  }

  it(
    'сервер не отвечает по статусу 3 раза подряд → «Генерируется» снимается и появляется ошибка',
    async () => {
      const fetchMock = stubFetch({ reportStatus: runningStatus });
      render(<TaskDetail issueId="issue-1" />);
      await screen.findByTestId('report-generating');

      overrideReportStatus(fetchMock, () =>
        Promise.reject(new Error('backend down')),
      );

      await waitFor(
        () => expect(screen.queryByTestId('report-generating')).toBeNull(),
        { timeout: 20_000 },
      );
      expect(screen.getByTestId('report-error')).toHaveTextContent(
        'не удалось узнать статус отчёта',
      );
    },
    25_000,
  );

  it(
    'одна ошибка опроса не сбивает «Генерируется»',
    async () => {
      const fetchMock = stubFetch({ reportStatus: runningStatus });
      render(<TaskDetail issueId="issue-1" />);
      await screen.findByTestId('report-generating');

      let failures = 0;
      overrideReportStatus(fetchMock, () => {
        failures += 1;
        return failures === 1
          ? Promise.reject(new Error('blip'))
          : Promise.resolve(runningStatus());
      });

      await waitFor(() => expect(failures).toBeGreaterThanOrEqual(2), {
        timeout: 20_000,
      });
      expect(screen.getByTestId('report-generating')).toBeInTheDocument();
      expect(screen.queryByTestId('report-error')).toBeNull();
    },
    25_000,
  );

  it(
    'успех без поля artifacts всё равно снимает «Генерируется»',
    async () => {
      const fetchMock = stubFetch({ reportStatus: runningStatus });
      render(<TaskDetail issueId="issue-1" />);
      await screen.findByTestId('report-generating');

      overrideReportStatus(fetchMock, () =>
        Promise.resolve(jsonResponse({ status: 'success' })),
      );

      await waitFor(
        () => expect(screen.queryByTestId('report-generating')).toBeNull(),
        { timeout: 20_000 },
      );
      expect(screen.getByTestId('report-error')).toHaveTextContent(
        'не удалось узнать статус отчёта',
      );
    },
    25_000,
  );
});

describe('TaskDetail — ручная пересборка страницы отчёта', () => {
  const mdPresent = () =>
    jsonResponse({
      status: 'success',
      lastRunAt: new Date().toISOString(),
      artifacts: {
        md: { present: true, bytes: 200, mtime: '2026-10-27T14:01:42Z' },
        html: { present: true, bytes: 900, mtime: '2026-10-27T14:01:43Z' },
      },
    });

  const mdMissing = () =>
    jsonResponse({
      status: 'idle',
      artifacts: {
        md: noArtifact,
        html: noArtifact,
      },
    });

  it('отчёта нет → кнопки пересборки нет', async () => {
    stubFetch({ reportStatus: mdMissing });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await screen.findByTestId('report-idle');
    expect(screen.queryByTestId('reembed-report')).toBeNull();
  });

  it('markdown есть → кнопка активна, клик шлёт POST и подхватывает предупреждения', async () => {
    const calls: string[] = [];
    let reembedded = false;
    const fetchMock = stubFetch({
      reportStatus: () =>
        reembedded
          ? jsonResponse({
              status: 'success',
              lastRunAt: new Date().toISOString(),
              warnings: ['скриншоты не вшиты: пропал ghost.png'],
              artifacts: {
                md: { present: true, bytes: 200, mtime: '2026-10-27T14:01:42Z' },
                html: { present: true, bytes: 900, mtime: '2026-10-27T14:01:43Z' },
              },
            })
          : mdPresent(),
      onReembed: () => {
        calls.push('reembed');
        reembedded = true;
        return jsonResponse({
          ok: true,
          embed: 'inlined 3',
          warnings: ['скриншоты не вшиты: пропал ghost.png'],
        });
      },
    });
    vi.spyOn(fetchMock, 'mockImplementation');
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const button = await screen.findByTestId('reembed-report');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(await screen.findByTestId('report-warnings')).toHaveTextContent(
      'пропал ghost.png',
    );
    expect(calls).toEqual(['reembed']);
    expect(await screen.findByTestId('reembed-report')).toBeEnabled();
  });

  it('идёт прогон → пересборка недоступна', async () => {
    stubFetch({ reportStatus: runningStatus });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await screen.findByTestId('report-generating');

    expect(screen.queryByTestId('reembed-report')).toBeNull();
  });

  it('409 от сервера → текст причины и кнопка снова доступна', async () => {
    stubFetch({
      reportStatus: mdPresent,
      onReembed: () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: 'report.md отсутствует — пересобирать нечего' }),
          text: async () => '',
        }) as Response,
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const button = await screen.findByTestId('reembed-report');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(await screen.findByTestId('report-error')).toHaveTextContent(
      'пересобирать нечего',
    );
    expect(await screen.findByTestId('reembed-report')).toBeEnabled();
  });
});
