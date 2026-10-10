import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Issue, ModelDescriptor } from '@issue-resolver/shared';
import NewIssue from './NewIssue';

/** Модели с разными наборами thinking-уровней (m2 не поддерживает 'high'). */
const thinkingModels: ModelDescriptor[] = [
  { id: 'm1', name: 'Model One', thinkingLevels: ['off', 'low', 'high'] },
  { id: 'm2', name: 'Model Two', thinkingLevels: ['off', 'max'] },
];

const createdIssue: Issue = {
  id: 'issue-1',
  title: 'Fix login bug',
  jira_issue_url: null,
  repositories: [],
  pipeline_steps: ['resolve'],
  status: 'pending',
  created_at: '2026-10-09T00:00:00.000Z',
  updated_at: '2026-10-09T00:00:00.000Z',
};

/** GET /models → thinkingModels, POST /issues → созданная задача. */
function stubThinkingFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return Promise.resolve({ ok: true, json: async () => thinkingModels });
    }
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: async () => createdIssue });
    }
    return Promise.resolve({ ok: true, json: async () => createdIssue });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function postBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const postCall = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
  );
  expect(postCall).toBeTruthy();
  const [, init] = postCall as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewIssue', () => {
  it('creates an issue and notifies the parent', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => createdIssue });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onCreated = vi.fn();

    render(<NewIssue onCreated={onCreated} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.change(screen.getByLabelText('Адрес'), {
      target: { value: 'git@github.com:org/repo.git' },
    });
    fireEvent.change(screen.getByLabelText('Базовая ветка'), {
      target: { value: 'main' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdIssue));

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const [url, init] = postCall!;
    expect(String(url).endsWith('/issue-resolver/api/v1/issues')).toBe(true);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).repositories[0].repository_url).toBe(
      'git@github.com:org/repo.git',
    );
  });

  it('shows the server error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    expect(await screen.findByText('bad')).toBeInTheDocument();
  });

  it('тогл ревью убран из формы', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      }),
    );

    render(<NewIssue />);

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('Контекст для Reviewer')).toBeNull();
  });

  it('Jira свёрнута по умолчанию: кнопка раскрывает поле', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );

    render(<NewIssue />);

    expect(screen.queryByLabelText('Ссылка на Jira')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить ссылку на Jira' }),
    );
    expect(screen.getByLabelText('Ссылка на Jira')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Убрать' }));
    expect(screen.queryByLabelText('Ссылка на Jira')).toBeNull();
  });

  it('отправляет is_review_need: true при выбранном шаге Review', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );
    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.change(screen.getByLabelText('Адрес'), {
      target: { value: 'git@github.com:org/repo.git' },
    });
    fireEvent.click(screen.getByLabelText('Review'));
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

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
    });
  });

  it('базовая ветка новой карточки репозитория — dev', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );

    render(<NewIssue />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );

    expect(
      (screen.getByLabelText('Базовая ветка') as HTMLInputElement).value,
    ).toBe('dev');
  });

  it('репозитории не обязательны: удаляются до 0, подсказка и payload repositories []', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    // По умолчанию карточек нет — видна подсказка и кнопка добавления.
    expect(
      screen.getByText(/Можно без репозиториев/),
    ).toBeInTheDocument();
    expect(
      screen.queryAllByRole('switch', { name: 'Создать merge request' }),
    ).toHaveLength(0);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );
    expect(
      screen.queryByText(/Можно без репозиториев/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    expect(
      screen.getByText(/Можно без репозиториев/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.repositories).toEqual([]);
    });
  });

  it('label «Описание задачи» + create_mr по умолчанию false в payload', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );

    expect(screen.getByLabelText('Описание задачи')).toBeInTheDocument();
    expect(
      screen
        .getByLabelText('Описание задачи')
        .querySelector('[data-placeholder="Опишите, что нужно сделать"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole('switch', { name: 'Создать merge request' }),
    ).toHaveAttribute('aria-checked', 'false');

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.create_mr).toBeUndefined();
      expect(body.repositories).toHaveLength(1);
      expect(body.repositories[0].create_mr).toBe(false);
    });
  });

  it('toggle «Создать merge request» в карточке репозитория → repositories[].create_mr', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );

    const toggle = screen.getByRole('switch', {
      name: 'Создать merge request',
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.create_mr).toBeUndefined();
      expect(body.repositories[0].create_mr).toBe(true);
    });
  });

  it('несколько репозиториев: create_mr независим для каждого', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );
    const switches = screen.getAllByRole('switch', {
      name: 'Создать merge request',
    });
    expect(switches).toHaveLength(2);
    fireEvent.click(switches[1]);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.repositories).toHaveLength(2);
      expect(body.repositories[0].create_mr).toBe(false);
      expect(body.repositories[1].create_mr).toBe(true);
    });
  });

  it('без репозиториев нет per-repo create_mr toggle, payload repositories []', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    // Пусто по умолчанию: карточек и per-repo тоглов нет.
    expect(
      screen.queryAllByRole('switch', { name: 'Создать merge request' }),
    ).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.repositories).toEqual([]);
      expect(body.create_mr).toBeUndefined();
    });
  });

  it('desired_result по умолчанию — md, pr-radio disabled без репозиториев', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      }),
    );

    render(<NewIssue />);

    expect(screen.getByTestId('desired-result-md')).toBeChecked();
    expect(screen.getByTestId('desired-result-html')).not.toBeChecked();

    const pr = screen.getByTestId('desired-result-pr') as HTMLInputElement;
    expect(pr).toBeDisabled();
    expect(pr).not.toBeChecked();
    expect(screen.getByText(/нужен репозиторий/)).toBeInTheDocument();

    // Ручного PR-чекбокса в «Шагах пайплайна» больше нет.
    expect(screen.queryByRole('checkbox', { name: /^PR/ })).toBeNull();
    expect(screen.queryByLabelText('Модель для шага PR')).toBeNull();
  });

  it('после добавления репозитория PR-radio доступен', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      }),
    );

    render(<NewIssue />);

    const pr = screen.getByTestId('desired-result-pr') as HTMLInputElement;
    expect(pr).toBeDisabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );

    expect(pr).toBeEnabled();
    expect(screen.queryByText(/нужен репозиторий/)).toBeNull();
  });

  it('submit шлёт desired_result: md по умолчанию', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.desired_result).toBe('md');
      expect(body.pipeline_steps).toEqual(['resolve']);
    });
  });

  it('submit шлёт desired_result: pr при выборе PR-radio', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );
    fireEvent.click(screen.getByTestId('desired-result-pr'));

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.desired_result).toBe('pr');
      // Шаг pr добавляет бэкенд по desired_result, не форма.
      expect(body.pipeline_steps).toEqual(['resolve']);
    });
  });

  it('удаление последнего репозитория откатывает desired_result на md', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      }),
    );

    render(<NewIssue />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить репозиторий' }),
    );
    const pr = screen.getByTestId('desired-result-pr') as HTMLInputElement;
    fireEvent.click(pr);
    expect(pr).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));

    expect(screen.getByTestId('desired-result-md')).toBeChecked();
    expect(pr).not.toBeChecked();
    expect(pr).toBeDisabled();
  });

  it('pipeline_steps уходят в каноническом порядке: refine перед resolve', async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => createdIssue });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByLabelText('Refine'));
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(
        String((postCall as [string, RequestInit])[1].body),
      );
      expect(body.pipeline_steps).toEqual(['refine', 'resolve']);
    });
  });

  it('селектор thinking level disabled без выбранной модели; с моделью — её thinkingLevels', async () => {
    stubThinkingFetch();

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    const resolveLevel = screen.getByLabelText(
      'Уровень размышления для шага Resolve',
    ) as HTMLSelectElement;
    expect(resolveLevel).toBeDisabled();
    expect(within(resolveLevel).getAllByRole('option')).toHaveLength(1);
    expect(
      within(resolveLevel).getByRole('option', { name: 'По умолчанию' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Модель для шага Resolve'), {
      target: { value: 'm1' },
    });

    expect(resolveLevel).toBeEnabled();
    expect(
      within(resolveLevel)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['По умолчанию', 'off', 'low', 'high']);
  });

  it('выбор thinking level для выбранной модели → payload.step_thinking_levels', async () => {
    const fetchMock = stubThinkingFetch();

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.change(screen.getByLabelText('Модель для шага Resolve'), {
      target: { value: 'm1' },
    });
    fireEvent.change(
      screen.getByLabelText('Уровень размышления для шага Resolve'),
      { target: { value: 'high' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = postBody(fetchMock);
      expect(body.step_thinking_levels).toEqual({ resolve: 'high' });
      // Глобальный thinking_level формой не отправляется.
      expect(body.thinking_level).toBeUndefined();
    });
  });

  it('смена модели сбрасывает несовместимый thinking level', async () => {
    const fetchMock = stubThinkingFetch();

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    const modelSelect = screen.getByLabelText('Модель для шага Resolve');
    const levelSelect = screen.getByLabelText(
      'Уровень размышления для шага Resolve',
    ) as HTMLSelectElement;

    fireEvent.change(modelSelect, { target: { value: 'm1' } });
    fireEvent.change(levelSelect, { target: { value: 'high' } });
    expect(levelSelect.value).toBe('high');

    // m2 не поддерживает 'high' → уровень сбрасывается, опции — уровни m2.
    fireEvent.change(modelSelect, { target: { value: 'm2' } });
    expect(levelSelect.value).toBe('');
    expect(within(levelSelect).queryByRole('option', { name: 'high' })).toBeNull();
    expect(
      within(levelSelect).getByRole('option', { name: 'max' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = postBody(fetchMock);
      expect(body.step_thinking_levels).toBeUndefined();
    });
  });

  it('без выбора thinking level поля step_thinking_levels в payload нет', async () => {
    const fetchMock = stubThinkingFetch();

    render(<NewIssue />);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = postBody(fetchMock);
      expect(body.step_thinking_levels).toBeUndefined();
    });
  });

  it('снятый шаг с выбранным thinking level отфильтровывается из payload', async () => {
    const fetchMock = stubThinkingFetch();

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });

    // Отмечаем refine, выбираем модель и уровень, затем снимаем шаг.
    fireEvent.click(screen.getByLabelText('Refine'));
    fireEvent.change(screen.getByLabelText('Модель для шага Refine'), {
      target: { value: 'm1' },
    });
    fireEvent.change(
      screen.getByLabelText('Уровень размышления для шага Refine'),
      { target: { value: 'high' } },
    );
    fireEvent.click(screen.getByLabelText('Refine'));
    expect(screen.queryByLabelText('Уровень размышления для шага Refine')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = postBody(fetchMock);
      expect(body.step_thinking_levels).toBeUndefined();
    });
  });

  it('с выбранным файлом шлёт multipart: payload JSON + files', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => createdIssue });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NewIssue />);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    const picked = new File(['hello'], 'note.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Файлы'), {
      target: { files: [picked] },
    });
    expect(screen.getByText('note.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const [, init] = postCall as [string, RequestInit];
      expect(init.headers).toBeUndefined();
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(JSON.parse(String(form.get('payload'))).title).toBe('Fix login bug');
      expect(form.getAll('files')).toHaveLength(1);
      expect((form.getAll('files')[0] as File).name).toBe('note.txt');
    });
  });
});