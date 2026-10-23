import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  Issue,
  ModelDescriptor,
  SavedRepo,
} from '@issue-resolver/shared';
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

function savedRepo(
  id: string,
  fullName: string,
  defaultBranch = 'main',
  writeAccess = true,
): SavedRepo {
  return {
    id,
    url: `https://github.com/${fullName}.git`,
    platform: 'github',
    fullName,
    defaultBranch,
    cloneUrl: `https://github.com/${fullName}.git`,
    language: 'TypeScript',
    description: null,
    isPrivate: false,
    connectionStatus: 'ok',
    lastValidatedAt: '2026-10-12T00:00:00.000Z',
    writeAccess,
    runInstructions: null,
    runInstructionsStatus: 'unknown',
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
}

const SAVED_REPO = savedRepo('repo-1', 'acme/app');
const SECOND_REPO = savedRepo('repo-2', 'acme/lib', 'develop');

const BRANCHES: Record<string, string[]> = {
  'repo-1': ['main', 'develop'],
  'repo-2': ['develop', 'release'],
};

const jsonOk = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

interface ApiOptions {
  models?: ModelDescriptor[];
  repos?: SavedRepo[];
  branches?: Record<string, string[]>;
  issue?: Issue;
  /** Текст ошибки POST /issues. */
  issueError?: string;
  /** Текст ошибки GET /repositories. */
  repositoriesError?: string;
  /** Ошибка у GET /repositories/:id/branches. */
  branchesError?: boolean;
}

/** Общий stub API формы: модели, сохранённые репозитории, ветки, POST /issues. */
function stubApi(options: ApiOptions = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return jsonOk(options.models ?? []);
    }
    if (url.endsWith('/repositories')) {
      if (options.repositoriesError) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: options.repositoriesError }),
        });
      }
      return jsonOk(options.repos ?? []);
    }
    const branchMatch = /\/repositories\/([^/]+)\/branches$/.exec(url);
    if (branchMatch) {
      if (options.branchesError) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: async () => ({ error: 'repository not accessible' }),
        });
      }
      return jsonOk({
        branches: options.branches?.[branchMatch[1]] ?? [],
      });
    }
    if (init?.method === 'POST') {
      if (options.issueError) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: options.issueError }),
        });
      }
      return jsonOk(options.issue ?? createdIssue);
    }
    return jsonOk(options.issue ?? createdIssue);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Тело POST именно на /issues (а не на другие роуты). */
function issuePostBody(
  fetchMock: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  const postCall = fetchMock.mock.calls.find(
    ([input, init]) =>
      String(input).endsWith('/issues') &&
      (init as RequestInit | undefined)?.method === 'POST',
  );
  expect(postCall).toBeTruthy();
  const [, init] = postCall as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function addRepoRow() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Добавить репозиторий' }),
  );
}

function repositorySelect(index = 0): HTMLSelectElement {
  return screen.getAllByLabelText('Репозиторий')[index] as HTMLSelectElement;
}

function branchSelect(index = 0): HTMLSelectElement {
  return screen.getAllByLabelText('Базовая ветка')[index] as HTMLSelectElement;
}

