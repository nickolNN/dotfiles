import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

/** fetch-мок: merge_requests задаются тестом в данных задачи. */
function stubFetch(mergeRequests: Issue['merge_requests']) {
  const issue = makeIssue(mergeRequests ? { merge_requests: mergeRequests } : {});
  const iteration = makeIteration();
  const stepRun = makePrStepRun();

  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
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

describe('TaskDetail — MR-квадратик в строке репозитория', () => {
  it('result.json → синий кликабельный MR в строке репо', async () => {
    stubFetch([
      {
        repository_url: 'https://github.com/acme/app.git',
        url: 'https://github.com/acme/app/pull/1',
        title: 'feat: fix login',
      },
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const link = await screen.findByTestId('repo-mr-link');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveTextContent('MR');
    // Серый квадратик не рендерится когда есть синяя ссылка.
    expect(screen.queryByTestId('repo-mr-badge')).toBeNull();
  });

  it('нет result.json → серый квадратик MR (ожидается)', async () => {
    stubFetch(null);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const badge = await screen.findByTestId('repo-mr-badge');
    expect(badge).toHaveTextContent('MR');
    expect(badge.tagName).toBe('SPAN');
    // Серый цвет через Tailwind `#555`.
    expect(badge.className).toContain('text-[#555]');
    // Синей ссылки нет.
    expect(screen.queryByTestId('repo-mr-link')).toBeNull();
  });

  it('create_mr=false → квадратик не показывается', async () => {
    const issue = makeIssue({
      repositories: [
        makeRepository({
          id: 'repo-b',
          repository_url: 'https://github.com/acme/lib.git',
          create_mr: false,
        }),
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/result/files')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([makeIteration()]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(screen.queryByTestId('repo-mr-badge')).toBeNull();
    expect(screen.queryByTestId('repo-mr-link')).toBeNull();
  });

  it('pr_error → серый квадратик (MR не создался)', async () => {
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

    // Серый квадратик — MR ожидался, но не создался.
    expect(await screen.findByTestId('repo-mr-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-mr-link')).toBeNull();
  });

  it('два репозитория: у одного MR создан, у другого — нет', async () => {
    const issue = makeIssue({
      repositories: [
        makeRepository({
          id: 'repo-a',
          repository_url: 'https://github.com/acme/app.git',
          create_mr: true,
        }),
        makeRepository({
          id: 'repo-b',
          repository_url: 'https://github.com/acme/lib.git',
          create_mr: true,
        }),
      ],
      merge_requests: [
        {
          repository_url: 'https://github.com/acme/app.git',
          url: 'https://github.com/acme/app/pull/1',
        },
      ],
    });
    const iteration = makeIteration();
    const stepRun = makePrStepRun();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/result/files/content') && url.includes('result.json')) {
          return Promise.resolve(
            textResponse(
              JSON.stringify({
                merge_requests: [
                  {
                    repository_url: 'https://github.com/acme/app.git',
                    url: 'https://github.com/acme/app/pull/1',
                  },
                ],
              }),
            ),
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
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    // Одна синяя ссылка и один серый квадратик.
    const links = await screen.findAllByTestId('repo-mr-link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://github.com/acme/app/pull/1');

    const badges = screen.getAllByTestId('repo-mr-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('MR');
  });
});