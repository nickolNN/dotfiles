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

function stubFetch(stepRuns: () => Promise<Response>) {
  const issue = makeIssue();
  const iteration = makeIteration();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/step-runs')) return stepRuns();
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubFetchIterations(
  iterations: Iteration[],
  stepRunsByIteration: Record<string, StepRunWithLog[]>,
) {
  const issue = makeIssue();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const stepMatch = url.match(/\/iterations\/([^/]+)\/step-runs$/);
    if (stepMatch) {
      return Promise.resolve(
        jsonResponse(stepRunsByIteration[stepMatch[1]] ?? []),
      );
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse(iterations));
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

describe('TaskDetail — шаги выбранной итерации', () => {
  it('грузит step-runs последней итерации и рендерит step/attempt/status', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse([
          makeStepRun({ id: 'run-1', step: 'resolve', attempt: 1, status: 'success' }),
          makeStepRun({ id: 'run-2', step: 'test', attempt: 2, status: 'failed' }),
        ]),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);

    const steps = within(await screen.findByTestId('iteration-steps'));
    expect(await steps.findByText('Resolve')).toBeInTheDocument();
    expect(steps.getByText('success')).toBeInTheDocument();
    expect(steps.getByText('Test')).toBeInTheDocument();
    expect(steps.getByText('попытка 2')).toBeInTheDocument();
    expect(steps.getByText('failed')).toBeInTheDocument();
  });

  it('пустой список step-runs → «Шагов пока нет», карточка не падает', async () => {
    stubFetch(() => Promise.resolve(jsonResponse([])));

    render(<TaskDetail issueId="issue-1" />);

    const steps = within(await screen.findByTestId('iteration-steps'));
    expect(await steps.findByText('Шагов пока нет')).toBeInTheDocument();
    expect(screen.getByText('Итерация #1')).toBeInTheDocument();
  });

  it('ошибка загрузки шагов → inline-заглушка, итерация остаётся', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);

    const steps = within(await screen.findByTestId('iteration-steps'));
    expect(
      await steps.findByText(/Не удалось загрузить шаги/),
    ).toBeInTheDocument();
    expect(screen.getByText('Итерация #1')).toBeInTheDocument();
  });

  it('клик по не-последней итерации выбирает её и рендерит её шаги', async () => {
    const iter1 = makeIteration({ id: 'iter-1', number: 1, context: 'first' });
    const iter2 = makeIteration({ id: 'iter-2', number: 2, context: 'second' });
    stubFetchIterations([iter1, iter2], {
      'iter-1': [
        makeStepRun({
          id: 'run-a',
          iteration_id: 'iter-1',
          step: 'resolve',
          status: 'success',
        }),
      ],
      'iter-2': [
        makeStepRun({
          id: 'run-b',
          iteration_id: 'iter-2',
          step: 'test',
          status: 'running',
        }),
      ],
    });

    render(<TaskDetail issueId="issue-1" />);

    const defaultSteps = within(await screen.findByTestId('iteration-steps'));
    expect(await defaultSteps.findByText('Test')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Итерация #1'));

    await waitFor(() => {
      const selectedSteps = within(screen.getByTestId('iteration-steps'));
      expect(selectedSteps.getByText('Resolve')).toBeInTheDocument();
      expect(selectedSteps.queryByText('Test')).toBeNull();
    });
  });

  it('карточка рендерит session-события в step-session фикс. высоты; report/stdout скрыты', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse([
          makeStepRun({
            id: 'run-1',
            status: 'running',
            stdout: 'building...\nok',
            stderr: 'warning: deprecated',
            report: '## Итог\nвсё хорошо',
            events: [{ type: 'text', text: 'работаю над задачей' }],
          }),
        ]),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);

    const session = await screen.findByTestId('step-session');
    expect(session).toHaveTextContent('работаю над задачей');
    expect(session.parentElement?.className).toContain('h-[300px]');
    expect(screen.queryByTestId('step-report')).toBeNull();
    expect(screen.queryByText(/result null/)).toBeNull();
    expect(screen.queryByText('Результат отсутствует.')).toBeNull();
    expect(screen.queryByTestId('step-stdout')).toBeNull();
    expect(screen.queryByTestId('step-stderr')).toBeNull();
  });

  it('шаг без событий: running → пустой session-вывод, без текста результата', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse([makeStepRun({ id: 'run-1', status: 'running' })]),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('step-session')).toBeInTheDocument();
    expect(screen.getByTestId('session-view-empty')).toBeInTheDocument();
    expect(screen.queryByText('Результат отсутствует.')).toBeNull();
    expect(screen.queryByTestId('step-report')).toBeNull();
  });

  it('завершённый шаг без отчёта → «Результат отсутствует.»', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse([makeStepRun({ id: 'run-1', status: 'success' })]),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);

    expect(
      await screen.findByText('Результат отсутствует.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('step-session')).toBeNull();
    expect(screen.queryByTestId('step-summary')).toBeNull();
  });

  it('завершённый шаг с отчётом → step-summary со статусом и саммари, без step-session', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse([
          makeStepRun({
            id: 'run-1',
            status: 'success',
            events: [{ type: 'text', text: 'сырой вывод агента' }],
            report: JSON.stringify({
              status: 'pass',
              summary: 'Все проверки прошли',
            }),
          }),
        ]),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);

    const summary = await screen.findByTestId('step-summary');
    expect(summary).toHaveTextContent('PASS');
    expect(summary).toHaveTextContent('Все проверки прошли');
    expect(summary).not.toHaveTextContent('сырой вывод агента');
    // Живой session-вывод у завершённого шага не рисуется.
    expect(screen.queryByTestId('step-session')).toBeNull();
    expect(screen.queryByText('Результат отсутствует.')).toBeNull();
  });

  it('завершённый шаг с битым отчётом (в т.ч. «null») → «Результат отсутствует.»', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse([
          makeStepRun({ id: 'run-1', status: 'failed', report: 'null' }),
        ]),
      ),
    );

    render(<TaskDetail issueId="issue-1" />);

    expect(
      await screen.findByText('Результат отсутствует.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('step-summary')).toBeNull();
    expect(screen.queryByTestId('step-session')).toBeNull();
  });
});