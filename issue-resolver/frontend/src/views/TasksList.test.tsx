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
import type {
  Issue,
  Iteration,
  SavedRepo,
  SessionStats,
  StepRunWithLog,
} from '@issue-resolver/shared';
import TasksList from './TasksList';

function makeIssue(id: string, title: string): Issue {
  return {
    id,
    title,
    jira_issue_url: null,
    repositories: [],
    pipeline_steps: ['resolve'],
    status: 'pending',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
  };
}

function makeSavedRepo(
  url: string,
  connectionStatus: SavedRepo['connectionStatus'],
  runInstructionsStatus: SavedRepo['runInstructionsStatus'],
): SavedRepo {
  return {
    id: `saved-${url}`,
    url,
    platform: null,
    fullName: null,
    defaultBranch: null,
    cloneUrl: null,
    language: null,
    description: null,
    isPrivate: null,
    connectionStatus,
    lastValidatedAt: null,
    writeAccess: true,
    runInstructions: null,
    runInstructionsStatus,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  };
}

/** Issue с репозиториями — для сводки готовности на pending/preparing. */
function makeRepoIssue(
  id: string,
  status: Issue['status'],
  urls: string[],
): Issue {
  return {
    ...makeIssue(id, `task ${id}`),
    status,
    repositories: urls.map((url, index) => ({
      id: `${id}-r${index}`,
      repository_url: url,
      branch_name: 'main',
      create_mr: false,
      bootstrap_enabled: true,
      created_at: '2026-10-09T00:00:00.000Z',
      updated_at: '2026-10-09T00:00:00.000Z',
    })),
  };
}

function makeIteration(
  id: string,
  number: number,
  status: Iteration['status'] = 'completed',
): Iteration {
  return {
    id,
    issue_id: '1',
    number,
    context: '',
    review_context: '',
    is_review_need: false,
    steps: ['resolve'],
    status,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
  };
}

function makeStats(
  input: number,
  output: number,
  cache: number,
  avgSpeed?: number,
): SessionStats {
  return {
    model: 'Claude Sonnet 4',
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: {
      input,
      output,
      cacheRead: cache,
      cacheWrite: 0,
      total: input + output + cache,
    },
    cost: null,
    contextUsage: null,
    avgTokensPerSecond: avgSpeed,
  };
}

