import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Issue, Iteration } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';
import {
  getMarkdownEditorValue,
  setMarkdownEditorValue,
} from '../test/markdown-editor';

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

function makeStepRun(overrides: Record<string, unknown> = {}) {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail', () => {
  it('loads and renders the issue and its iterations', async () => {
    const issue = makeIssue({ title: 'Fix login bug' });
    const iteration = makeIteration({ number: 1, status: 'running' });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([iteration]));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByText('Итерация #1')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('submits a new iteration and refreshes the list', async () => {
    const issue = makeIssue();
    let iterations: Iteration[] = [
      makeIteration({ number: 1, context: 'old approach' }),
    ];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              // Завершённая — чтобы форма (canStart) осталась видимой и можно
              // было проверить сброс контекста после отправки.
              status: 'completed',
              context: 'new attempt',
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    setMarkdownEditorValue('Контекст итерации', 'new attempt');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    expect(await screen.findByText('Итерация #2')).toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const [url, init] = postCall as [string, RequestInit];
    expect(String(url).endsWith('/iterations')).toBe(true);
    expect(JSON.parse(String(init.body)).context).toBe('new attempt');

    expect(getMarkdownEditorValue('Контекст итерации')).toBe('');
  });

  it('shows an error when the issue is not found', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(
        jsonResponse({ error: 'not found' }, { ok: false, status: 404 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="missing" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('not found');
  });

  it('canStart: completed iteration → форма новой итерации показана', async () => {
    const issue = makeIssue();
    const iteration = makeIteration({ status: 'completed' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([iteration]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);

    expect(
      await screen.findByLabelText('Контекст итерации'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    ).toBeInTheDocument();
  });

  it('canStart: running iteration → форма новой итерации скрыта', async () => {
    const issue = makeIssue();
    const iteration = makeIteration({ status: 'running' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([iteration]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    expect(screen.queryByLabelText('Контекст итерации')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Запустить новую итерацию' }),
    ).toBeNull();
    expect(screen.queryByText('Новая итерация')).toBeNull();
  });

  it('canStart: нет итераций → форма новой итерации показана', async () => {
    const issue = makeIssue();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);

    expect(
      await screen.findByLabelText('Контекст итерации'),
    ).toBeInTheDocument();
  });

  it('тогл Reviewer убран; выбор шага Review шлёт is_review_need: true', async () => {
    const issue = makeIssue();
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              status: 'pending',
              context: 'ctx',
              is_review_need: true,
              steps: ['resolve', 'review'],
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    // Дубль тогла ревью убран из формы.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('Контекст для Reviewer')).toBeNull();

    fireEvent.click(screen.getByLabelText('Review'));

    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.is_review_need).toBe(true);
      expect(body.review_context).toBe('');
      expect(body.steps).toContain('review');
    });
  });

  it('«Новая итерация» шлёт steps в каноническом порядке: refine перед resolve', async () => {
    const issue = makeIssue();
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              status: 'pending',
              context: 'ctx',
              steps: ['refine', 'resolve'],
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    fireEvent.click(screen.getByLabelText('Refine'));
    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.steps).toEqual(['refine', 'resolve']);
    });
  });

  it('«Новая итерация» шлёт step_models для отмеченных шагов с выбранной моделью', async () => {
    const issue = makeIssue();
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const models = [
      { id: 'm1', name: 'Model One' },
      { id: 'm2' },
    ];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve(jsonResponse(models));
        }
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              status: 'pending',
              context: 'ctx',
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');
    await screen.findAllByRole('option', { name: 'Model One' });

    // Resolve отмечен всегда → селектор виден; снятый Refine → селектора нет.
    expect(screen.getByLabelText('Модель для шага Resolve')).toBeEnabled();
    expect(screen.queryByLabelText('Модель для шага Refine')).toBeNull();

    fireEvent.click(screen.getByLabelText('Refine'));
    fireEvent.change(screen.getByLabelText('Модель для шага Refine'), {
      target: { value: 'm1' },
    });
    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.step_models).toEqual({ refine: 'm1' });
    });
  });

  it('«По умолчанию» у отмеченного шага не кладёт модель в step_models', async () => {
    const issue = makeIssue();
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const models = [{ id: 'm1', name: 'Model One' }];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve(jsonResponse(models));
        }
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              status: 'pending',
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');
    await screen.findAllByRole('option', { name: 'Model One' });

    // Отмечаем Review, но модель оставляем «По умолчанию».
    fireEvent.click(screen.getByLabelText('Review'));
    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.step_models).toBeUndefined();
    });
  });

  it('строка «Reviewer …» убрана; чип выбранной итерации показывает статус шага', async () => {
    const issue = makeIssue();
    const withReviewer = makeIteration({
      id: 'iter-1',
      number: 1,
      status: 'running',
      steps: ['resolve', 'review'],
      is_review_need: true,
      review_context: 'проверь UI',
    });
    const withoutReviewer = makeIteration({
      id: 'iter-2',
      number: 2,
      status: 'pending',
      is_review_need: false,
    });
    const stepRun = {
      id: 'run-review',
      iteration_id: 'iter-1',
      step: 'review',
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
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(
            jsonResponse([withReviewer, withoutReviewer]),
          );
        }
        if (url.endsWith('/step-runs')) {
          return Promise.resolve(jsonResponse([stepRun]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #2');

    // Заглушка-строка удалена целиком.
    expect(screen.queryByTestId('iteration-reviewer')).toBeNull();
    expect(screen.queryByText('Reviewer включён')).toBeNull();
    expect(screen.queryByText('Reviewer не запускался')).toBeNull();
    expect(screen.queryByText('проверь UI')).toBeNull();

    // Активна последняя итерация (iter-2, pending) — чипы без статуса.
    // Переключаемся на running-итерацию: её step-runs дают статус чипам.
    fireEvent.click(screen.getByText('Итерация #1'));
    await waitFor(() => {
      expect(screen.getByTestId('step-chip-review')).toHaveAttribute(
        'data-status',
        'running',
      );
    });
    expect(screen.getByTestId('step-chip-review')).toHaveTextContent('active');
    expect(screen.getByTestId('step-chip-resolve')).toHaveAttribute(
      'data-status',
      'pending',
    );
  });

  it('чип шага после терминального становится skipped, а не pending/active', async () => {
    const issue = makeIssue();
    const iteration = makeIteration({
      id: 'iter-1',
      number: 1,
      status: 'running',
      steps: ['refine', 'resolve', 'review'],
    });
    const refineRun = makeStepRun({
      id: 'run-refine',
      step: 'refine',
      status: 'failed',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([iteration]));
        }
        if (url.endsWith('/step-runs')) {
          return Promise.resolve(jsonResponse([refineRun]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    await waitFor(() => {
      expect(screen.getByTestId('step-chip-refine')).toHaveAttribute(
        'data-status',
        'failed',
      );
    });
    const refineChip = screen.getByTestId('step-chip-refine');
    const resolveChip = screen.getByTestId('step-chip-resolve');
    const reviewChip = screen.getByTestId('step-chip-review');
    expect(refineChip).toHaveAttribute('data-status', 'failed');
    expect(refineChip).not.toHaveClass('animate-pulse');
    expect(resolveChip).toHaveAttribute('data-status', 'skipped');
    expect(resolveChip).not.toHaveClass('animate-pulse');
    expect(reviewChip).toHaveAttribute('data-status', 'skipped');
  });

  it('шаг aborted показывает карточку step-aborted вместо summary', async () => {
    const issue = makeIssue();
    const iteration = makeIteration({
      id: 'iter-1',
      number: 1,
      status: 'cancelled',
      steps: ['resolve'],
    });
    const abortedRun = makeStepRun({
      status: 'aborted',
      report: JSON.stringify({ status: 'fail', summary: 'boom' }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([iteration]));
        }
        if (url.endsWith('/step-runs')) {
          return Promise.resolve(jsonResponse([abortedRun]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);

    const aborted = await screen.findByTestId('step-aborted');
    expect(aborted).toHaveTextContent('Прервано');
    expect(screen.queryByTestId('step-summary')).toBeNull();
  });

  it('итерация cancelled отображается серым статусом', async () => {
    const issue = makeIssue();
    const iteration = makeIteration({ status: 'cancelled' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([iteration]));
        }
        if (url.endsWith('/step-runs')) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);

    const status = await screen.findByText('cancelled');
    expect(status).toHaveStyle({ color: '#8A8A8A' });
  });

  it('пустой список репозиториев → карточек репозиториев нет', async () => {
    const issue = makeIssue({ repositories: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(screen.queryByText(/Ветка:/)).toBeNull();
  });

  it('карточки репозиториев: бейдж «MR» только при repo.create_mr', async () => {
    const issue = makeIssue({
      repositories: [
        {
          id: 'repo-1',
          repository_url: 'git@github.com:org/repo.git',
          branch_name: 'dev',
          create_mr: true,
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
        {
          id: 'repo-2',
          repository_url: 'git@github.com:org/other.git',
          branch_name: 'main',
          create_mr: false,
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('git@github.com:org/repo.git');

    expect(screen.getAllByTestId('repo-mr-badge')).toHaveLength(1);
    expect(screen.getByText('MR')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Создать merge request' })).toBeNull();
  });

  it('CreateIterationRequest не содержит create_mr (per-repo)', async () => {
    const issue = makeIssue({
      repositories: [
        {
          id: 'repo-1',
          repository_url: 'git@github.com:org/repo.git',
          branch_name: 'dev',
          create_mr: true,
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
      ],
    });
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              status: 'pending',
              context: 'ctx',
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.create_mr).toBeUndefined();
    });
  });

  it('шаг PR заблокирован без репозиториев и не уходит в steps', async () => {
    const issue = makeIssue({
      repositories: [],
      pipeline_steps: ['resolve', 'pr'],
    });
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              status: 'pending',
              context: 'ctx',
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    const prCheckbox = screen.getByRole('checkbox', {
      name: 'PR (нужен репозиторий)',
    });
    expect(prCheckbox).toBeDisabled();
    expect(prCheckbox).not.toBeChecked();

    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.steps).toEqual(['resolve']);
    });
  });

  it('шаг PR доступен и уходит в steps при наличии репозитория', async () => {
    const issue = makeIssue({
      repositories: [
        {
          id: 'repo-1',
          repository_url: 'git@github.com:org/repo.git',
          branch_name: 'dev',
          create_mr: true,
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
      ],
    });
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            const created = makeIteration({
              id: 'iter-2',
              number: 2,
              status: 'pending',
              context: 'ctx',
            });
            iterations = [...iterations, created];
            return Promise.resolve(jsonResponse(created, { status: 201 }));
          }
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    const prCheckbox = screen.getByRole('checkbox', { name: 'PR' });
    expect(prCheckbox).toBeEnabled();
    fireEvent.click(prCheckbox);
    expect(prCheckbox).toBeChecked();

    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.steps).toContain('pr');
    });
  });

  it('хедер: «Создана»/«Обновлена» с иконками справа от кнопки назад', async () => {
    const issue = makeIssue({
      created_at: '2026-01-02T03:04:05.000Z',
      updated_at: '2026-02-03T04:05:06.000Z',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" onBack={() => {}} />);
    await screen.findByText('Fix login bug');

    const created = screen.getByTestId('issue-created-at');
    const updated = screen.getByTestId('issue-updated-at');
    expect(created).toHaveAttribute('aria-label', 'Создана');
    expect(created).toHaveAttribute('title', 'Создана');
    expect(updated).toHaveAttribute('aria-label', 'Обновлена');
    expect(created.querySelector('svg')).not.toBeNull();
    expect(updated.querySelector('svg')).not.toBeNull();
    expect(created.querySelector('time')?.getAttribute('datetime')).toBe(
      issue.created_at,
    );
    expect(updated.querySelector('time')?.getAttribute('datetime')).toBe(
      issue.updated_at,
    );

    // Оба пункта — в одной строке с кнопкой назад.
    const back = screen.getByRole('button', { name: '← Мои задачи' });
    expect(back.parentElement).toBe(created.parentElement?.parentElement);

    // Даты больше не дублируются отдельной карточкой с текстом.
    expect(screen.queryByText(/Создана:/)).toBeNull();
    expect(screen.queryByText(/Обновлена:/)).toBeNull();
  });

  it('итерации выводятся новыми первыми, state не мутируется', async () => {
    const issue = makeIssue();
    const iterations = [
      makeIteration({ id: 'iter-1', number: 1 }),
      makeIteration({ id: 'iter-2', number: 2 }),
      makeIteration({ id: 'iter-3', number: 3 }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #3');

    const labels = screen
      .getAllByText(/^Итерация #\d+$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(['Итерация #3', 'Итерация #2', 'Итерация #1']);
  });

  it('форма «Новая итерация» идёт перед списком «Итерации»', async () => {
    const issue = makeIssue();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(
            jsonResponse([makeIteration({ status: 'completed' })]),
          );
        }
        return Promise.resolve(jsonResponse(issue));
      }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    const form = screen.getByRole('heading', { name: 'Новая итерация' });
    const list = screen.getByRole('heading', { name: 'Итерации' });
    expect(
      form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('после создания итерации мягко подводит список (scrollIntoView smooth)', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    try {
      const issue = makeIssue();
      let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
      const fetchMock = vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith('/iterations')) {
            if (init?.method === 'POST') {
              const created = makeIteration({
                id: 'iter-2',
                number: 2,
                status: 'pending',
                context: 'ctx',
              });
              iterations = [...iterations, created];
              return Promise.resolve(jsonResponse(created, { status: 201 }));
            }
            return Promise.resolve(jsonResponse(iterations));
          }
          return Promise.resolve(jsonResponse(issue));
        },
      );
      vi.stubGlobal('fetch', fetchMock);

      render(<TaskDetail issueId="issue-1" />);
      await screen.findByText('Итерация #1');

      setMarkdownEditorValue('Контекст итерации', 'ctx');
      fireEvent.click(
        screen.getByRole('button', { name: 'Запустить новую итерацию' }),
      );
      await screen.findByText('Итерация #2');

      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith(
          expect.objectContaining({ behavior: 'smooth', block: 'start' }),
        ),
      );
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('показывает вложения задачи со ссылкой на скачивание', async () => {
    const issue = makeIssue();
    const iterations = [
      makeIteration({ number: 1 }),
      makeIteration({ id: 'iter-2', number: 2 }),
    ];
    const files = [
      {
        id: 'f1',
        issue_id: 'issue-1',
        iteration_id: null,
        name: 'spec.md',
        rel_path: 'attachments/spec.md',
        size: 2048,
        mime_type: 'text/markdown',
        created_at: '2026-10-10T00:00:00.000Z',
      },
      {
        id: 'f2',
        issue_id: 'issue-1',
        iteration_id: 'iter-2',
        name: 'log.txt',
        rel_path: 'attachments/iteration-2/log.txt',
        size: 10,
        mime_type: 'text/plain',
        created_at: '2026-10-10T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/files')) return Promise.resolve(jsonResponse(files));
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse(iterations));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    expect(await screen.findByTestId('issue-files')).toBeInTheDocument();
    expect(screen.getAllByTestId('issue-file')).toHaveLength(2);
    const downloads = screen.getAllByTestId('issue-file-download');
    expect(downloads[0]).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/files/f1/content',
    );
    expect(screen.getByTestId('issue-file-iteration')).toHaveTextContent(
      'Итерация #2',
    );
  });

  it('не рендерит блок файлов, когда вложений нет', async () => {
    const issue = makeIssue();
    const iterations = [makeIteration({ number: 1 })];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/files')) return Promise.resolve(jsonResponse([]));
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse(iterations));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/files')),
      ).toBe(true),
    );
    expect(screen.queryByTestId('issue-files')).toBeNull();
  });

  it('удаляет вложение по ✕', async () => {
    const issue = makeIssue();
    const iterations = [makeIteration({ number: 1 })];
    const files = [
      {
        id: 'f1',
        issue_id: 'issue-1',
        iteration_id: null,
        name: 'spec.md',
        rel_path: 'attachments/spec.md',
        size: 2048,
        mime_type: 'text/markdown',
        created_at: '2026-10-10T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'DELETE') {
          return Promise.resolve(jsonResponse(null, { status: 204 }));
        }
        if (url.endsWith('/files')) return Promise.resolve(jsonResponse(files));
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByTestId('issue-file');

    fireEvent.click(screen.getByTestId('issue-file-delete'));
    await waitFor(() => expect(screen.queryByTestId('issue-file')).toBeNull());
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(true);
  });

  it('новая итерация с выбранным файлом шлёт multipart', async () => {
    const issue = makeIssue();
    const iterations = [makeIteration({ number: 1 })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST' && url.endsWith('/iterations')) {
          return Promise.resolve(
            jsonResponse(makeIteration({ id: 'iter-2', number: 2 }), {
              status: 201,
            }),
          );
        }
        if (url.endsWith('/files')) return Promise.resolve(jsonResponse([]));
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse(iterations));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    fireEvent.change(screen.getByLabelText('Файлы'), {
      target: { files: [new File(['x'], 'ctx.txt', { type: 'text/plain' })] },
    });
    setMarkdownEditorValue('Контекст итерации', 'ctx');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST' && init.body instanceof FormData,
      );
      expect(post).toBeTruthy();
      const form = (post as [string, RequestInit])[1].body as FormData;
      expect(form.getAll('files')).toHaveLength(1);
      expect(JSON.parse(String(form.get('payload'))).context).toBe('ctx');
    });
  });
});