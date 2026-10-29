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
    if (url.endsWith('/report/status')) {
      return Promise.resolve(
        jsonResponse({
          status: 'idle',
          artifacts: {
            md: { present: false, bytes: 0, mtime: null },
            html: { present: false, bytes: 0, mtime: null },
          },
        }),
      );
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

  it('iteration_status question → янтарный статус задачи, ответ → снова running', async () => {
    stubFetch();

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'iteration_status',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        data: JSON.stringify({
          iterationId: 'iter-1',
          status: 'question',
          needsInput: true,
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    const questionLabel = await screen.findByText('question');
    expect(questionLabel).toHaveStyle({ color: '#FFB000' });

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

    await waitFor(() =>
      expect(screen.queryByText('question')).not.toBeInTheDocument(),
    );
  });

  it('step_status нового прогона (refine→resolve) → список шагов перезапрашивается, Resolve появляется', async () => {
    const issue = makeIssue({ pipeline_steps: ['refine', 'resolve'] });
    const iteration = makeIteration({ steps: ['refine', 'resolve'] });
    const refineRun = {
      id: 'run-refine',
      issue_id: 'issue-1',
      iteration_id: 'iter-1',
      step: 'refine',
      attempt: 1,
      status: 'success',
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
    };
    const resolveRun = {
      ...refineRun,
      id: 'run-resolve',
      step: 'resolve',
      status: 'running',
    };
    let runs = [refineRun];
    const stepRunCalls = { count: 0 };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/step-runs')) {
        stepRunCalls.count += 1;
        return Promise.resolve(jsonResponse(runs));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([iteration]));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    const steps = within(await screen.findByTestId('iteration-steps'));
    expect(await steps.findByText('Планирование')).toBeInTheDocument();
    expect(steps.queryByText('Исполнение')).toBeNull();

    runs = [refineRun, resolveRun];
    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_status',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        stepRunId: 'run-resolve',
        data: 'running',
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(
        within(screen.getByTestId('iteration-steps')).getByText('Исполнение'),
      ).toBeInTheDocument();
    });
    expect(stepRunCalls.count).toBeGreaterThanOrEqual(2);
  });

  it('модалка: новые события авто-скроллят вывод вниз', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = {
      id: 'run-1',
      issue_id: 'issue-1',
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
    Object.defineProperty(scroll, 'clientHeight', {
      configurable: true,
      value: 300,
    });
    scroll.scrollTop = 477;

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
      issue_id: 'issue-1',
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
    Object.defineProperty(scroll, 'clientHeight', {
      configurable: true,
      value: 300,
    });
    scroll.scrollTop = 477;

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

  it('pending-шаг сразу в live-режиме, step_status running сохраняет session и inline-вопрос', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = {
      id: 'run-1',
      issue_id: 'issue-1',
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

    expect(screen.getByTestId('step-session')).toBeInTheDocument();
    expect(screen.getByTestId('inline-question')).toHaveTextContent(
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
    expect(screen.getByTestId('inline-question')).toHaveTextContent(
      'Какой подход выбрать?',
    );
  });

  it('развёрнутая модалка шага показывает SessionView, а вопрос — inline вне модалки', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const stepRun = {
      id: 'run-1',
      issue_id: 'issue-1',
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
    expect(within(scroll).getByTestId('modal-session')).toBeInTheDocument();
    expect(within(scroll).queryByTestId('inline-question')).toBeNull();

    expect(screen.getByTestId('inline-question')).toHaveTextContent(
      'Какой подход выбрать?',
    );
  });
});