import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Issue, Iteration, StepAgent, StepRunWithLog } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';
import { TaskStatus, StepRunStatus, StepAgentStatus } from '@issue-resolver/shared';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [],
    pipeline_steps: ['refine', 'resolve'],
    status: TaskStatus.running,
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
    status: TaskStatus.running,
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
    status: StepRunStatus.running,
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

function makeRefineRun(mode: 'single' | 'stages'): StepRunWithLog {
  return makeStepRun({
    id: 'run-refine',
    step: 'refine',
    status: StepRunStatus.success,
    attempt: 1,
    report: JSON.stringify({
      status: 'pass',
      summary: 'refine готов',
      execution: {
        mode,
        stages:
          mode === 'stages'
            ? [{ index: 1, executors: 2, decomposition: ['бэк', 'фронт'] }]
            : undefined,
      },
    }),
  });
}

const AGENTS: StepAgent[] = [
  {
    id: 'run-resolve/worker/0',
    role: 'worker',
    index: 1,
    label: 'Исполнитель 1',
    status: StepAgentStatus.running,
    startedAt: null,
    stats: null,
  },
  {
    id: 'run-resolve/worker/1',
    role: 'worker',
    index: 2,
    label: 'Исполнитель 2',
    status: StepAgentStatus.running,
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

describe('TaskDetail — вкладки агентов шага (многоагентная stages-итерация)', () => {
  it('refine.execution.mode=stages → вкладки агентов вместо одной сессии', async () => {
    stubFetch([makeRefineRun('stages'), makeStepRun()]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const container = await screen.findByTestId('step-agents');
    expect(container).toBeInTheDocument();
    expect(screen.queryByTestId('step-session')).toBeNull();

    const tabs = screen.getAllByTestId('step-agent-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('Исполнитель 1');

    const agentSource = FakeEventSource.instances.find((source) =>
      source.url.includes('/agents/stream'),
    );
    expect(agentSource?.url).toContain('agentId=run-resolve%2Fworker%2F0');
  });

  it('переключение вкладки в карточке меняет живую сессию агента', async () => {
    stubFetch([makeRefineRun('stages'), makeStepRun()]);

    render(<TaskDetail issueId="issue-1" />);
    const tabs = await screen.findAllByTestId('step-agent-tab');

    fireEvent.click(tabs[1]);

    await waitFor(() =>
      expect(screen.getByTestId('step-agent-session')).toHaveAttribute(
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
    expect(screen.queryByTestId('step-agents')).toBeNull();
  });

  it('refine.execution.mode=single → одна step-session', async () => {
    stubFetch([makeRefineRun('single'), makeStepRun()]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.queryByTestId('step-agents')).toBeNull();
  });

  it('нечитаемый план → вкладок агентов нет, одна step-session', async () => {
    stubFetch([
      makeStepRun({
        id: 'run-refine',
        step: 'refine',
        status: StepRunStatus.success,
        report: JSON.stringify({
          status: 'pass',
          summary: 'refine готов',
          execution: { mode: 'room', executors: 2, decomposition: ['a', 'b'] },
        }),
      }),
      makeStepRun(),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.queryByTestId('step-agents')).toBeNull();
  });
});