/** Ждёт загрузку сохранённых репозиториев и выбирает один из них. */
async function selectRepo(repoId: string, index = 0) {
  await waitFor(() => {
    const select = repositorySelect(index);
    expect(select.disabled).toBe(false);
    expect(select.options.length).toBeGreaterThan(1);
  });
  fireEvent.change(repositorySelect(index), { target: { value: repoId } });
  await waitFor(() => expect(branchSelect(index).disabled).toBe(false));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewIssue', () => {
  it('создаёт задачу с repo_id/base_branch и уведомляет родителя', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });
    const onCreated = vi.fn();

    render(<NewIssue onCreated={onCreated} />);

    addRepoRow();
    await selectRepo('repo-1');

    // defaultBranch репозитория выбран в селекторе веток.
    expect(branchSelect().value).toBe('main');
    expect(
      within(branchSelect())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['main', 'develop']);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.change(branchSelect(), { target: { value: 'develop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdIssue));

    const body = issuePostBody(fetchMock);
    expect(body.repositories).toEqual([
      {
        repo_id: 'repo-1',
        base_branch: 'develop',
        create_mr: false,
        bootstrap_enabled: true,
      },
    ]);
  });

  it('список сохранённых репозиториев грузится и попадает в селектор', async () => {
    stubApi({ repos: [SAVED_REPO, SECOND_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();

    await waitFor(() =>
      expect(repositorySelect().options.length).toBeGreaterThan(2),
    );
    expect(
      within(repositorySelect()).getByRole('option', { name: 'acme/app' }),
    ).toBeInTheDocument();
    expect(
      within(repositorySelect()).getByRole('option', { name: 'acme/lib' }),
    ).toBeInTheDocument();
  });

  it('ошибка загрузки сохранённых репозиториев показывается, форма жива', async () => {
    stubApi({ repositoriesError: 'boom' });

    render(<NewIssue />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByLabelText('Заголовок')).toBeInTheDocument();
  });

  it('ошибка загрузки веток не роняет форму: остаётся defaultBranch', async () => {
    stubApi({ repos: [SAVED_REPO], branchesError: true });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    expect(branchSelect().value).toBe('main');
    expect(
      within(branchSelect())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['main']);
  });

  it('показывает сообщение об ошибке сервера', async () => {
    stubApi({
      repos: [SAVED_REPO],
      issueError: 'Не удалось определить title',
    });

    render(<NewIssue />);
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    expect(
      await screen.findByText('Не удалось определить title'),
    ).toBeInTheDocument();
  });

  it('тогл ревью убран из формы', () => {
    stubApi();

    render(<NewIssue />);

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('Контекст для Reviewer')).toBeNull();
  });

  it('Jira свёрнута по умолчанию: кнопка раскрывает поле', () => {
    stubApi();

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
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByLabelText('Код-ревью'));
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.is_review_need).toBe(true);
      expect(body.review_context).toBe('');
    });
  });

  it('без репозиториев: подсказка, нет тоглов, payload без repositories', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO] });

    render(<NewIssue />);

    expect(screen.getByText(/Можно без репозиториев/)).toBeInTheDocument();
    expect(
      screen.queryAllByRole('switch', { name: 'Создать merge request' }),
    ).toHaveLength(0);

    addRepoRow();
    expect(screen.queryByText(/Можно без репозиториев/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    expect(screen.getByText(/Можно без репозиториев/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.repositories).toBeUndefined();
    });
  });

  it('create_mr по умолчанию false в payload', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.create_mr).toBeUndefined();
      expect(body.repositories).toEqual([
        {
          repo_id: 'repo-1',
          base_branch: 'main',
          create_mr: false,
          bootstrap_enabled: true,
        },
      ]);
    });
  });

  it('чекбокс «Репозитории для MR» → repositories[].create_mr', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    // Секция появляется только при выбранном шаге pr.
    expect(
      screen.queryByTestId('pr-repositories-section'),
    ).toBeNull();
    fireEvent.click(screen.getByLabelText('Merge Request'));

    const checkbox = screen.getByTestId(
      'pr-repo-repo-1',
    ) as HTMLInputElement;
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const repositories = issuePostBody(fetchMock).repositories as Array<
        Record<string, unknown>
      >;
      expect(repositories[0].create_mr).toBe(true);
    });
  });

  it('writeAccess:false → репозиторий не предлагается для MR', async () => {
    stubApi({
      repos: [savedRepo('repo-1', 'acme/app', 'main', false)],
      branches: BRANCHES,
    });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    fireEvent.click(screen.getByLabelText('Merge Request'));

    expect(screen.queryByTestId('pr-repo-repo-1')).toBeNull();
    expect(
      screen.getByText(/Нет добавленных репозиториев с правом записи/),
    ).toBeInTheDocument();
    // Строка жива: тогл Dev-сервера на месте.
    expect(
      screen.getByRole('switch', { name: 'Dev сервер' }),
    ).toBeInTheDocument();
  });

  it('writeAccess:true → чекбокс репозитория для MR виден', async () => {
    stubApi({
      repos: [savedRepo('repo-1', 'acme/app', 'main', true)],
      branches: BRANCHES,
    });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    fireEvent.click(screen.getByLabelText('Merge Request'));

    expect(screen.getByTestId('pr-repo-repo-1')).toBeInTheDocument();
  });

  it('bootstrap по умолчанию включён → bootstrap_enabled: true', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    expect(
      screen.getByRole('switch', {
        name: 'Dev сервер',
      }),
    ).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const repositories = issuePostBody(fetchMock).repositories as Array<
        Record<string, unknown>
      >;
      expect(repositories[0].bootstrap_enabled).toBe(true);
    });
  });

  it('снятый bootstrap → repositories[].bootstrap_enabled: false', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    const toggle = screen.getByRole('switch', {
      name: 'Dev сервер',
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const repositories = issuePostBody(fetchMock).repositories as Array<
        Record<string, unknown>
      >;
      expect(repositories[0].bootstrap_enabled).toBe(false);
    });
  });

  it('несколько репозиториев: независимые repo_id и create_mr', async () => {
    const fetchMock = stubApi({
      repos: [SAVED_REPO, SECOND_REPO],
      branches: BRANCHES,
    });

    render(<NewIssue />);
    addRepoRow();
    addRepoRow();
    await selectRepo('repo-1', 0);
    await selectRepo('repo-2', 1);

    fireEvent.click(screen.getByLabelText('Merge Request'));
    fireEvent.click(screen.getByTestId('pr-repo-repo-2'));

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const repositories = issuePostBody(fetchMock).repositories as Array<
        Record<string, unknown>
      >;
      expect(repositories).toHaveLength(2);
      expect(repositories[0]).toMatchObject({
        repo_id: 'repo-1',
        create_mr: false,
      });
      expect(repositories[1]).toMatchObject({
        repo_id: 'repo-2',
        create_mr: true,
      });
    });
  });

  it('снятие шага pr скрывает секцию MR и сбрасывает выбор репозиториев', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

    fireEvent.click(screen.getByLabelText('Merge Request'));
    const checkbox = screen.getByTestId(
      'pr-repo-repo-1',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Сняли шаг pr — секция исчезает, выбор репозиториев сброшен.
    fireEvent.click(screen.getByLabelText('Merge Request'));
    expect(screen.queryByTestId('pr-repositories-section')).toBeNull();

    fireEvent.click(screen.getByLabelText('Merge Request'));
    expect(
      screen.getByTestId('pr-repo-repo-1') as HTMLInputElement,
    ).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const repositories = issuePostBody(fetchMock).repositories as Array<
        Record<string, unknown>
      >;
      expect(repositories[0].create_mr).toBe(false);
    });
  });

  it('удаление первой карточки сохраняет ветки второй', async () => {
    stubApi({ repos: [SAVED_REPO, SECOND_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    addRepoRow();
    await selectRepo('repo-1', 0);
    await selectRepo('repo-2', 1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Удалить' })[0]);

    expect(repositorySelect(0).value).toBe('repo-2');
    expect(
      within(branchSelect(0))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['develop', 'release']);
  });

  it('форма не содержит выбора desired_result (всегда оба артефакта)', () => {
    stubApi();

    render(<NewIssue />);

    expect(screen.queryByTestId('desired-result-md')).toBeNull();
    expect(screen.queryByTestId('desired-result-html')).toBeNull();
    expect(screen.queryByText('Желаемый отчёт')).toBeNull();
  });

  it('submit не шлёт desired_result (бэкенд сам решает)', async () => {
    const fetchMock = stubApi();

    render(<NewIssue />);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.desired_result).toBeUndefined();
      expect(body.pipeline_steps).toEqual(['resolve']);
    });
  });

  it('pipeline_steps уходят в каноническом порядке: refine перед resolve', async () => {
    const fetchMock = stubApi();

    render(<NewIssue />);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByLabelText('Планирование'));
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.pipeline_steps).toEqual(['refine', 'resolve']);
    });
  });

  it('селектор thinking level disabled без выбранной модели; с моделью — её thinkingLevels', async () => {
    stubApi({ models: thinkingModels });

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    const resolveLevel = screen.getByLabelText(
      'Уровень размышления для шага Исполнение',
    ) as HTMLSelectElement;
    expect(resolveLevel).toBeDisabled();
    expect(within(resolveLevel).getAllByRole('option')).toHaveLength(1);
    expect(
      within(resolveLevel).getByRole('option', { name: 'По умолчанию' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Модель для шага Исполнение'), {
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
    const fetchMock = stubApi({ models: thinkingModels });

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.change(screen.getByLabelText('Модель для шага Исполнение'), {
      target: { value: 'm1' },
    });
    fireEvent.change(
      screen.getByLabelText('Уровень размышления для шага Исполнение'),
      { target: { value: 'high' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.step_thinking_levels).toEqual({ resolve: 'high' });
      expect(body.thinking_level).toBeUndefined();
    });
  });

  it('смена модели сбрасывает несовместимый thinking level', async () => {
    const fetchMock = stubApi({ models: thinkingModels });

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    const modelSelect = screen.getByLabelText('Модель для шага Исполнение');
    const levelSelect = screen.getByLabelText(
      'Уровень размышления для шага Исполнение',
    ) as HTMLSelectElement;

    fireEvent.change(modelSelect, { target: { value: 'm1' } });
    fireEvent.change(levelSelect, { target: { value: 'high' } });
    expect(levelSelect.value).toBe('high');

    fireEvent.change(modelSelect, { target: { value: 'm2' } });
    expect(levelSelect.value).toBe('');
    expect(
      within(levelSelect).queryByRole('option', { name: 'high' }),
    ).toBeNull();
    expect(
      within(levelSelect).getByRole('option', { name: 'max' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.step_thinking_levels).toBeUndefined();
    });
  });

  it('без выбора thinking level поля step_thinking_levels в payload нет', async () => {
    const fetchMock = stubApi({ models: thinkingModels });

    render(<NewIssue />);

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.step_thinking_levels).toBeUndefined();
    });
  });

  it('снятый шаг с выбранным thinking level отфильтровывается из payload', async () => {
    const fetchMock = stubApi({ models: thinkingModels });

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Fix login bug' },
    });

    fireEvent.click(screen.getByLabelText('Планирование'));
    fireEvent.change(screen.getByLabelText('Модель для шага Планирование'), {
      target: { value: 'm1' },
    });
    fireEvent.change(
      screen.getByLabelText('Уровень размышления для шага Планирование'),
      { target: { value: 'high' } },
    );
    fireEvent.click(screen.getByLabelText('Планирование'));
    expect(
      screen.queryByLabelText('Уровень размышления для шага Планирование'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = issuePostBody(fetchMock);
      expect(body.step_thinking_levels).toBeUndefined();
    });
  });

  it('с выбранным файлом шлёт multipart: payload JSON + files', async () => {
    const fetchMock = stubApi({ repos: [SAVED_REPO], branches: BRANCHES });

    render(<NewIssue />);
    addRepoRow();
    await selectRepo('repo-1');

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
      const payload = JSON.parse(String(form.get('payload'))) as {
        title: string;
        repositories: unknown[];
      };
      expect(payload.title).toBe('Fix login bug');
      expect(payload.repositories).toEqual([
        {
          repo_id: 'repo-1',
          base_branch: 'main',
          create_mr: false,
          bootstrap_enabled: true,
        },
      ]);
      expect(form.getAll('files')).toHaveLength(1);
      expect((form.getAll('files')[0] as File).name).toBe('note.txt');
    });
  });
});