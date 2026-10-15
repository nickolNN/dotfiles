import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Issue, IssueRepository, Iteration } from '@issue-resolver/shared';
import type { MergeRequestInfo } from '../api/client';
import TaskDetail from './TaskDetail';

function makeRepo(overrides: Partial<IssueRepository> = {}): IssueRepository {
  return {
    id: 'repo-1',
    repository_url: 'https://github.com/octocat/Hello-World',
    branch_name: 'master',
    create_mr: true,
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
    status: 'running',
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

function makeMr(overrides: Partial<MergeRequestInfo> = {}): MergeRequestInfo {
  return {
    repositoryUrl: 'https://github.com/octocat/Hello-World',
    mrUrl: 'https://github.com/octocat/Hello-World/pull/42',
    mrId: '42',
    mrSource: 'github',
    status: 'open',
    commentCount: 3,
    unresolvedCount: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubFetch(
  issue: Issue,
  mergeRequests: MergeRequestInfo[],
  iterations: Iteration[] = [makeIteration()],
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/fix-after-review')) {
      return Promise.resolve(
        jsonResponse(makeIteration({ id: 'iter-2', number: 2, status: 'running' })),
      );
    }
    if (url.endsWith('/merge-requests')) {
      return Promise.resolve(jsonResponse(mergeRequests));
    }
    if (url.endsWith('/step-runs')) return Promise.resolve(jsonResponse([]));
    if (url.endsWith('/iterations') && init?.method !== 'POST') {
      return Promise.resolve(jsonResponse(iterations));
    }
    return Promise.resolve(jsonResponse(issue));
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'EventSource',
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      close = vi.fn();
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderCard() {
  render(<TaskDetail issueId="issue-1" />);
  await screen.findByText('Fix login bug');
  return await screen.findByTestId('merge-request-card');
}

describe('TaskDetail — карточка MR и «Исправить после ревью»', () => {
  it('показывает ссылку, статус и число незакрытых комментариев', async () => {
    vi.stubGlobal('fetch', stubFetch(makeIssue(), [makeMr()]));
    const card = await renderCard();

    expect(screen.getByTestId('merge-request-link')).toHaveAttribute(
      'href',
      'https://github.com/octocat/Hello-World/pull/42',
    );
    expect(screen.getByTestId('merge-request-status')).toHaveTextContent('open');
    expect(screen.getByTestId('merge-request-unresolved')).toHaveTextContent(
      'незакрытых комментариев: 2',
    );
    expect(card).toHaveAttribute('data-status', 'open');
  });

  it('совместим со stub-id бэкенда: URL вместо id → нейтральная подпись «MR»', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(makeIssue(), [
        makeMr({ mrId: 'https://github.com/octocat/Hello-World/pull/42' }),
      ]),
    );
    await renderCard();
    expect(screen.getByTestId('merge-request-link')).toHaveTextContent('MR');
    expect(screen.getByTestId('merge-request-link')).not.toHaveTextContent(
      'github.com',
    );
  });

  it('merged/closed → кнопка недоступна', async () => {
    for (const status of ['merged', 'closed'] as const) {
      cleanup();
      vi.stubGlobal(
        'fetch',
        stubFetch(makeIssue(), [makeMr({ status })]),
      );
      const card = await renderCard();
      expect(card).toHaveAttribute('data-status', status);
      expect(screen.getByTestId('fix-after-review')).toBeDisabled();
      expect(card).toHaveTextContent('правки недоступны');
    }
  });

  it('незакрытые комментарии → подтверждение с их количеством и POST', async () => {
    const fetchMock = stubFetch(makeIssue(), [makeMr()]);
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await renderCard();
    screen.getByTestId('fix-after-review').click();

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toContain('Незакрытых комментариев: 2');

    const fixCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/fix-after-review'),
    );
    expect(fixCall).toBeDefined();
    expect((fixCall?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('нет незакрытых комментариев → предупреждение при подтверждении', async () => {
    const fetchMock = stubFetch(
      makeIssue(),
      [makeMr({ unresolvedCount: 0, commentCount: 1 })],
    );
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await renderCard();
    screen.getByTestId('fix-after-review').click();

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toContain('комментариев нет');

    // Отказ в подтверждении — запрос не уходит.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/fix-after-review'),
      ),
    ).toBe(false);
  });

  it('активная итерация → кнопка disabled', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(makeIssue(), [makeMr()], [
        makeIteration({ status: 'running' }),
      ]),
    );
    await renderCard();
    expect(screen.getByTestId('fix-after-review')).toBeDisabled();
  });
});