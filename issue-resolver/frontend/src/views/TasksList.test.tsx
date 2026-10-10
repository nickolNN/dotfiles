import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Issue } from '@issue-resolver/shared';
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

afterEach(() => {
  cleanup();
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

  it('рендерит таблицу §4.3: колонки, имена репозиториев, ветки, относительное время', async () => {
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
          created_at: '2026-10-09T00:00:00.000Z',
          updated_at: '2026-10-09T00:00:00.000Z',
        },
        {
          id: 'r2',
          repository_url: 'https://gitlab.example.com/api.git',
          branch_name: 'dev',
          create_mr: false,
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

    for (const column of [
      'Задача',
      'Репозитории',
      'Ветки',
      'Статус',
      'Результат',
      'Создано',
    ]) {
      expect(screen.getByText(column)).toBeInTheDocument();
    }
    expect(
      screen.getByText('https://jira.example.com/browse/KLA-5672'),
    ).toBeInTheDocument();
    expect(screen.getByText('files-web, api')).toBeInTheDocument();
    expect(screen.getByText('feature/KLA-5672, dev')).toBeInTheDocument();
    expect(screen.getByText('В работе')).toBeInTheDocument();
    expect(screen.getByText('5 мин назад')).toBeInTheDocument();
  });

  it('заголовок на странице + кнопка-иконка «Создать задачу» вызывает onCreateTask, клик по строке — onOpenTask', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeIssue('1', 'First task')],
      }),
    );
    const onCreateTask = vi.fn();
    const onOpenTask = vi.fn();

    render(<TasksList onCreateTask={onCreateTask} onOpenTask={onOpenTask} />);

    expect(
      screen.getByRole('heading', { name: 'Мои задачи' }),
    ).toBeInTheDocument();

    const createButton = screen.getByRole('button', { name: 'Создать задачу' });
    expect(createButton).toHaveAttribute('title', 'Создать задачу');
    expect(createButton.querySelector('svg')).not.toBeNull();

    fireEvent.click(createButton);
    expect(onCreateTask).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByText('First task'));
    expect(onOpenTask).toHaveBeenCalledWith('1');
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

    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('удаление задачи: подтверждение → DELETE с верным id, перезагрузка списка, без открытия детали', async () => {
    const deletedUrls: string[] = [];
    let listVersion = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation(
        (input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'DELETE') {
            deletedUrls.push(String(input));
            return Promise.resolve({
              ok: true,
              status: 204,
              json: async () => ({}),
            });
          }
          listVersion += 1;
          return Promise.resolve({
            ok: true,
            json: async () => [makeIssue('1', `First task v${listVersion}`)],
          });
        },
      );
    vi.stubGlobal('fetch', fetchMock);
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);
    const onOpenTask = vi.fn();

    render(<TasksList onOpenTask={onOpenTask} />);
    await screen.findByText('First task v1');

    fireEvent.click(
      screen.getByRole('button', { name: 'Удалить задачу First task v1' }),
    );

    expect(await screen.findByText('First task v2')).toBeInTheDocument();
    expect(confirmMock).toHaveBeenCalledWith(
      'Удалить задачу и всю её рабочую папку?',
    );
    expect(deletedUrls).toEqual(['/issue-resolver/api/v1/issues/1']);
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('отмена подтверждения не удаляет задачу', async () => {
    const deletedUrls: string[] = [];
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
});