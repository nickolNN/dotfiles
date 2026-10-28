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
    status: 'pending',
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
  iterations: () => Iteration[],
  repeat: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const issue = makeIssue();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/repeat')) {
      return repeat(url, init);
    }
    if (url.endsWith('/step-runs')) return Promise.resolve(jsonResponse([]));
    if (url.endsWith('/models')) return Promise.resolve(jsonResponse([]));
    if (url.endsWith('/files')) return Promise.resolve(jsonResponse([]));
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse(iterations()));
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

describe('TaskDetail — кнопка «↻ Повторить»', () => {
  it('видна у каждой итерации независимо от статуса', async () => {
    const list = [
      makeIteration({ id: 'iter-1', number: 1, status: 'completed' }),
      makeIteration({ id: 'iter-2', number: 2, status: 'running' }),
    ];
    stubFetch(
      () => list,
      () => Promise.resolve(jsonResponse(makeIteration())),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(screen.getAllByTestId('repeat-iteration')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '↻ Повторить' })).toHaveLength(
      2,
    );
  });

  it('активная итерация (running/pending) — кнопка Повторить disabled', async () => {
    const list = [
      makeIteration({ id: 'iter-1', number: 1, status: 'completed' }),
      makeIteration({ id: 'iter-2', number: 2, status: 'running' }),
      makeIteration({ id: 'iter-3', number: 3, status: 'pending' }),
    ];
    stubFetch(
      () => list,
      () => Promise.resolve(jsonResponse(makeIteration())),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const buttons = screen.getAllByTestId<HTMLButtonElement>(
      'repeat-iteration',
    );
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
    expect(buttons[2]).not.toBeDisabled();
  });

  it('клик → POST /iterations/<id>/repeat и обновляет список, новая выбрана', async () => {
    let list = [makeIteration({ id: 'iter-1', number: 1 })];
    const created = makeIteration({ id: 'iter-2', number: 2 });
    const fetchMock = stubFetch(
      () => list,
      () => {
        list = [...list, created];
        return Promise.resolve(jsonResponse(created, { status: 201 }));
      },
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('repeat-iteration'));

    await waitFor(() => {
      const repeatCall = fetchMock.mock.calls.find(([input, init]) => {
        return (
          init?.method === 'POST' &&
          String(input).endsWith('/iterations/iter-1/repeat')
        );
      });
      expect(repeatCall).toBeTruthy();
      expect(repeatCall?.[1]?.body).toBeUndefined();
    });

    expect(await screen.findByText('Итерация #2')).toBeInTheDocument();
    const selectedCard = screen.getByText('Итерация #2').closest('li');
    expect(selectedCard?.className).toContain('ring-1');
  });

  it('во время запроса кнопка disabled и показывает «Повторяем…»', async () => {
    let resolveRepeat!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRepeat = resolve;
    });
    stubFetch(
      () => [makeIteration({ id: 'iter-1', number: 1 })],
      () => pending,
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('repeat-iteration'));

    const button = await screen.findByRole('button', { name: 'Повторяем…' });
    expect(button).toBeDisabled();

    resolveRepeat(jsonResponse(makeIteration({ id: 'iter-2', number: 2 })));
    expect(
      await screen.findByRole('button', { name: '↻ Повторить' }),
    ).toBeInTheDocument();
  });

  it('ошибка 404 → красный alert с телом ошибки', async () => {
    stubFetch(
      () => [makeIteration({ id: 'iter-1', number: 1 })],
      () =>
        Promise.resolve(
          jsonResponse(
            { error: 'iteration not found' },
            { ok: false, status: 404 },
          ),
        ),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(screen.getByTestId('repeat-iteration'));

    expect(
      await screen.findByText('iteration not found'),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('iteration not found');
  });
});