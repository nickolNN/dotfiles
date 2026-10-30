import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Issue, Iteration, StepRunWithLog } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

const DEVOPS_SESSION = 'issue.issue-1.devops';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [
      {
        id: 'repo-1',
        repository_url: 'https://example.com/acme/app.git',
        branch_name: 'main',
        create_mr: false,
        bootstrap_enabled: true,
        created_at: '2026-10-09T00:00:00.000Z',
        updated_at: '2026-10-09T00:00:00.000Z',
      },
    ],
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

function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    json: async () => ({ error: 'devops run not found' }),
  } as Response;
}

function makeRunLog(overrides: Partial<StepRunWithLog> = {}): StepRunWithLog {
  return {
    id: 'run-1',
    issue_id: 'issue-1',
    iteration_id: null,
    step: 'devops',
    attempt: 2,
    context: 'manual',
    status: 'success',
    feedback: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:01:00.000Z',
    stdout: 'npm ci\ndone',
    stderr: '',
    events: [{ type: 'text', text: 'собрано' }] as StepRunWithLog['events'],
    stats: null,
    report: JSON.stringify({ status: 'pass', summary: 'DevOps: 1/1' }),
    screenshotsDir: null,
    ...overrides,
  } as StepRunWithLog;
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

function stubFetch(
  options: {
    devopsStatus?: () => Response;
    devopsRun?: () => Response;
    onDevopsPost?: () => Response;
    issue?: Issue;
  } = {},
) {
  const issue = options.issue ?? makeIssue();
  const iteration = makeIteration();

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/devops/status')) {
      return Promise.resolve(
        options.devopsStatus
          ? options.devopsStatus()
          : jsonResponse({ status: 'idle' }),
      );
    }
    if (url.endsWith('/devops/run')) {
      return Promise.resolve(
        options.devopsRun ? options.devopsRun() : notFoundResponse(),
      );
    }
    if (url.endsWith('/devops') && init?.method === 'POST') {
      return Promise.resolve(
        options.onDevopsPost
          ? options.onDevopsPost()
          : jsonResponse({ ok: true, devopsRunId: DEVOPS_SESSION }),
      );
    }
    if (url.endsWith('/report/status')) {
      return Promise.resolve(jsonResponse({ status: 'idle' }));
    }
    if (url.endsWith('/report/run')) {
      return Promise.resolve(notFoundResponse());
    }
    if (url.endsWith('/control') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ ok: true, data: {} }));
    }
    if (url.endsWith('/control')) {
      return Promise.resolve(jsonResponse({ error: 'no session' }));
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.endsWith('/result') && init?.method === 'HEAD') {
      return Promise.resolve({
        ok: false,
        status: 404,
        headers: { get: () => null },
      } as unknown as Response);
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function emitDevopsLog(data: string, stream: 'stdout' | 'stderr' = 'stdout') {
  act(() => {
    FakeEventSource.instances[0]?.emit({
      type: 'log',
      issueId: 'issue-1',
      stepRunId: DEVOPS_SESSION,
      stream,
      data,
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

describe('TaskDetail — DevOps задачи', () => {
  it('секция одна на задачу, а не на репозиторий', async () => {
    stubFetch({
      issue: makeIssue({
        repositories: [
          ...makeIssue().repositories,
          {
            ...makeIssue().repositories[0],
            id: 'repo-2',
            repository_url: 'https://example.com/acme/web.git',
          },
        ],
      }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findAllByTestId('repo-status-row')).toHaveLength(2);
    expect(screen.getAllByTestId('devops-section')).toHaveLength(1);
    expect(screen.getAllByTestId('devops-restart')).toHaveLength(1);
  });

  it('нет прогонов → idle и кнопка перезапуска активна', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const section = await screen.findByTestId('devops-section');
    expect(section).toHaveTextContent('DevOps');
    expect(screen.getByTestId('devops-idle')).toBeInTheDocument();
    expect(screen.getByTestId('devops-restart')).toBeEnabled();
    expect(screen.queryByTestId('devops-expand')).toBeNull();
  });

  it('клик по перезапуску шлёт POST /devops', async () => {
    const fetchMock = stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('devops-restart'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/issues/issue-1/devops'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('прогон идёт → статус running, кнопка заблокирована', async () => {
    stubFetch({
      devopsStatus: () =>
        jsonResponse({
          status: 'running',
          startedAt: '2026-10-09T00:00:00.000Z',
        }),
    });
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('devops-running')).toBeInTheDocument();
    expect(screen.getByTestId('devops-restart')).toBeDisabled();
  });

  it('живые SSE-события прогона показываются в секции', async () => {
    stubFetch({
      devopsStatus: () =>
        jsonResponse({
          status: 'running',
          startedAt: '2026-10-09T00:00:00.000Z',
        }),
    });
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByTestId('devops-running');

    emitDevopsLog('npm ci\n');

    await waitFor(() =>
      expect(screen.getByTestId('devops-live')).toHaveTextContent('npm ci'),
    );
  });

  it('успех → кнопка «Вывод» открывает сохранённую сессию', async () => {
    stubFetch({
      devopsStatus: () => jsonResponse({ status: 'success', runId: 'run-1' }),
      devopsRun: () => jsonResponse(makeRunLog()),
    });
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('devops-success')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('devops-expand'));

    expect(await screen.findByTestId('modal-session')).toHaveTextContent(
      'собрано',
    );
  });

  it('без событий сессии модалка показывает сохранённый stdout', async () => {
    stubFetch({
      devopsStatus: () => jsonResponse({ status: 'success', runId: 'run-1' }),
      devopsRun: () => jsonResponse(makeRunLog({ events: [] })),
    });
    render(<TaskDetail issueId="issue-1" />);

    fireEvent.click(await screen.findByTestId('devops-expand'));
    expect(await screen.findByTestId('modal-stdout')).toHaveTextContent(
      'npm ci',
    );
  });

  it('попытка прогона показывается в заголовке модалки', async () => {
    stubFetch({
      devopsStatus: () => jsonResponse({ status: 'success', runId: 'run-1' }),
      devopsRun: () => jsonResponse(makeRunLog({ attempt: 3 })),
    });
    render(<TaskDetail issueId="issue-1" />);

    fireEvent.click(await screen.findByTestId('devops-expand'));
    expect(await screen.findByTestId('step-log-modal')).toHaveTextContent(
      'попытка 3',
    );
  });

  it('ошибка прогона → причина из feedback', async () => {
    stubFetch({
      devopsStatus: () =>
        jsonResponse({
          status: 'failed',
          feedback: 'app: нет package.json',
        }),
    });
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('devops-failed')).toHaveTextContent(
      'нет package.json',
    );
  });

  it('сервер не отвечает на POST → текст ошибки, кнопка снова доступна', async () => {
    stubFetch({
      onDevopsPost: () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ error: 'devops factory not configured' }),
        }) as Response,
    });
    render(<TaskDetail issueId="issue-1" />);

    fireEvent.click(await screen.findByTestId('devops-restart'));

    expect(await screen.findByTestId('devops-error')).toHaveTextContent(
      'devops factory not configured',
    );
    await waitFor(() => expect(screen.getByTestId('devops-restart')).toBeEnabled());
  });

  it('сохранённый лог подтягивается при открытии задачи без перезапуска', async () => {
    stubFetch({
      devopsStatus: () => jsonResponse({ status: 'success', runId: 'run-1' }),
      devopsRun: () => jsonResponse(makeRunLog()),
    });
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('devops-expand')).toBeInTheDocument();
  });
});
