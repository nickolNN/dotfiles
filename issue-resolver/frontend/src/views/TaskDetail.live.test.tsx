import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** Минимальный фейк EventSource: запоминает URL, закрытие и отдаёт onmessage вручную. */
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

function stubFetch() {
  const issue = makeIssue();
  const iteration = makeIteration();
  const calls = { iterations: 0, stepRuns: 0 };

  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/step-runs')) {
      calls.stepRuns += 1;
      return Promise.resolve(jsonResponse([]));
    }
    if (url.endsWith('/iterations')) {
      calls.iterations += 1;
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
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

describe('TaskDetail — live SSE', () => {
  it('подписывается на /issues/<id>/stream', async () => {
    stubFetch();

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(
      FakeEventSource.instances[0].url.endsWith('/issues/issue-1/stream'),
    ).toBe(true);
  });

  it('iteration_status completed → перезапрашивает issue/iterations', async () => {
    const { calls } = stubFetch();

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() => expect(calls.iterations).toBe(1));

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'iteration_status',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        data: JSON.stringify({
          iterationId: 'iter-1',
          status: 'completed',
          needsInput: false,
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    await waitFor(() => expect(calls.iterations).toBeGreaterThanOrEqual(2));
  });

  it('iteration_status running → без перезапроса', async () => {
    const { calls } = stubFetch();

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() => expect(calls.iterations).toBe(1));

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'iteration_status',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        data: JSON.stringify({
          iterationId: 'iter-1',
          status: 'running',
          needsInput: false,
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    expect(calls.iterations).toBe(1);
  });

  it('модалка: новые события авто-скроллят вывод вниз', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = {
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
      events: [{ type: 'text', text: 'первый' }],
      stats: null,
      report: null,
      screenshots_dir: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/step-runs')) {
        return Promise.resolve(jsonResponse([stepRun]));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([iteration]));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));

    const scroll = screen.getByTestId('step-log-scroll');
    Object.defineProperty(scroll, 'scrollHeight', {
      configurable: true,
      value: 777,
    });
    scroll.scrollTop = 0;

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_event',
        issueId: 'issue-1',
        stepRunId: 'run-1',
        data: JSON.stringify({
          stepRunId: 'run-1',
          event: { type: 'text', text: 'второй' },
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    await waitFor(() => expect(scroll.scrollTop).toBe(777));
    expect(within(scroll).getByText('второй')).toBeInTheDocument();
  });

  it('карточка шага: новые события авто-скроллят вывод вниз', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = {
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
      events: [{ type: 'text', text: 'первый' }],
      stats: null,
      report: null,
      screenshots_dir: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/step-runs')) {
        return Promise.resolve(jsonResponse([stepRun]));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([iteration]));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const session = await screen.findByTestId('step-session');
    const scroll = session.parentElement as HTMLElement;
    Object.defineProperty(scroll, 'scrollHeight', {
      configurable: true,
      value: 777,
    });
    scroll.scrollTop = 0;

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_event',
        issueId: 'issue-1',
        stepRunId: 'run-1',
        data: JSON.stringify({
          stepRunId: 'run-1',
          event: { type: 'text', text: 'второй' },
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    await waitFor(() => expect(scroll.scrollTop).toBe(777));
    expect(within(session).getByText('второй')).toBeInTheDocument();
  });

  it('размонтирование закрывает EventSource', async () => {
    stubFetch();

    const { unmount } = render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    const source = FakeEventSource.instances[0];

    unmount();

    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('pending-шаг сразу в live-режиме, step_status running сохраняет session и баннер', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = {
      id: 'run-1',
      iteration_id: 'iter-1',
      step: 'resolve',
      attempt: 1,
      status: 'pending',
      context: '',
      feedback: null,
      created_at: '2026-10-09T00:00:00.000Z',
      updated_at: '2026-10-09T00:00:00.000Z',
      stdout: '',
      stderr: '',
      events: [
        {
          type: 'question',
          id: 'q-1',
          method: 'select',
          title: 'Какой подход выбрать?',
          options: ['вариант-a', 'вариант-b'],
        },
      ],
      stats: null,
      report: null,
      screenshots_dir: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/step-runs')) {
        return Promise.resolve(jsonResponse([stepRun]));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([iteration]));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // Снапшот pending: шаг уже активен → карточка рендерит SessionView + баннер.
    expect(screen.getByTestId('step-session')).toBeInTheDocument();
    expect(screen.getByTestId('step-pending-question')).toHaveTextContent(
      'Какой подход выбрать?',
    );

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_status',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        stepRunId: 'run-1',
        data: 'running',
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('step-session')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('step-pending-question')).toHaveTextContent(
      'Какой подход выбрать?',
    );
  });

  it('развёрнутая модалка шага показывает баннер вопроса перед SessionView', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = {
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
      events: [
        {
          type: 'question',
          id: 'q-1',
          method: 'select',
          title: 'Какой подход выбрать?',
          options: ['вариант-a', 'вариант-b'],
        },
      ],
      stats: null,
      report: null,
      screenshots_dir: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/step-runs')) {
        return Promise.resolve(jsonResponse([stepRun]));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([iteration]));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));

    const scroll = screen.getByTestId('step-log-scroll');
    const banner = within(scroll).getByTestId('step-pending-question');
    expect(banner).toHaveTextContent('Какой подход выбрать?');
    expect(banner).toHaveTextContent('вариант-a / вариант-b');

    const session = within(scroll).getByTestId('modal-session');
    expect(
      banner.compareDocumentPosition(session) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});