function makeStepRun(overrides: Partial<StepRunWithLog> = {}): StepRunWithLog {
  return {
    id: 'run-1',
    iteration_id: 'it-1',
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

interface RoutedFetch {
  issues: Issue[];
  repositories?: SavedRepo[];
  iterations?: Record<string, Iteration[]>;
  stepRuns?: Record<string, StepRunWithLog[]>;
  calls: string[];
}

/** Мок с маршрутизацией по URL: считает вызовы и отдаёт фикстуры по id. */
function stubRoutedFetch(routes: Omit<RoutedFetch, 'calls'>): RoutedFetch {
  const result: RoutedFetch = { ...routes, calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      result.calls.push(url);
      if (url.endsWith('/repositories')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => result.repositories ?? result.issues,
        });
      }
      const iterations = url.match(/\/issues\/([^/]+)\/iterations$/);
      if (iterations) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => result.iterations?.[iterations[1]] ?? [],
        });
      }
      const stepRuns = url.match(/\/iterations\/([^/]+)\/step-runs$/);
      if (stepRuns) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => result.stepRuns?.[stepRuns[1]] ?? [],
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => result.issues,
      });
    }),
  );
  return result;
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

  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TasksList', () => {
  it('renders issue titles from the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        makeIssue('1', 'First task'),
        makeIssue('2', 'Second task'),
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksList />);

    expect(await screen.findByText('First task')).toBeInTheDocument();
    expect(await screen.findByText('Second task')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/issue-resolver/api/v1/issues',
    );
  });

  it('рендерит карточку §4.3: ключ, репозитории, ветки, статус, время', async () => {
    const issue: Issue = {
      id: '1',
      title: 'KLA-5672',
      jira_issue_url: 'https://jira.example.com/browse/KLA-5672',
      repositories: [
        {
          id: 'r1',
          repository_url: 'git@github.com:org/files-web.git',
          branch_name: 'feature/KLA-5672',
          create_mr: false,
          bootstrap_enabled: false,
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
        {
          id: 'r2',
          repository_url: 'https://gitlab.example.com/api.git',
          branch_name: 'dev',
          create_mr: false,
          bootstrap_enabled: false,
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
      ],
      pipeline_steps: ['resolve'],
      status: 'running',
      created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      updated_at: '2026-10-09T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [issue] }),
    );

    render(<TasksList />);
    await screen.findByText('KLA-5672');

    expect(
      screen.getByText('files-web:feature/KLA-5672 · api:dev'),
    ).toBeInTheDocument();
    expect(screen.getByText('В работе')).toBeInTheDocument();
    expect(screen.getByText('5 мин назад')).toBeInTheDocument();
  });

  it('question-задача рендерит янтарный статус «Вопрос»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { ...makeIssue('1', 'Waiting task'), status: 'question' },
        ],
      }),
    );

    render(<TasksList />);
    const label = await screen.findByText('Вопрос');
    expect(label).toBeInTheDocument();
    expect(label).toHaveStyle({ color: '#FFB000' });
  });

  it('updates issue status to question when iteration_status arrives via global stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeIssue('1', 'Waiting task')],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Waiting task');
    expect(screen.getByTestId('issue-status')).toHaveAttribute(
      'data-status',
      'pending',
    );

    // Глобальный поток: `/issues/:id/stream` здесь не подходит — список
    // слушает общий канал `/stream`.
    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/api/v1/stream'),
    );
    expect(stream).toBeDefined();

    stream?.emit({
      type: 'iteration_status',
      issueId: '1',
      iterationId: 'it-1',
      data: JSON.stringify({
        iterationId: 'it-1',
        status: 'question',
        needsInput: true,
      }),
      ts: '2026-10-13T00:00:00.000Z',
    });

    await waitFor(() =>
      expect(screen.getByTestId('issue-status')).toHaveAttribute(
        'data-status',
        'question',
      ),
    );
    expect(screen.getByTestId('issue-status')).toHaveTextContent('Вопрос');
  });

  it('shows active model when step_status running arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { ...makeIssue('1', 'Running task'), status: 'running' },
        ],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Running task');
    expect(screen.queryByTestId('active-step')).toBeNull();

    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/api/v1/stream'),
    );
    expect(stream).toBeDefined();

    stream?.emit({
      type: 'step_status',
      issueId: '1',
      iterationId: 'it-1',
      stepRunId: 'run-1',
      data: JSON.stringify({
        status: 'running',
        step: 'resolve',
        model: 'deepseek-v4-pro',
      }),
      ts: '2026-10-13T00:00:00.000Z',
    });

    await waitFor(() =>
      expect(screen.getByTestId('active-step')).toHaveTextContent(
        'resolve · deepseek-v4-pro',
      ),
    );
    // Модель теперь в блоке статистики (IssueStats), а не под статусом карточки.
    const stats = screen.getByTestId('issue-stats');
    expect(
      stats.parentElement?.contains(screen.getByTestId('active-step')),
    ).toBe(true);
  });

  it('step_status без модели показывает только активный шаг', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { ...makeIssue('1', 'Running task'), status: 'running' },
        ],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Running task');

    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/api/v1/stream'),
    );
    stream?.emit({
      type: 'step_status',
      issueId: '1',
      iterationId: 'it-1',
      stepRunId: 'run-1',
      data: JSON.stringify({
        status: 'running',
        step: 'refine',
        model: null,
      }),
      ts: '2026-10-13T00:00:00.000Z',
    });

    await waitFor(() =>
      expect(screen.getByTestId('active-step')).toHaveTextContent('refine'),
    );
    expect(screen.getByTestId('active-step')).not.toHaveTextContent('·');
  });

  it('сбрасывает активный шаг при завершении step_status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { ...makeIssue('1', 'Running task'), status: 'running' },
        ],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Running task');

    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/api/v1/stream'),
    );
    stream?.emit({
      type: 'step_status',
      issueId: '1',
      iterationId: 'it-1',
      stepRunId: 'run-1',
      data: JSON.stringify({
        status: 'running',
        step: 'resolve',
        model: 'deepseek-v4-pro',
      }),
      ts: '2026-10-13T00:00:00.000Z',
    });
    await waitFor(() =>
      expect(screen.getByTestId('active-step')).toBeInTheDocument(),
    );

    stream?.emit({
      type: 'step_status',
      issueId: '1',
      iterationId: 'it-1',
      stepRunId: 'run-1',
      data: JSON.stringify({ status: 'success' }),
      ts: '2026-10-13T00:00:01.000Z',
    });

    await waitFor(() =>
      expect(screen.queryByTestId('active-step')).toBeNull(),
    );
  });

  it('клик по строке вызывает onOpenTask', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeIssue('1', 'First task')],
      }),
    );
    const onOpenTask = vi.fn();

    render(<TasksList onOpenTask={onOpenTask} />);

    fireEvent.click(await screen.findByText('First task'));
    expect(onOpenTask).toHaveBeenCalledWith('1');
  });

  it('running-задача: живой таймер — время работы step-runs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            ...makeIssue('1', 'Running task'),
            status: 'running',
            created_at: new Date(Date.now() - 192_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Running task');

    expect(await screen.findByTestId('issue-timer')).toHaveTextContent(
      '⏱ 3м 12с',
    );
  });

  it('completed-задача: таймер — сумма времени step-runs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            ...makeIssue('1', 'Done task'),
            status: 'completed',
            created_at: '2026-10-09T00:00:00.000Z',
            updated_at: '2026-10-09T00:05:40.000Z',
          },
        ],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Done task');

    expect(await screen.findByTestId('issue-timer')).toHaveTextContent(
      '⏱ 5м 40с',
    );
  });

  it('pending-задача без таймера — только относительное время', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeIssue('1', 'Waiting task')],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Waiting task');

    expect(screen.queryByTestId('issue-timer')).toBeNull();
  });

  it('completed-задача с md/html-результатом рендерит «Просмотр» и навигирует по нему', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            ...makeIssue('1', 'Done task'),
            status: 'completed',
            desired_result: 'md',
          },
        ],
      }),
    );
    const onOpenTask = vi.fn();
    const onOpenResult = vi.fn();

    render(
      <TasksList onOpenTask={onOpenTask} onOpenResult={onOpenResult} />,
    );
    await screen.findByText('Done task');

    const resultCell = screen.getByTestId('result-cell');
    const viewButton = within(resultCell).getByRole('button', {
      name: 'Просмотреть результат Done task',
    });
    expect(viewButton).toHaveAttribute('title', 'Просмотреть результат');

    fireEvent.click(viewButton);
    expect(onOpenResult).toHaveBeenCalledWith('1');
    // Кнопка результата не должна открывать саму задачу (это делает row-click).
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('running-задача без результата → прочерк и без кнопки просмотра', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { ...makeIssue('1', 'Running task'), status: 'running' },
        ],
      }),
    );

    render(<TasksList />);
    await screen.findByText('Running task');

    const resultCell = screen.getByTestId('result-cell');
    expect(within(resultCell).getByText('—')).toBeInTheDocument();
    expect(
      within(resultCell).queryByRole('button'),
    ).not.toBeInTheDocument();
  });

  it('пустые репозитории и ветки → прочерк в колонках', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeIssue('1', 'First task')],
      }),
    );

    render(<TasksList />);
    await screen.findByText('First task');

    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('удаление задачи: 202 → карточка «Удаление...» → SSE `issue_deleted` убирает её', async () => {
    const deletedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deletedUrls.push(String(input));
          return Promise.resolve({
            ok: true,
            status: 202,
            json: async () => ({ ok: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [makeIssue('1', 'First task')],
        });
      }),
    );
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);
    const onOpenTask = vi.fn();

    render(<TasksList onOpenTask={onOpenTask} />);
    await screen.findByText('First task');

    fireEvent.click(
      screen.getByRole('button', { name: 'Удалить задачу First task' }),
    );

    // DELETE ушёл, а карточка локально перешла в «Удаление...».
    expect(await screen.findByTestId('issue-deleting')).toBeInTheDocument();
    expect(screen.queryByText('First task')).not.toBeInTheDocument();
    expect(confirmMock).toHaveBeenCalledWith(
      'Удалить задачу и всю её рабочую папку?',
    );
    expect(deletedUrls).toEqual(['/issue-resolver/api/v1/issues/1']);
    expect(onOpenTask).not.toHaveBeenCalled();

    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/issues/1/stream'),
    );
    expect(stream).toBeDefined();

    // Фаза удаления из SSE показывается рядом с «Удаление...».
    stream?.emit({
      type: 'issue_deleting',
      issueId: '1',
      data: JSON.stringify({ phase: 'removing_workspace' }),
      ts: '2026-10-13T00:00:00.000Z',
    });
    expect(
      await screen.findByText('удаляем рабочую папку'),
    ).toBeInTheDocument();

    // Финал: задача пропадает из списка, поток закрывается.
    stream?.emit({
      type: 'issue_deleted',
      issueId: '1',
      data: JSON.stringify({ issueId: '1' }),
      ts: '2026-10-13T00:00:01.000Z',
    });
    await waitFor(() =>
      expect(screen.queryByTestId('issue-deleting')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('First task')).not.toBeInTheDocument();
    expect(stream?.close).toHaveBeenCalled();
  });

  it('ошибка удаления (SSE phase: error) возвращает карточку и показывает причину', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return Promise.resolve({
            ok: true,
            status: 202,
            json: async () => ({ ok: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [makeIssue('1', 'First task')],
        });
      }),
    );
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

    render(<TasksList />);
    await screen.findByText('First task');
    fireEvent.click(
      screen.getByRole('button', { name: 'Удалить задачу First task' }),
    );
    await screen.findByTestId('issue-deleting');

    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/issues/1/stream'),
    );
    stream?.emit({
      type: 'issue_deleting',
      issueId: '1',
      data: JSON.stringify({ phase: 'error', message: 'rm: отказано' }),
      ts: '2026-10-13T00:00:00.000Z',
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось удалить задачу: rm: отказано',
    );
    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-deleting')).not.toBeInTheDocument();
  });

  it('shows timeout error if issue_deleted never arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return Promise.resolve({
            ok: true,
            status: 202,
            json: async () => ({ ok: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [makeIssue('1', 'First task')],
        });
      }),
    );
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

    render(<TasksList />);
    await screen.findByText('First task');

    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole('button', { name: 'Удалить задачу First task' }),
    );
    expect(screen.getByTestId('issue-deleting')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(screen.getByTestId('delete-timeout')).toHaveTextContent(
      'Таймаут удаления. Задача может быть удалена частично. Обновите страницу.',
    );
    expect(screen.queryByTestId('issue-deleting')).not.toBeInTheDocument();
    expect(screen.getByText('First task')).toBeInTheDocument();
  });

  it('отмена подтверждения не удаляет задачу', async () => {    const deletedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') deletedUrls.push(String(input));
        return Promise.resolve({
          ok: true,
          json: async () => [makeIssue('1', 'First task')],
        });
      }),
    );
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));

    render(<TasksList />);
    await screen.findByText('First task');

    fireEvent.click(
      screen.getByRole('button', { name: 'Удалить задачу First task' }),
    );

    expect(deletedUrls).toEqual([]);
    expect(screen.getByText('First task')).toBeInTheDocument();
  });

  it('кнопка удаления — иконка без обводки и текста, с aria-label и testid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeIssue('1', 'First task')],
      }),
    );

    render(<TasksList />);
    await screen.findByText('First task');

    const deleteButton = screen.getByTestId('delete-issue');
    expect(deleteButton).toHaveAttribute(
      'aria-label',
      'Удалить задачу First task',
    );
    expect(deleteButton).not.toHaveTextContent('Удалить');
    expect(deleteButton.querySelector('svg')).not.toBeNull();
    expect(deleteButton.className).not.toContain('border');
  });

  it('running: таймер — время работы step-runs, статистика без токенов', async () => {
    const issue: Issue = {
      ...makeIssue('1', 'Running task'),
      status: 'running',
      created_at: new Date(Date.now() - 600_000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    stubRoutedFetch({
      issues: [issue],
      iterations: {
        '1': [makeIteration('it-1', 1, 'completed'), makeIteration('it-2', 2, 'running')],
      },
      stepRuns: {
        'it-1': [
          makeStepRun({
            id: 'a',
            iteration_id: 'it-1',
            created_at: '2026-10-09T00:00:00.000Z',
            updated_at: '2026-10-09T00:02:00.000Z',
          }),
        ],
        'it-2': [
          makeStepRun({
            id: 'b',
            iteration_id: 'it-2',
            status: 'running',
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }),
        ],
      },
    });

    render(<TasksList />);
    await screen.findByText('Running task');

    const timer = await screen.findByTestId('issue-timer');
    // 2м (завершённый step-run) + ~60с (текущий running-step), допускаем дрейф тика.
    expect(timer).toHaveTextContent(/⏱ 3м \d+с/);
    const stats = screen.getByTestId('issue-stats');
    expect(stats).toHaveTextContent('↻ 2');
    expect(stats).not.toHaveTextContent('↓');
    expect(stats).not.toHaveTextContent('⚡');
  });

  it('completed: таймер суммирует step-runs, не считая простой между итерациями', async () => {
    const issue: Issue = {
      ...makeIssue('1', 'Done task'),
      status: 'completed',
      // Wall-clock ровно час, но реальной работы ~10 минут.
      created_at: '2026-10-09T00:00:00.000Z',
      updated_at: '2026-10-09T01:00:00.000Z',
    };
    stubRoutedFetch({
      issues: [issue],
      iterations: { '1': [makeIteration('it-1', 1), makeIteration('it-2', 2)] },
      stepRuns: {
        'it-1': [
          makeStepRun({
            id: 'a',
            iteration_id: 'it-1',
            created_at: '2026-10-09T00:00:00.000Z',
            updated_at: '2026-10-09T00:03:00.000Z',
            stats: makeStats(5_000, 100, 200),
          }),
          makeStepRun({
            id: 'b',
            iteration_id: 'it-1',
            created_at: '2026-10-09T00:20:00.000Z',
            updated_at: '2026-10-09T00:25:00.000Z',
          }),
        ],
        'it-2': [
          makeStepRun({
            id: 'c',
            iteration_id: 'it-2',
            created_at: '2026-10-09T00:30:00.000Z',
            updated_at: '2026-10-09T00:32:00.000Z',
            stats: makeStats(142_000, 3_400, 85_000),
          }),
        ],
      },
    });

    render(<TasksList />);
    await screen.findByText('Done task');

    expect(await screen.findByTestId('issue-timer')).toHaveTextContent(
      '⏱ 10м 0с',
    );
    const stats = screen.getByTestId('issue-stats');
    expect(stats).toHaveTextContent('↻ 2');
    // Токены берутся только с последней итерации (it-2), не суммируются c it-1.
    expect(stats).toHaveTextContent('↓142k');
    expect(stats).toHaveTextContent('↑3.4k');
    expect(stats).toHaveTextContent('⤓85k');
    expect(stats).not.toHaveTextContent('↓5k');
  });

  it('пока step-runs не загружены — таймера нет, остаётся относительное время', async () => {
    const issue: Issue = {
      ...makeIssue('1', 'Running task'),
      status: 'running',
      created_at: new Date(Date.now() - 600_000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    let releaseStepRuns: (() => void) | undefined;
    const stepRunsGate = new Promise<void>((resolve) => {
      releaseStepRuns = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve({
            ok: true,
            json: async () => [makeIteration('it-1', 1, 'running')],
          });
        }
        if (url.endsWith('/step-runs')) {
          return stepRunsGate.then(() => ({
            ok: true,
            json: async () => [] as StepRunWithLog[],
          }));
        }
        return Promise.resolve({ ok: true, json: async () => [issue] });
      }),
    );

    render(<TasksList />);
    await screen.findByText('Running task');
    await screen.findByText('Загрузка статистики…');

    // Fallback — относительное время, никакого wall-clock таймера.
    expect(screen.queryByTestId('issue-timer')).toBeNull();
    expect(screen.getByText('10 мин назад')).toBeInTheDocument();

    releaseStepRuns?.();
    expect(await screen.findByTestId('issue-timer')).toHaveTextContent('⏱ 0с');
  });

  it('pending-задача не запрашивает статистику вовсе', async () => {
    const { calls } = stubRoutedFetch({ issues: [makeIssue('1', 'Waiting task')] });

    render(<TasksList />);
    await screen.findByText('Waiting task');
    await waitFor(() => {
      expect(calls.some((url) => url.endsWith('/issues'))).toBe(true);
    });

    expect(calls.some((url) => url.includes('/iterations'))).toBe(false);
  });

  it('ререндер не перезапрашивает статистику (кеш в состоянии)', async () => {
    const issue: Issue = { ...makeIssue('1', 'Done task'), status: 'completed' };
    const routes = stubRoutedFetch({
      issues: [issue],
      iterations: { '1': [makeIteration('it-1', 1)] },
      stepRuns: { 'it-1': [] },
    });

    const { rerender } = render(<TasksList />);
    await screen.findByText('Done task');
    await waitFor(() => {
      expect(screen.getByTestId('issue-stats')).toHaveTextContent('↻ 1');
    });
    const callsBefore = routes.calls.length;

    rerender(<TasksList />);
    await waitFor(() => {
      expect(screen.getByTestId('issue-stats')).toHaveTextContent('↻ 1');
    });

    expect(routes.calls.length).toBe(callsBefore);
  });

  it('completed: средняя скорость последней итерации — ⚡N t/s', async () => {
    const issue: Issue = { ...makeIssue('1', 'Done task'), status: 'completed' };
    stubRoutedFetch({
      issues: [issue],
      iterations: { '1': [makeIteration('it-1', 1), makeIteration('it-2', 2)] },
      stepRuns: {
        'it-1': [
          makeStepRun({
            id: 'x',
            iteration_id: 'it-1',
            stats: makeStats(1000, 100, 0, 30),
          }),
        ],
        'it-2': [
          makeStepRun({
            id: 'a',
            iteration_id: 'it-2',
            stats: makeStats(1000, 100, 0, 40),
          }),
          makeStepRun({
            id: 'b',
            iteration_id: 'it-2',
            stats: makeStats(1000, 100, 0, 44),
          }),
          // Run без скорости не должен ломать среднее.
          makeStepRun({
            id: 'c',
            iteration_id: 'it-2',
            stats: makeStats(1000, 100, 0),
          }),
        ],
      },
    });

    render(<TasksList />);
    await screen.findByText('Done task');

    await waitFor(() => {
      expect(screen.getByTestId('issue-stats')).toHaveTextContent('⚡42 t/s');
    });
    // Скорость it-1 (30 t/s) не учитывается.
    expect(screen.getByTestId('issue-stats')).not.toHaveTextContent('⚡30');
  });

  it('pending-карточка показывает сводку готовности репозиториев (✅/🔵/🟡)', async () => {
    const urls = [
      'git@github.com:org/a.git',
      'git@github.com:org/b.git',
      'git@github.com:org/c.git',
    ];
    const { calls } = stubRoutedFetch({
      issues: [makeRepoIssue('1', 'pending', urls)],
      repositories: [
        makeSavedRepo(urls[0], 'ok', 'generated'),
        makeSavedRepo(urls[1], 'ok', 'unknown'),
        makeSavedRepo(urls[2], 'unknown', 'unknown'),
      ],
    });

    render(<TasksList />);
    await screen.findByText('task 1');

    const summary = await screen.findByTestId('repo-readiness');
    expect(summary).toHaveTextContent('📦 репо: ✅1 🔵1 🟡1');
    // Иконки цветные (матричная палитра).
    expect(within(summary).getByText('✅')).toHaveStyle({ color: '#00FF41' });
    expect(within(summary).getByText('🔵')).toHaveStyle({ color: '#00B4FF' });
    expect(within(summary).getByText('🟡')).toHaveStyle({ color: '#FFB000' });
    // Нет ошибок — категория ❌ не выводится.
    expect(screen.queryByTestId('repo-readiness-error')).toBeNull();
    expect(calls.filter((url) => url.endsWith('/repositories'))).toHaveLength(1);
  });

  it('сводка учитывает ошибки (❌) и несведённые репозитории (🟡)', async () => {
    const urls = [
      'git@github.com:org/a.git',
      'git@github.com:org/b.git',
      'git@github.com:org/missing.git',
    ];
    stubRoutedFetch({
      issues: [makeRepoIssue('1', 'preparing', urls)],
      repositories: [
        makeSavedRepo(urls[0], 'ok', 'generated'),
        makeSavedRepo(urls[1], 'error', 'failed'),
      ],
    });

    render(<TasksList />);
    await screen.findByText('task 1');

    const summary = await screen.findByTestId('repo-readiness');
    expect(summary).toHaveTextContent('📦 репо: ✅1 🔵0 🟡1 ❌1');
    expect(screen.getByTestId('repo-readiness-error')).toHaveAttribute(
      'data-count',
      '1',
    );
    expect(within(summary).getByText('❌')).toHaveStyle({ color: '#FF0033' });
  });

  it('сохранённые репозитории грузятся один раз на весь список (кеш)', async () => {
    const shared = ['git@github.com:org/shared.git'];
    const { calls } = stubRoutedFetch({
      issues: [
        makeRepoIssue('1', 'pending', shared),
        makeRepoIssue('2', 'pending', shared),
      ],
      repositories: [makeSavedRepo(shared[0], 'ok', 'generated')],
    });

    render(<TasksList />);
    await screen.findByText('task 1');
    await screen.findByText('task 2');

    await waitFor(() => {
      expect(screen.getAllByTestId('repo-readiness')).toHaveLength(2);
    });
    expect(calls.filter((url) => url.endsWith('/repositories'))).toHaveLength(1);
  });

  it('completed-задача со склонированными репо не показывает сводку и не грузит сохранённые', async () => {
    const urls = ['git@github.com:org/a.git'];
    const { calls } = stubRoutedFetch({
      issues: [
        { ...makeRepoIssue('1', 'completed', urls), desired_result: 'md' },
      ],
      repositories: [makeSavedRepo(urls[0], 'ok', 'generated')],
    });

    render(<TasksList />);
    await screen.findByText('task 1');

    expect(screen.queryByTestId('repo-readiness')).toBeNull();
    expect(calls.some((url) => url.endsWith('/repositories'))).toBe(false);
  });

  it('ошибка getRepositories() не ломает карточку и молча скрывает сводку', async () => {
    const urls = ['git@github.com:org/a.git'];
    let repositoriesCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).endsWith('/repositories')) {
          repositoriesCalled = true;
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: 'boom' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [makeRepoIssue('1', 'pending', urls)],
        });
      }),
    );

    render(<TasksList />);
    await screen.findByText('task 1');
    await waitFor(() => expect(repositoriesCalled).toBe(true));

    expect(screen.queryByTestId('repo-readiness')).toBeNull();
  });

  it('время создания перенесено в строку с кнопками действий', async () => {
    const issue: Issue = {
      ...makeIssue('1', 'Done task'),
      status: 'completed',
      created_at: new Date(Date.now() - 300_000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    stubRoutedFetch({
      issues: [issue],
      iterations: { '1': [makeIteration('it-1', 1)] },
      stepRuns: { 'it-1': [] },
    });

    render(<TasksList />);
    await screen.findByText('Done task');

    const relative = await screen.findByText('5 мин назад');
    expect(relative.parentElement).toContainElement(
      screen.getByTestId('result-cell'),
    );
    expect(relative.parentElement).toContainElement(
      screen.getByTestId('delete-issue'),
    );
  });
});