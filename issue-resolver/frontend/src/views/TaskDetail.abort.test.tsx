import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Issue, Iteration } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [],
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
    status: 'running',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

function stubFetch(
  iteration: Iteration,
  abort: () => Promise<Response>,
) {
  const issue = makeIssue();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/abort')) return abort();
    if (url.endsWith('/step-runs')) return Promise.resolve(jsonResponse([]));
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — кнопка «Прервать»', () => {
  it('видна при running и скрыта при completed', async () => {
    stubFetch(makeIteration({ status: 'running' }), () =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    const { unmount } = render(<TaskDetail issueId="issue-1" />);
    expect(await screen.findByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByTestId('abort-iteration')).toBeInTheDocument();
    unmount();

    stubFetch(makeIteration({ status: 'completed' }), () =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    expect(screen.queryByTestId('abort-iteration')).toBeNull();
  });

  it('клик → POST /iterations/<id>/abort', async () => {
    const fetchMock = stubFetch(makeIteration({ status: 'running' }), () =>
      Promise.resolve(jsonResponse({ ok: true })),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('abort-iteration'));

    await waitFor(() => {
      const abortCall = fetchMock.mock.calls.find(([input, init]) => {
        return (
          init?.method === 'POST' &&
          String(input).endsWith('/iterations/iter-1/abort')
        );
      });
      expect(abortCall).toBeTruthy();
    });
  });

  it('409 no active step session → красный alert с телом ошибки', async () => {
    stubFetch(makeIteration({ status: 'running' }), () =>
      Promise.resolve(
        jsonResponse(
          { error: 'no active step session' },
          { ok: false, status: 409 },
        ),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('abort-iteration'));

    expect(
      await screen.findByText('no active step session'),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'no active step session',
    );
  });

  it('во время запроса кнопка disabled и показывает «Прерываем…»', async () => {
    let resolveAbort!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveAbort = resolve;
    });
    stubFetch(makeIteration({ status: 'running' }), () => pending);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('abort-iteration'));

    const button = await screen.findByRole('button', { name: 'Прерываем…' });
    expect(button).toBeDisabled();

    resolveAbort(jsonResponse({ ok: true }));
    expect(
      await screen.findByRole('button', { name: 'Прервать' }),
    ).toBeInTheDocument();
  });
});