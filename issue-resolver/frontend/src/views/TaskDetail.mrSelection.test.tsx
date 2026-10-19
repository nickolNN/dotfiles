import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Issue, Iteration } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';
import { setMarkdownEditorValue } from '../test/markdown-editor';

/** Открывает модалку новой итерации кликом по кнопке. */
async function openIterationModal() {
  fireEvent.click(await screen.findByTestId('open-iteration-modal'));
  await screen.findByTestId('new-iteration-island');
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

function makeRepositories() {
  return [
    {
      id: 'repo-a',
      repository_url: 'https://github.com/acme/app.git',
      branch_name: 'main',
      create_mr: true,
      bootstrap_enabled: true,
      created_at: '2026-10-16T00:00:00.000Z',
      updated_at: '2026-10-16T00:00:00.000Z',
    },
    {
      id: 'repo-b',
      repository_url: 'https://github.com/acme/lib.git',
      branch_name: 'main',
      create_mr: false,
      bootstrap_enabled: true,
      created_at: '2026-10-16T00:00:00.000Z',
      updated_at: '2026-10-16T00:00:00.000Z',
    },
  ];
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: makeRepositories(),
    pipeline_steps: ['resolve', 'pr'],
    status: 'pending',
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
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
    steps: ['resolve', 'pr'],
    status: 'completed',
    created_at: '2026-10-16T00:00:00.000Z',
    updated_at: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — выбор репозиториев для MR', () => {
  it('снятие шага PR шлёт пустой pr_repository_ids и steps без pr', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            return Promise.resolve(jsonResponse(iteration, { status: 201 }));
          }
          return Promise.resolve(jsonResponse([iteration]));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);

    await openIterationModal();
    // Шаг PR выбран из pipeline_steps, репозиторий A — с create_mr.
    const prCheckbox = (await screen.findByLabelText('PR')) as HTMLInputElement;
    expect(prCheckbox.checked).toBe(true);
    expect(
      (screen.getByTestId('pr-repo-repo-a') as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.click(prCheckbox);
    expect(prCheckbox.checked).toBe(false);

    await openIterationModal();
    setMarkdownEditorValue('Контекст итерации', 'без MR');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const [, init] = postCall as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      steps?: string[];
      pr_repository_ids?: string[];
    };
    expect(body.pr_repository_ids).toEqual([]);
    expect(body.steps ?? []).not.toContain('pr');
  });

  it('снятие всех галочек репо при выбранном PR шлёт пустой список', async () => {
    const issue = makeIssue();
    const iteration = makeIteration();
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/iterations')) {
          if (init?.method === 'POST') {
            return Promise.resolve(jsonResponse(iteration, { status: 201 }));
          }
          return Promise.resolve(jsonResponse([iteration]));
        }
        return Promise.resolve(jsonResponse(issue));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskDetail issueId="issue-1" />);

    await openIterationModal();
    await screen.findByLabelText('PR');

    // Снимаем единственный выбранный репо, шаг PR остаётся выбранным.
    fireEvent.click(screen.getByTestId('pr-repo-repo-a'));
    expect(
      (screen.getByTestId('pr-repo-repo-a') as HTMLInputElement).checked,
    ).toBe(false);

    await openIterationModal();
    setMarkdownEditorValue('Контекст итерации', 'без репо');
    fireEvent.click(
      screen.getByRole('button', { name: 'Запустить новую итерацию' }),
    );

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    );
    const [, init] = postCall as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      pr_repository_ids?: string[];
    };
    expect(body.pr_repository_ids).toEqual([]);
  });
});