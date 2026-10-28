import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type {
  Issue,
  Iteration,
  RoomAgent,
  StepRunWithLog,
} from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [],
    pipeline_steps: ['refine', 'resolve'],
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
    steps: ['refine', 'resolve'],
    status: 'running',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function makeStepRun(overrides: Partial<StepRunWithLog> = {}): StepRunWithLog {
  return {
    id: 'run-resolve',
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
    events: [],
    stats: null,
    report: null,
    screenshots_dir: null,
    ...overrides,
  };
}

/** refine-прогон с отчётом, несущим план исполнения. */
function makeRefineRun(mode: 'single' | 'room'): StepRunWithLog {
  return makeStepRun({
    id: 'run-refine',
    step: 'refine',
    status: 'success',
    attempt: 1,
    report: JSON.stringify({
      status: 'pass',
      summary: 'refine готов',
      execution: { mode, executors: mode === 'room' ? 2 : undefined },
    }),
  });
}

const AGENTS: RoomAgent[] = [
  {
    id: 'run-resolve/worker/0',
    role: 'worker',
    index: 1,
    label: 'Исполнитель 1',
    status: 'running',
    startedAt: null,
    stats: null,
  },
  {
    id: 'run-resolve/worker/1',
    role: 'worker',
    index: 2,
    label: 'Исполнитель 2',
    status: 'running',
    startedAt: null,
    stats: null,
  },
];

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function notFound(): Response {
  return { ok: false, status: 404, json: async () => ({}) } as Response;
}

function stubFetch(stepRuns: StepRunWithLog[]) {
  const issue = makeIssue();
  const iteration = makeIteration();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/agents')) {
      return Promise.resolve(jsonResponse(AGENTS));
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse(stepRuns));
    }
    if (url.endsWith('/files')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.endsWith('/question-answers')) {
      return Promise.resolve(jsonResponse({ answered_ids: [] }));
    }
    if (url.endsWith('/control')) {
      return Promise.resolve(notFound());
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Фейк EventSource: запоминает URL/закрытие и отдаёт onmessage вручную. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
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

describe('TaskDetail — вкладки агентов комнаты (room-режим resolve)', () => {
  it('refine.execution.mode=room → вкладки агентов вместо одной сессии', async () => {
    stubFetch([makeRefineRun('room'), makeStepRun()]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const container = await screen.findByTestId('room-agents');
    expect(container).toBeInTheDocument();
    // Одиночная сессия resolve не рендерится — её место занимают вкладки.
    expect(screen.queryByTestId('step-session')).toBeNull();

    const tabs = screen.getAllByTestId('room-agent-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('Исполнитель 1');

    // Открыт per-agent SSE, а не общий поток шага.
    const agentSource = FakeEventSource.instances.find((source) =>
      source.url.includes('/agents/stream'),
    );
    expect(agentSource?.url).toContain('agentId=run-resolve%2Fworker%2F0');
  });

  it('переключение вкладки в карточке меняет живую сессию агента', async () => {
    stubFetch([makeRefineRun('room'), makeStepRun()]);

    render(<TaskDetail issueId="issue-1" />);
    const tabs = await screen.findAllByTestId('room-agent-tab');

    fireEvent.click(tabs[1]);

    await waitFor(() =>
      expect(screen.getByTestId('room-agent-session')).toHaveAttribute(
        'data-agent-id',
        'run-resolve/worker/1',
      ),
    );
  });

  it('single-режим (нет refine-отчёта) → как раньше: одна step-session', async () => {
    stubFetch([makeStepRun()]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.queryByTestId('room-agents')).toBeNull();
  });

  it('refine.execution.mode=single → одна step-session', async () => {
    stubFetch([makeRefineRun('single'), makeStepRun()]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.queryByTestId('room-agents')).toBeNull();
  });
});