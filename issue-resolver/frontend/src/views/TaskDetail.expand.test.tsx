import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const richRun = makeStepRun({
  stdout: 'building...',
  stderr: 'warning: deprecated',
  report: '## Итог\nвсё хорошо',
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — полноэкранный вид шага', () => {
  it('клик «Развернуть» открывает modal с stdout/stderr/report', async () => {
    stubFetch([richRun]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('step-expand'));

    const modal = screen.getByTestId('step-log-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId('modal-stdout')).toHaveTextContent('building...');
    expect(screen.getByTestId('modal-stderr')).toHaveTextContent(
      'warning: deprecated',
    );
    expect(screen.getByTestId('modal-report')).toHaveTextContent('Итог');
  });

  it('закрывается по крестику', async () => {
    stubFetch([richRun]);
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('step-expand'));
    expect(screen.getByTestId('step-log-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('step-log-modal-close'));
    expect(screen.queryByTestId('step-log-modal')).toBeNull();
  });

  it('закрывается по Escape', async () => {
    stubFetch([richRun]);
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('step-expand'));
    expect(screen.getByTestId('step-log-modal')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('step-log-modal')).toBeNull();
  });

  it('закрывается по клику на подложку', async () => {
    stubFetch([richRun]);
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('step-expand'));
    expect(screen.getByTestId('step-log-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('step-log-modal'));
    expect(screen.queryByTestId('step-log-modal')).toBeNull();
  });

  it('модалка: строка статистики закреплена вне скролл-области', async () => {
    stubFetch([
      makeStepRun({
        events: [{ type: 'text', text: 'шаг пошёл' }],
        stdout: 'building...',
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: {
            input: 1000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1000,
          },
          cost: 0.001,
          contextUsage: null,
        },
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('step-expand'));

    const scroll = screen.getByTestId('step-log-scroll');
    const pinned = scroll.parentElement?.querySelector(
      '[data-testid="session-stats"]',
    );
    // SessionView внутри скролл-области отдаёт футер наружу (showFooter=false).
    expect(within(scroll).queryByTestId('session-stats')).toBeNull();
    expect(pinned).not.toBeNull();
    expect(within(pinned as HTMLElement).getByTestId('session-token-in')).toHaveTextContent(
      '1k',
    );
  });

  it('пустые секции в modal не рендерятся', async () => {
    stubFetch([makeStepRun({ stdout: '', stderr: '', report: null })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(await screen.findByTestId('step-expand'));
    expect(screen.getByTestId('step-log-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('modal-stdout')).toBeNull();
    expect(screen.queryByTestId('modal-stderr')).toBeNull();
    expect(screen.queryByTestId('modal-report')).toBeNull();
  });
});