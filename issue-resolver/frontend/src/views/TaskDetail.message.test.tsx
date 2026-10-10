import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  Issue,
  Iteration,
  StepRunWithLog,
} from '@issue-resolver/shared';
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

function makeStepRun(
  overrides: Partial<StepRunWithLog> = {},
): StepRunWithLog {
  return {
    id: 'run-1',
    iteration_id: 'iter-1',
    step: 'resolve',
    attempt: 1,
    status: 'running',
    context: '',
    feedback: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    stdout: '',
    stderr: '',
    events: [],
    stats: null,
    report: null,
    screenshots_dir: null,
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

/** Различает GET (issue/iterations/step-runs) и POST message. */
function stubFetch(
  postMessage: () => Promise<Response>,
  stepRuns: StepRunWithLog[] = [makeStepRun()],
) {
  const issue = makeIssue();
  const iteration = makeIteration();

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/message')) {
      return postMessage();
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse(stepRuns));
    }
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

describe('TaskDetail — отправка сообщения агенту', () => {
  it('модалка: 409 no active step session → alert с текстом ошибки', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(
          { error: 'no active step session' },
          { ok: false, status: 409 },
        ),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));

    const modal = screen.getByTestId('step-log-modal');
    fireEvent.change(within(modal).getByLabelText('Сообщение'), {
      target: { value: 'hi' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Отправить' }));

    expect(
      await screen.findByText('no active step session'),
    ).toBeInTheDocument();
    expect(within(modal).getByRole('alert')).toHaveTextContent(
      'no active step session',
    );
  });

  it('модалка: steer у running-шага шлёт sendIterationMessage(activeIterationId)', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));

    const modal = screen.getByTestId('step-log-modal');
    fireEvent.change(within(modal).getByLabelText('Сообщение'), {
      target: { value: 'steer me' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/message'),
      );
      expect(postCall).toBeTruthy();
      const [url, init] = postCall!;
      expect(String(url).endsWith('/iterations/iter-1/message')).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({ message: 'steer me' });
    });
  });

  it('модалка: «Прервать» зовёт abortIteration(activeIterationId)', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));

    const modal = screen.getByTestId('step-log-modal');
    fireEvent.click(within(modal).getByTestId('abort-iteration-modal'));

    await waitFor(() => {
      const abortCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/abort'),
      );
      expect(abortCall).toBeTruthy();
      expect(String(abortCall![0]).endsWith('/iterations/iter-1/abort')).toBe(
        true,
      );
    });
  });

  it('модалка: у завершённого шага нет steer-формы и «Прервать»', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ ok: true })), [
      makeStepRun({ id: 'run-success', status: 'success', stdout: 'done' }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));

    const modal = screen.getByTestId('step-log-modal');
    expect(within(modal).queryByLabelText('Сообщение')).toBeNull();
    expect(within(modal).queryByTestId('abort-iteration-modal')).toBeNull();
  });
});