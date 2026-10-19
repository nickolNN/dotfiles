import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Issue, IssueRepository, Iteration, StepRunWithLog } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

function makeRepository(
  overrides: Partial<IssueRepository> = {},
): IssueRepository {
  return {
    id: 'repo-a',
    repository_url: 'https://github.com/acme/app.git',
    branch_name: 'main',
    create_mr: true,
    bootstrap_enabled: true,
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [makeRepository()],
    pipeline_steps: ['resolve', 'pr'],
    desired_result: 'md',
    status: 'pending',
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
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
    steps: ['resolve', 'pr'],
    status: 'completed',
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function makePrStepRun(overrides: Partial<StepRunWithLog> = {}): StepRunWithLog {
  return {
    id: 'run-pr',
    iteration_id: 'iter-1',
    step: 'pr',
    attempt: 1,
    status: 'success',
    context: '',
    feedback: null,
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    stdout: '',
    stderr: '',
    events: [],
    stats: null,
    report: '{"status":"pass","summary":"ok"}',
    screenshots_dir: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function textResponse(
  body: string,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => body,
  } as Response;
}

/** Минимальный фейк EventSource (как в TaskDetail.live.test.tsx). */
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

/** fetch-мок: `result.json` задаётся тестом, `/result/files` — пустой список. */
function stubFetch(resultJson: string | null) {
  const issue = makeIssue();
  const iteration = makeIteration();
  const stepRun = makePrStepRun();

  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/result/files/content')) {
      return Promise.resolve(
        resultJson === null
          ? textResponse('', { ok: false, status: 404 })
          : textResponse(resultJson),
      );
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse([stepRun]));
    }
    if (url.endsWith('/result/files')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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

describe('TaskDetail — MR-ссылка в шапке задачи', () => {
  it('result.json → ссылка на MR дублируется в шапке', async () => {
    stubFetch(
      JSON.stringify({
        merge_requests: [
          {
            repository_url: 'https://github.com/acme/app.git',
            url: 'https://github.com/acme/app/pull/1',
            title: 'feat: fix login',
          },
        ],
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const link = await screen.findByTestId('task-mr-link');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveTextContent('MR:');
    expect(link).toHaveTextContent('https://github.com/acme/app/pull/1');
  });

  it('живое SSE-событие stream: mr → ссылка появляется без перезагрузки', async () => {
    stubFetch(null);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'log',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        stepRunId: 'run-pr',
        stream: 'mr',
        data: 'https://github.com/acme/app/pull/2',
        ts: '2026-10-16T00:00:00.000Z',
      });
    });

    const link = await screen.findByTestId('task-mr-link');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/2');
  });

  it('pr success + create_mr, но result.json отсутствует → плейсхолдер', async () => {
    stubFetch(null);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('task-mr-placeholder')).toHaveTextContent(
      'MR создан, но ссылка недоступна',
    );
    expect(screen.queryByTestId('task-mr-link')).toBeNull();
  });

  it('pr_error → без ссылки и без плейсхолдера', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = makePrStepRun({
      report: JSON.stringify({
        status: 'pass',
        summary: 'ok',
        pr_error: 'commit/push: rejected',
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/result/files/content')) {
          return Promise.resolve(textResponse('', { ok: false, status: 404 }));
        }
        if (url.endsWith('/step-runs')) {
          return Promise.resolve(jsonResponse([stepRun]));
        }
        if (url.endsWith('/result/files')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([iteration]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    await screen.findByTestId('step-pr-error');
    expect(screen.queryByTestId('task-mr-placeholder')).toBeNull();
    expect(screen.queryByTestId('task-mr-link')).toBeNull();
  });
});