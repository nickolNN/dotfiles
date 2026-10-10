import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type { Issue, Iteration, StepRunWithLog } from '@issue-resolver/shared';
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
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubFetch(stepRuns: StepRunWithLog[]) {
  const issue = makeIssue();
  const iteration = makeIteration();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
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

/** Минимальный фейк EventSource: отдаёт onmessage вручную. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
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

describe('TaskDetail — результат шага', () => {
  it('карточка рендерит session-события (step-session), report/stdout скрыты', async () => {
    stubFetch([
      makeStepRun({
        status: 'running',
        stdout: 'raw-fallback',
        stderr: 'raw-error',
        report: '## Итог\nвсё хорошо',
        events: [{ type: 'text', text: 'работаю над задачей' }],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const session = await screen.findByTestId('step-session');
    expect(session).toHaveTextContent('работаю над задачей');
    expect(screen.queryByTestId('step-report')).toBeNull();
    expect(screen.queryByText('Итог')).toBeNull();
    expect(screen.queryByText(/result null/)).toBeNull();
    expect(screen.queryByTestId('step-stdout')).toBeNull();
    expect(screen.queryByTestId('step-stderr')).toBeNull();
  });

  it('карточка running-шага без событий → пустой session-вывод', async () => {
    stubFetch([makeStepRun({ status: 'running', stdout: 'raw-fallback' })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.getByTestId('session-view-empty')).toBeInTheDocument();
    expect(screen.queryByText('Результат отсутствует.')).toBeNull();
    expect(screen.queryByTestId('step-report')).toBeNull();
  });

  it('карточка завершённого шага без отчёта → «Результат отсутствует.»', async () => {
    stubFetch([makeStepRun({ status: 'success', report: null })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(
      await screen.findByText('Результат отсутствует.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('step-session')).toBeNull();
    expect(screen.queryByTestId('step-summary')).toBeNull();
  });

  it('карточка pending-шага → живой session + баннер вопроса, без «Результат отсутствует.»', async () => {
    stubFetch([
      makeStepRun({
        status: 'pending',
        stdout: 'raw-fallback',
        events: [
          {
            type: 'question',
            id: 'q-1',
            method: 'select',
            title: 'Какой подход выбрать?',
            options: ['вариант-a', 'вариант-b'],
          },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.getByTestId('step-pending-question')).toBeInTheDocument();
    expect(screen.queryByText('Результат отсутствует.')).toBeNull();
  });

  it('карточка failed-шага без отчёта → «Результат отсутствует.»', async () => {
    stubFetch([makeStepRun({ status: 'failed', report: null })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(
      await screen.findByText('Результат отсутствует.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('step-session')).toBeNull();
  });

  it('полноэкранный modal показывает SessionView по events', async () => {
    stubFetch([
      makeStepRun({
        stdout: 'raw-fallback',
        events: [
          {
            type: 'tool_result',
            toolCallId: 'call-1',
            toolName: 'bash',
            isError: true,
            durationMs: 5,
            resultText: 'boom',
          },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('step-expand'));

    const modal = within(screen.getByTestId('step-log-modal'));
    expect(modal.getByTestId('modal-session')).toBeInTheDocument();
    expect(modal.getByTestId('tool-result-bash')).toHaveAttribute(
      'data-error',
      'true',
    );
    expect(modal.queryByTestId('modal-stdout')).toBeNull();
  });

  it('SSE step_event доходит до SessionView модалки по stepRunId (live)', async () => {
    stubFetch([makeStepRun({ id: 'run-1', status: 'running' })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_event',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        stepRunId: 'run-1',
        stream: 'system',
        data: JSON.stringify({
          stepRunId: 'run-1',
          event: { type: 'text', text: 'живой ответ агента' },
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    const modal = within(screen.getByTestId('step-log-modal'));
    expect(await modal.findByTestId('session-view')).toBeInTheDocument();
    expect(modal.getByText('живой ответ агента')).toBeInTheDocument();
  });

  it('step_event для неизвестного stepRunId не роняет карточку', async () => {
    stubFetch([makeStepRun({ id: 'run-1', status: 'running', stdout: 'raw-fallback' })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_event',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        stepRunId: 'run-unknown',
        stream: 'system',
        data: JSON.stringify({
          stepRunId: 'run-unknown',
          event: { type: 'text', text: 'чужая сессия' },
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    const session = await screen.findByTestId('step-session');
    expect(session).not.toHaveTextContent('чужая сессия');
    expect(screen.queryByText('Результат отсутствует.')).toBeNull();
  });

  it('битый data у step_event не роняет live-лог', async () => {
    stubFetch([makeStepRun({ id: 'run-1', status: 'running', stdout: 'raw-fallback' })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_event',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        data: 'not-json',
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.getByTestId('session-view-empty')).toBeInTheDocument();
    expect(screen.queryByText('Результат отсутствует.')).toBeNull();
  });
});