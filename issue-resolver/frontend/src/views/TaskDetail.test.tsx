import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Issue, Iteration, ModelDescriptor } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';
import {
  getMarkdownEditorValue,
  setMarkdownEditorValue,
} from '../test/markdown-editor';

/** Открывает модалку новой итерации кликом по кнопке. */
async function openIterationModal() {
  fireEvent.click(await screen.findByTestId('open-iteration-modal'));
  await screen.findByTestId('new-iteration-island');
}

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
    issue_id: 'issue-1',
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

/** Модели с разными наборами thinking-уровней (m2 не поддерживает 'high'). */
const thinkingModels: ModelDescriptor[] = [
  { id: 'm1', name: 'Model One', thinkingLevels: ['off', 'low', 'high'] },
  { id: 'm2', name: 'Model Two', thinkingLevels: ['off', 'max'] },
];

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
  vi.useRealTimers();
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

    await openIterationModal();
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

    // После успешного запуска модалка закрывается, а контекст сброшен:
    // при повторном открытии поле пустое.
    await waitFor(() =>
      expect(screen.queryByTestId('new-iteration-island')).toBeNull(),
    );
    await openIterationModal();
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

    await openIterationModal();
    expect(
      await screen.findByLabelText('Контекст итерации'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    ).toBeInTheDocument();
  });

  it('canStart: running iteration → форма предлагает создать черновик', async () => {
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

    // running → можно поставить в план только черновик, форму не скрываем.
    await openIterationModal();
    expect(screen.getByLabelText('Контекст итерации')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Создать черновик' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Запустить новую итерацию' }),
    ).toBeNull();
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

    await openIterationModal();
    expect(
      await screen.findByLabelText('Контекст итерации'),
    ).toBeInTheDocument();
  });

  it('шаг Refine несёт компактный input «Макс. число параллельных агентов»', async () => {
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
    await openIterationModal();
    await screen.findByLabelText('Контекст итерации');

    // Поле живёт внутри строки шага Refine (заголовок шага «Планирование»),
    // одной компактной строкой — отдельного блока под шагами больше нет.
    const refineHint = screen.getAllByTestId('refine-planner-hint');
    expect(refineHint).toHaveLength(1);
    const input = within(refineHint[0]).getByTestId('worker-count-input');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('max', '4');
    expect(refineHint[0]).toHaveTextContent(
      'Макс. число параллельных агентов',
    );
    // Ровно один input на форме — дубля-строки больше нет.
    expect(screen.getAllByTestId('worker-count-input')).toHaveLength(1);
  });

  it('тогл Reviewer убран; выбор шага Код-ревью шлёт is_review_need: true', async () => {
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
    await openIterationModal();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('Контекст для Reviewer')).toBeNull();

    await openIterationModal();
    fireEvent.click(screen.getByLabelText('Код-ревью'));

    await openIterationModal();
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

    await openIterationModal();
    fireEvent.click(screen.getByLabelText('Планирование'));
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
    await openIterationModal();
    await screen.findAllByRole('option', { name: 'Model One' });

    // Resolve отмечен всегда → селектор виден; снятый Refine → селектора нет.
    await openIterationModal();
    expect(screen.getByLabelText('Модель для шага Исполнение')).toBeEnabled();
    expect(screen.queryByLabelText('Модель для шага Планирование')).toBeNull();

    await openIterationModal();
    fireEvent.click(screen.getByLabelText('Планирование'));
    fireEvent.change(screen.getByLabelText('Модель для шага Планирование'), {
      target: { value: 'm1' },
    });
    await openIterationModal();
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
    await openIterationModal();
    await screen.findAllByRole('option', { name: 'Model One' });

    // Отмечаем Код-ревью, но модель оставляем «По умолчанию».
    await openIterationModal();
    fireEvent.click(screen.getByLabelText('Код-ревью'));
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

  it('«Новая итерация»: thinking level disabled без модели, с моделью — её уровни', async () => {
    const issue = makeIssue();
    const iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return Promise.resolve(jsonResponse(thinkingModels));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse(iterations));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await openIterationModal();
    await screen.findAllByRole('option', { name: 'Model One' });

    const levelSelect = screen.getByLabelText(
      'Уровень размышления для шага Исполнение',
    ) as HTMLSelectElement;
    expect(levelSelect).toBeDisabled();
    expect(within(levelSelect).getAllByRole('option')).toHaveLength(1);
    expect(
      within(levelSelect).getByRole('option', { name: 'По умолчанию' }),
    ).toBeInTheDocument();

    await openIterationModal();
    fireEvent.change(screen.getByLabelText('Модель для шага Исполнение'), {
      target: { value: 'm1' },
    });
    expect(levelSelect).toBeEnabled();
    expect(
      within(levelSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['По умолчанию', 'off', 'low', 'high']);
  });

  it('«Новая итерация» шлёт step_thinking_levels для модели с выбранным уровнем', async () => {
    const issue = makeIssue();
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve(jsonResponse(thinkingModels));
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
    await openIterationModal();
    await screen.findAllByRole('option', { name: 'Model One' });

    await openIterationModal();
    fireEvent.click(screen.getByLabelText('Планирование'));
    fireEvent.change(screen.getByLabelText('Модель для шага Планирование'), {
      target: { value: 'm1' },
    });
    await openIterationModal();
    fireEvent.change(
      screen.getByLabelText('Уровень размышления для шага Планирование'),
      { target: { value: 'high' } },
    );
    await openIterationModal();
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
      expect(body.step_thinking_levels).toEqual({ refine: 'high' });
      // Глобальный thinking_level формой не отправляется.
      expect(body.thinking_level).toBeUndefined();
    });
  });

  it('«Новая итерация»: смена модели сбрасывает несовместимый thinking level', async () => {
    const issue = makeIssue();
    const iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return Promise.resolve(jsonResponse(thinkingModels));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse(iterations));
      }
      return Promise.resolve(jsonResponse(issue));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);
    await openIterationModal();
    await screen.findAllByRole('option', { name: 'Model One' });

    await openIterationModal();
    const modelSelect = screen.getByLabelText('Модель для шага Исполнение');
    const levelSelect = screen.getByLabelText(
      'Уровень размышления для шага Исполнение',
    ) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'm1' } });
    fireEvent.change(levelSelect, { target: { value: 'high' } });
    expect(levelSelect.value).toBe('high');

    // m2 не поддерживает 'high' → уровень сбрасывается, опции — уровни m2.
    fireEvent.change(modelSelect, { target: { value: 'm2' } });
    expect(levelSelect.value).toBe('');
    expect(
      within(levelSelect).queryByRole('option', { name: 'high' }),
    ).toBeNull();
    expect(
      within(levelSelect).getByRole('option', { name: 'max' }),
    ).toBeInTheDocument();
  });

  it('«По умолчанию» и снятый шаг не попадают в step_thinking_levels', async () => {
    const issue = makeIssue();
    let iterations: Iteration[] = [makeIteration({ status: 'completed' })];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve(jsonResponse(thinkingModels));
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
    await openIterationModal();
    await screen.findAllByRole('option', { name: 'Model One' });

    // Отмечаем Refine, выбираем модель и уровень, затем снимаем шаг.
    await openIterationModal();
    fireEvent.click(screen.getByLabelText('Планирование'));
    fireEvent.change(screen.getByLabelText('Модель для шага Планирование'), {
      target: { value: 'm1' },
    });
    await openIterationModal();
    fireEvent.change(
      screen.getByLabelText('Уровень размышления для шага Планирование'),
      { target: { value: 'high' } },
    );
    await openIterationModal();
    fireEvent.click(screen.getByLabelText('Планирование'));
    expect(
      screen.queryByLabelText('Уровень размышления для шага Планирование'),
    ).toBeNull();

    await openIterationModal();
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
      expect(body.step_thinking_levels).toBeUndefined();
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
      issue_id: 'issue-1',
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
          bootstrap_enabled: false,
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
        {
          id: 'repo-2',
          repository_url: 'git@github.com:org/other.git',
          branch_name: 'main',
          create_mr: false,
          bootstrap_enabled: false,
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
    await screen.findByText('org/repo');

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
          bootstrap_enabled: false,
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

    await openIterationModal();
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

    await openIterationModal();
    const prCheckbox = screen.getByRole('checkbox', {
      name: 'PR (нужен репозиторий)',
    });
    expect(prCheckbox).toBeDisabled();
    expect(prCheckbox).not.toBeChecked();

    await openIterationModal();
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
          bootstrap_enabled: false,
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

    await openIterationModal();
    const prCheckbox = screen.getByRole('checkbox', { name: 'PR' });
    expect(prCheckbox).toBeEnabled();
    fireEvent.click(prCheckbox);
    expect(prCheckbox).toBeChecked();

    await openIterationModal();
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

  it('хедер: «Создана»/«Обновлена» с иконками', async () => {
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

    render(<TaskDetail issueId="issue-1" />);
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

    await openIterationModal();
    const form = screen.getByRole('heading', { name: 'Новая итерация' });
    // Секция итераций больше не обёрнута в отдельный остров с заголовком
    // «Итерации»; список — это <ul>, карточки — <li role="button">.
    const list = screen.getByText('Итерация #1');
    expect(
      form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('три островка: задача → новая итерация → итерации, без внешней панели', async () => {
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

    const task = screen.getByTestId('task-island');
    await openIterationModal();
    const newIteration = screen.getByTestId('new-iteration-island');
    // Островок итераций — теперь сама карточка-<li> (у списка нет своей рамки).
    const iterations = screen
      .getByText('Итерация #1')
      .closest('li') as HTMLElement;

    // Три прозрачные карточки в одном стиле, без чёрного фона внутри.
    for (const island of [task, newIteration, iterations]) {
      expect(island.className).toContain('rounded-none');
      expect(island.className).toContain('border-[#008F11]');
      expect(island.className).toContain('p-4');
      expect(island.className).not.toContain('bg-[#000200]');
    }

    // Корневая обёртка — без `.panel` (внешняя зелёная обёртка убрана).
    const root = task.closest('div.mx-auto') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).not.toContain('panel');

    // Заголовок задачи и служебный ряд — внутри первого островка.
    expect(
      screen.getByText('Fix login bug').closest('[data-testid="task-island"]'),
    ).not.toBeNull();

    // Порядок: задача → новая итерация → итерации.
    expect(
      task.compareDocumentPosition(newIteration) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      newIteration.compareDocumentPosition(iterations) &
        Node.DOCUMENT_POSITION_FOLLOWING,
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

      await openIterationModal();
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

  it('файл итерации — инлайн в её карточке после контекста, общезадачный — в шапке', async () => {
    const issue = makeIssue();
    const iterations = [
      makeIteration({ number: 1 }),
      makeIteration({ id: 'iter-2', number: 2, context: 'ctx 2' }),
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
    await screen.findByText('Итерация #2');

    // Отдельного блока «Файлы задачи» больше нет.
    expect(screen.queryByTestId('issue-files')).toBeNull();

    const iter2Card = screen
      .getByText('Итерация #2')
      .closest('li[role="button"]') as HTMLElement;
    expect(iter2Card).not.toBeNull();
    const ctx = within(iter2Card).getByText('ctx 2');
    const inline = within(iter2Card).getByTestId('issue-files-inline');
    // Файл идёт сразу после промпта итерации.
    expect(
      ctx.compareDocumentPosition(inline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(iter2Card).getByText('log.txt')).toBeInTheDocument();
    expect(within(iter2Card).queryByText('spec.md')).toBeNull();

    // Общезадачный файл — в шапке, вне кликабельной карточки итерации.
    const spec = screen.getByText('spec.md');
    expect(spec.closest('li[role="button"]')).toBeNull();
    expect(spec.closest('header')).not.toBeNull();
    expect(screen.getByText('2.0 КБ')).toBeInTheDocument();
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
    expect(screen.queryByTestId('issue-files-inline')).toBeNull();
    expect(screen.queryByTestId('issue-file')).toBeNull();
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

    await openIterationModal();
    fireEvent.change(screen.getByLabelText('Файлы'), {
      target: { files: [new File(['x'], 'ctx.txt', { type: 'text/plain' })] },
    });
    await openIterationModal();
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

describe('TaskDetail — фоновое удаление', () => {
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

  it('issue_deleting → заглушка «Задача удаляется...», issue_deleted → уход на список', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([makeIteration()]));
        }
        return Promise.resolve(jsonResponse(makeIssue()));
      }),
    );

    window.location.hash = '';
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/issues/issue-1/stream'),
    );
    expect(stream).toBeDefined();

    stream?.emit({
      type: 'issue_deleting',
      issueId: 'issue-1',
      data: JSON.stringify({ phase: 'stopping_processes' }),
      ts: '2026-10-13T00:00:00.000Z',
    });

    expect(await screen.findByTestId('task-deleting')).toHaveTextContent(
      'Задача удаляется...',
    );
    expect(screen.queryByText('Fix login bug')).not.toBeInTheDocument();

    stream?.emit({
      type: 'issue_deleted',
      issueId: 'issue-1',
      data: JSON.stringify({ issueId: 'issue-1' }),
      ts: '2026-10-13T00:00:01.000Z',
    });

    await waitFor(() => expect(window.location.hash).toBe('#/'));
  });

  it('shows timeout error if issue_deleted never arrives', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([makeIteration()]));
        }
        return Promise.resolve(jsonResponse(makeIssue()));
      }),
    );

    window.location.hash = '';
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    vi.useFakeTimers();
    const stream = FakeEventSource.instances.find((source) =>
      source.url.endsWith('/issues/issue-1/stream'),
    );
    expect(stream).toBeDefined();

    act(() => {
      stream?.emit({
        type: 'issue_deleting',
        issueId: 'issue-1',
        data: JSON.stringify({ phase: 'stopping_processes' }),
        ts: '2026-10-13T00:00:00.000Z',
      });
    });
    expect(screen.getByTestId('task-deleting')).toHaveTextContent(
      'Задача удаляется...',
    );

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(screen.getByTestId('delete-timeout')).toHaveTextContent(
      'Таймаут удаления. Задача может быть удалена частично. Обновите страницу.',
    );
    expect(screen.queryByTestId('task-deleting')).not.toBeInTheDocument();
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(window.location.hash).not.toBe('#/');
  });
});