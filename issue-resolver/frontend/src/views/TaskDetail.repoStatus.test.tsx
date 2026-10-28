import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Issue, IssueRepository, Iteration } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

function makeRepo(overrides: Partial<IssueRepository> = {}): IssueRepository {
  return {
    id: 'repo-1',
    repository_url: 'https://github.com/octocat/Hello-World',
    branch_name: 'master',
    create_mr: false,
    bootstrap_enabled: true,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [makeRepo()],
    pipeline_steps: ['resolve'],
    status: 'preparing',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function makeIteration(): Iteration {
  return {
    id: 'iter-1',
    issue_id: 'issue-1',
    number: 1,
    context: 'first try',
    review_context: '',
    is_review_need: false,
    steps: ['resolve'],
    status: 'running',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
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

  workspaceProgress(data: {
    step: string;
    repo?: string;
    status: 'running' | 'done' | 'warning' | 'error';
    message?: string;
    devPort?: number;
  }): void {
    this.emit({
      type: 'workspace_progress',
      issueId: 'issue-1',
      data: JSON.stringify(data),
      ts: '2026-10-09T00:00:00.000Z',
    });
  }
}

function stubFetch(issue: Issue) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/step-runs')) return Promise.resolve(jsonResponse([]));
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([makeIteration()]));
      }
      return Promise.resolve(jsonResponse(issue));
    }),
  );
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

async function renderAndGetRow() {
  render(<TaskDetail issueId="issue-1" />);
  await screen.findByText('Fix login bug');
  return await screen.findByTestId('repo-status-row');
}

describe('TaskDetail — сводка репозиториев в шапке', () => {
  it('показывает owner/repo, ветку и статус из SSE', async () => {
    stubFetch(makeIssue());
    const row = await renderAndGetRow();

    expect(row).toHaveAttribute('data-repo', 'octocat/Hello-World');
    expect(row).toHaveTextContent('octocat/Hello-World');
    expect(row).toHaveTextContent('master');
    expect(row).toHaveAttribute('data-status', 'pending');

    const source = FakeEventSource.instances[0];
    act(() => {
      source.workspaceProgress({
        step: 'cloning',
        repo: 'Hello-World',
        status: 'running',
      });
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'cloning'));

    act(() => {
      source.workspaceProgress({
        step: 'cloning',
        repo: 'Hello-World',
        status: 'done',
      });
      source.workspaceProgress({
        step: 'devops',
        repo: 'Hello-World',
        status: 'running',
      });
    });
    await waitFor(() =>
      expect(row).toHaveAttribute('data-status', 'devops'),
    );

    act(() => {
      source.workspaceProgress({
        step: 'installing',
        repo: 'Hello-World',
        status: 'done',
      });
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'installed'));

    act(() => {
      source.workspaceProgress({ step: 'ready', status: 'done' });
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'ready'));
  });

  it('dev_server done → в шапке видно «Dev: localhost:PORT»', async () => {
    stubFetch(makeIssue());
    const row = await renderAndGetRow();
    const source = FakeEventSource.instances[0];

    act(() => {
      source.workspaceProgress({
        step: 'installing',
        repo: 'Hello-World',
        status: 'done',
      });
      source.workspaceProgress({
        step: 'dev_server',
        repo: 'Hello-World',
        status: 'running',
      });
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'dev_server'));

    act(() => {
      source.workspaceProgress({
        step: 'dev_server',
        repo: 'Hello-World',
        status: 'done',
        message: 'localhost:5173',
        devPort: 5173,
      });
      source.workspaceProgress({ step: 'ready', status: 'done' });
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'ready'));
    expect(screen.getByTestId('repo-dev-port')).toHaveTextContent(
      'Dev: localhost:5173',
    );
  });

  it('dev_server warning → репозиторий не failed, порт не показывается', async () => {
    stubFetch(makeIssue());
    const row = await renderAndGetRow();
    const source = FakeEventSource.instances[0];

    act(() => {
      source.workspaceProgress({
        step: 'installing',
        repo: 'Hello-World',
        status: 'done',
      });
      source.workspaceProgress({
        step: 'dev_server',
        repo: 'Hello-World',
        status: 'warning',
        message: 'порт не найден',
      });
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'installed'));
    expect(screen.queryByTestId('repo-dev-port')).not.toBeInTheDocument();
  });

  it('bootstrap отключён → skipped и пометка «запуск отключён»', async () => {
    stubFetch(makeIssue({ repositories: [makeRepo({ bootstrap_enabled: false })] }));
    const row = await renderAndGetRow();

    FakeEventSource.instances[0].workspaceProgress({
      step: 'devops',
      repo: 'Hello-World',
      status: 'done',
      message: 'пропущен',
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'skipped'));
    expect(row).toHaveTextContent('(запуск отключён)');
  });

  it('ошибка клонирования → failed', async () => {
    stubFetch(makeIssue());
    const row = await renderAndGetRow();

    FakeEventSource.instances[0].workspaceProgress({
      step: 'cloning',
      repo: 'Hello-World',
      status: 'error',
      message: 'boom',
    });
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'failed'));
  });

  it('после перезагрузки задачи вне подготовки репозиторий считается готовым', async () => {
    stubFetch(makeIssue({ status: 'running' }));
    const row = await renderAndGetRow();

    expect(row).toHaveAttribute('data-status', 'ready');
  });

  it('без репозиториев блок не рендерится', async () => {
    stubFetch(makeIssue({ repositories: [] }));
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    expect(screen.queryByTestId('repo-status')).not.toBeInTheDocument();
  });
});