import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Issue, Iteration } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';
import { getMarkdownEditorValue, setMarkdownEditorValue } from '../test/markdown-editor';

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

function makeIssueWithMr(): Issue {
  return makeIssue({
    repositories: [
      {
        id: 'repo-1',
        repository_url: 'https://github.com/acme/app',
        branch_name: 'feature/x',
        create_mr: true,
        bootstrap_enabled: true,
        created_at: '2026-10-09T00:00:00.000Z',
        updated_at: '2026-10-09T00:00:00.000Z',
      },
    ],
    merge_requests: [
      {
        repository_url: 'https://github.com/acme/app',
        url: 'https://github.com/acme/app/pull/7',
      },
    ],
  });
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

interface StubOptions {
  iterations: () => Iteration[];
  createIteration?: (init?: RequestInit) => Promise<Response>;
  updateIteration?: (iterationId: string, init?: RequestInit) => Promise<Response>;
  queue?: (id: string) => Promise<Response>;
  review?: (id: string) => Promise<Response>;
  issue?: Issue;
}

function stubFetch(options: StubOptions) {
  const issue = options.issue ?? makeIssue();
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;

      const queueMatch = url.match(/\/iterations\/([^/]+)\/queue$/);
      if (method === 'POST' && queueMatch) {
        return options.queue
          ? options.queue(queueMatch[1])
          : Promise.resolve(jsonResponse({}));
      }

      const reviewMatch = url.match(
        /\/iterations\/([^/]+)\/fetch-review-comments$/,
      );
      if (method === 'POST' && reviewMatch) {
        return options.review
          ? options.review(reviewMatch[1])
          : Promise.resolve(jsonResponse({ comments: [] }));
      }

      const createMatch = url.match(/\/issues\/([^/]+)\/iterations$/);
      if (method === 'POST' && createMatch) {
        return options.createIteration
          ? options.createIteration(init)
          : Promise.resolve(jsonResponse({}));
      }

      const updateMatch = url.match(/\/iterations\/([^/]+)$/);
      if (method === 'PUT' && updateMatch) {
        return options.updateIteration
          ? options.updateIteration(updateMatch[1], init)
          : Promise.resolve(jsonResponse({}));
      }

      if (url.endsWith('/step-runs')) return Promise.resolve(jsonResponse([]));
      if (url.endsWith('/models')) return Promise.resolve(jsonResponse([]));
      if (url.endsWith('/files')) return Promise.resolve(jsonResponse([]));
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse(options.iterations()));
      }
      return Promise.resolve(jsonResponse(issue));
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function createCallTo(fetchMock: ReturnType<typeof vi.fn>, id = 'issue-1') {
  return fetchMock.mock.calls.find(
    ([input, init]) =>
      init?.method === 'POST' &&
      String(input).endsWith(`/issues/${id}/iterations`),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — draft-итерации и очередь', () => {
  it('при running-итерации кнопка «Создать черновик» создаёт draft', async () => {
    let list = [makeIteration({ id: 'iter-1', number: 1, status: 'running' })];
    const fetchMock = stubFetch({
      iterations: () => list,
      createIteration: () => {
        const created = makeIteration({
          id: 'iter-2',
          number: 2,
          status: 'draft',
          context: 'draft plan',
        });
        list = [...list, created];
        return Promise.resolve(jsonResponse(created, { status: 201 }));
      },
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    await openIterationModal();
    expect(
      screen.getByRole('button', { name: 'Создать черновик' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Запустить новую итерацию' }),
    ).toBeNull();

    await openIterationModal();
    setMarkdownEditorValue('Контекст итерации', 'draft plan');
    fireEvent.click(screen.getByRole('button', { name: 'Создать черновик' }));

    expect(await screen.findByText('Итерация #2')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.queryByTestId('new-iteration-island')).toBeNull(),
    );

    const createCall = createCallTo(fetchMock);
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body)).context).toBe('draft plan');
  });

  it('draft можно поставить в очередь: POST /queue → pending', async () => {
    let list = [makeIteration({ id: 'iter-1', number: 1, status: 'draft' })];
    const fetchMock = stubFetch({
      iterations: () => list,
      queue: () => {
        list = [makeIteration({ id: 'iter-1', number: 1, status: 'pending' })];
        return Promise.resolve(jsonResponse(list[0]));
      },
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    const queueButton = screen.getByTestId('queue-iteration');
    expect(queueButton).toHaveTextContent('В очередь');

    fireEvent.click(queueButton);

    const header = screen.getByText('Итерация #1').parentElement;
    await waitFor(() =>
      expect(within(header as HTMLElement).getByText('pending')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('queue-iteration')).toBeNull();

    const queueCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        init?.method === 'POST' &&
        String(input).endsWith('/iterations/iter-1/queue'),
    );
    expect(queueCall).toBeTruthy();
  });

  it('pending-итерация разрешает создать черновик (активная, нет draft)', async () => {
    stubFetch({
      iterations: () => [
        makeIteration({ id: 'iter-1', number: 1, status: 'pending' }),
      ],
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    expect(
      screen.getByRole('button', { name: 'Новая итерация' }),
    ).toBeInTheDocument();
    await openIterationModal();
    expect(
      screen.getByRole('button', { name: 'Создать черновик' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Запустить новую итерацию' }),
    ).toBeNull();
  });

  it('при running+draft модалка редактирует черновик, а не создаёт новый', async () => {
    let list = [
      makeIteration({ id: 'iter-1', number: 1, status: 'running' }),
      makeIteration({ id: 'iter-2', number: 2, status: 'draft', context: 'original context' }),
    ];
    const fetchMock = stubFetch({
      iterations: () => list,
      updateIteration: (iterationId: string) => {
        list = list.map((it) =>
          it.id === iterationId ? { ...it, context: 'updated context' } : it,
        );
        return Promise.resolve(
          jsonResponse(
            list.find((it) => it.id === iterationId)!,
            { status: 200 },
          ),
        );
      },
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    await openIterationModal();
    expect(getMarkdownEditorValue('Контекст итерации')).toBe('original context');

    setMarkdownEditorValue('Контекст итерации', 'updated context');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    const putCall = fetchMock.mock.calls.find(
      (call: [RequestInfo | URL, RequestInit?]) => call[1]?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    expect(String(putCall?.[0] ?? '')).toContain('/iterations/iter-2');

    await waitFor(() =>
      expect(screen.queryByTestId('new-iteration-island')).toBeNull(),
    );
  });

  it('кнопка «Ревью» у MR без комментариев → сообщение «код чист»', async () => {
    stubFetch({
      iterations: () => [
        makeIteration({
          id: 'iter-1',
          number: 1,
          status: 'completed',
          steps: ['resolve', 'pr'],
        }),
      ],
      review: () => Promise.resolve(jsonResponse({ comments: [] })),
      issue: makeIssueWithMr(),
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    fireEvent.click(screen.getByTestId('fetch-review'));

    const message = await screen.findByTestId('fetch-review-message');
    expect(message).toHaveTextContent('Комментариев ревью нет — код чист');
  });

  it('кнопка «Ревью» у MR с комментариями → File и предзаполнение без автозапуска', async () => {
    const fetchMock = stubFetch({
      iterations: () => [
        makeIteration({
          id: 'iter-1',
          number: 1,
          status: 'completed',
          steps: ['resolve', 'pr'],
        }),
      ],
      review: () =>
        Promise.resolve(
          jsonResponse({
            comments: [
              {
                repo: 'acme/app',
                file: 'src/a.ts',
                line: 12,
                body: 'Fix this',
                author: 'bob',
              },
            ],
          }),
        ),
      issue: makeIssueWithMr(),
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    fireEvent.click(screen.getByTestId('fetch-review'));

    await openIterationModal();
    expect(await screen.findByText('review-iteration-1.md')).toBeInTheDocument();
    await waitFor(() =>
      expect(getMarkdownEditorValue('Контекст итерации')).toContain(
        'Review comments from iteration #1',
      ),
    );

    expect(createCallTo(fetchMock)).toBeUndefined();
    expect(screen.getAllByText(/^Итерация #/)).toHaveLength(1);
  });

  it('без активного MR кнопки «Ревью» нет', async () => {
    stubFetch({
      iterations: () => [
        makeIteration({
          id: 'iter-1',
          number: 1,
          status: 'completed',
          steps: ['resolve', 'pr'],
        }),
      ],
      issue: makeIssue({
        repositories: [
          {
            id: 'repo-1',
            repository_url: 'https://github.com/acme/app',
            branch_name: 'feature/x',
            create_mr: true,
            bootstrap_enabled: true,
            created_at: '2026-10-09T00:00:00.000Z',
            updated_at: '2026-10-09T00:00:00.000Z',
          },
        ],
        merge_requests: [],
      }),
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    expect(screen.getByTestId('repo-mr-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('fetch-review')).toBeNull();
  });

  it('без активной итерации форма работает как раньше: «Запустить новую итерацию»', async () => {
    let list = [makeIteration({ id: 'iter-1', number: 1, status: 'completed' })];
    const fetchMock = stubFetch({
      iterations: () => list,
      createIteration: () => {
        const created = makeIteration({
          id: 'iter-2',
          number: 2,
          status: 'pending',
          context: 'again',
        });
        list = [...list, created];
        return Promise.resolve(jsonResponse(created, { status: 201 }));
      },
    });

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Итерация #1');

    await openIterationModal();
    expect(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Создать черновик' }),
    ).toBeNull();

    await openIterationModal();
    setMarkdownEditorValue('Контекст итерации', 'again');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    expect(await screen.findByText('Итерация #2')).toBeInTheDocument();
    expect(createCallTo(fetchMock)).toBeTruthy();
  });
});