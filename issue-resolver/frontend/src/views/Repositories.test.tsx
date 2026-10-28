import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RepoInfo, SavedRepo } from '@issue-resolver/shared';
import Repositories from './Repositories';

const REPO_INFO: RepoInfo = {
  platform: 'github',
  fullName: 'acme/app',
  defaultBranch: 'main',
  branches: ['main', 'develop'],
  language: 'TypeScript',
  description: 'App',
  stars: 10,
  isPrivate: false,
  cloneUrl: 'https://github.com/acme/app.git',
  writeAccess: true,
};

function savedRepo(
  id: string,
  overrides: Partial<SavedRepo> = {},
): SavedRepo {
  return {
    id,
    url: `https://github.com/acme/${id}.git`,
    platform: 'github',
    fullName: `acme/${id}`,
    defaultBranch: 'main',
    cloneUrl: `https://github.com/acme/${id}.git`,
    language: 'TypeScript',
    description: null,
    isPrivate: false,
    connectionStatus: 'ok',
    lastValidatedAt: '2026-10-12T10:00:00.000Z',
    writeAccess: true,
    runInstructions: null,
    runInstructionsStatus: 'unknown',
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

const jsonOk = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

const jsonStatus = (ok: boolean, status: number, body: unknown) =>
  Promise.resolve({ ok, status, json: async () => body });

interface StubOptions {
  repos?: SavedRepo[];
  listError?: string;
  created?: SavedRepo;
  updated?: SavedRepo;
  validated?: SavedRepo;
}

function stubRepositoriesApi(options: StubOptions = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/repos/validate')) {
      return jsonOk({
        results: [
          {
            url: 'https://github.com/acme/new',
            valid: true,
            platform: 'github',
            info: REPO_INFO,
          },
        ],
      });
    }
    if (url.endsWith('/repositories') && method === 'GET') {
      if (options.listError) {
        return jsonStatus(false, 500, { error: options.listError });
      }
      return jsonOk(options.repos ?? []);
    }
    if (url.endsWith('/repositories') && method === 'POST') {
      return jsonOk(options.created ?? savedRepo('new'));
    }
    if (/\/repositories\/[^/]+\/validate$/.test(url)) {
      return jsonOk(options.validated ?? savedRepo('repo-1'));
    }
    if (/\/repositories\/[^/]+$/.test(url) && method === 'PUT') {
      return jsonOk(options.updated ?? savedRepo('repo-1'));
    }
    if (/\/repositories\/[^/]+$/.test(url) && method === 'DELETE') {
      return jsonStatus(true, 204, {});
    }
    return jsonOk(options.repos ?? []);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Repositories', () => {
  it('рендерит список с платформой, веткой и статусом', async () => {
    const ok = savedRepo('one');
    const failed = savedRepo('two', {
      connectionStatus: 'error',
      fullName: null,
      defaultBranch: null,
      platform: null,
    });
    stubRepositoriesApi({ repos: [ok, failed] });

    render(<Repositories />);

    expect(await screen.findByText(ok.fullName!)).toBeInTheDocument();
    expect(screen.getByText('acme/one')).toBeInTheDocument();
    expect(screen.getByTestId('repo-status-ok')).toBeInTheDocument();
    expect(screen.getByTestId('repo-status-error')).toBeInTheDocument();
    expect(screen.getAllByTestId('repo-card')).toHaveLength(2);
  });

  it('writeAccess:false → бейдж «только чтение», true → без бейджа', async () => {
    const readOnly = savedRepo('ro', { writeAccess: false });
    const writable = savedRepo('rw', { writeAccess: true });
    stubRepositoriesApi({ repos: [readOnly, writable] });

    render(<Repositories />);

    expect(await screen.findByText(readOnly.fullName!)).toBeInTheDocument();
    expect(screen.getAllByTestId('repo-read-only')).toHaveLength(1);
  });

  it('пустой список → подсказка', async () => {
    stubRepositoriesApi({ repos: [] });

    render(<Repositories />);

    expect(await screen.findByTestId('repo-list-empty')).toBeInTheDocument();
  });

  it('ошибка загрузки списка → сообщение и повтор', async () => {
    stubRepositoriesApi({ listError: 'boom' });

    render(<Repositories />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Повторить' }),
    ).toBeInTheDocument();
  });

  it('добавление: валидация URL → POST /repositories → карточка', async () => {
    const created = savedRepo('new', { url: 'https://github.com/acme/new' });
    const fetchMock = stubRepositoriesApi({ repos: [], created });

    const { rerender } = render(<Repositories />);
    await screen.findByTestId('repo-list-empty');

    rerender(<Repositories createSignal={1} />);
    await screen.findByTestId('repo-form');
    fireEvent.change(screen.getByTestId('repo-url-field'), {
      target: { value: 'https://github.com/acme/new' },
    });

    await waitFor(
      () => expect(screen.getByTestId('repo-form-save')).toBeEnabled(),
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByTestId('repo-form-save'));

    expect(await screen.findByText(created.fullName!)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith('/repositories') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(post).toBeTruthy();
    const [, init] = post as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      url: 'https://github.com/acme/new',
    });
  });

  it('редактирование: PUT /repositories/:id и обновление карточки', async () => {
    const repo = savedRepo('repo-1');
    const renamed = savedRepo('repo-1', {
      url: 'https://github.com/acme/renamed.git',
      fullName: 'acme/renamed',
    });
    const fetchMock = stubRepositoriesApi({
      repos: [repo],
      updated: renamed,
    });

    render(<Repositories />);
    await screen.findByText(repo.fullName!);
    fireEvent.click(screen.getByTestId('repo-edit'));

    await waitFor(
      () => expect(screen.getByTestId('repo-form-save')).toBeEnabled(),
      { timeout: 2000 },
    );
    fireEvent.change(screen.getByTestId('repo-url-field'), {
      target: { value: 'https://github.com/acme/renamed.git' },
    });
    await waitFor(
      () => expect(screen.getByTestId('repo-form-save')).toBeEnabled(),
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByTestId('repo-form-save'));

    expect(await screen.findByText(renamed.fullName!)).toBeInTheDocument();
    const put = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    expect(String((put as [string, RequestInit])[0])).toContain(
      '/repositories/repo-1',
    );
  });

  it('удаление с подтверждением: DELETE и удаление карточки', async () => {
    const repo = savedRepo('repo-1');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = stubRepositoriesApi({ repos: [repo] });

    render(<Repositories />);
    await screen.findByText(repo.fullName!);
    fireEvent.click(screen.getByTestId('repo-delete'));

    await waitFor(() => expect(screen.queryByText(repo.fullName!)).toBeNull());
    expect(confirmSpy).toHaveBeenCalled();
    const del = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(del).toBeTruthy();
  });

  it('проверка соединения обновляет статус карточки', async () => {
    const repo = savedRepo('repo-1', { connectionStatus: 'error' });
    stubRepositoriesApi({
      repos: [repo],
      validated: { ...repo, connectionStatus: 'ok' },
    });

    render(<Repositories />);
    await screen.findByTestId('repo-status-error');

    fireEvent.click(screen.getByTestId('repo-validate'));

    expect(await screen.findByTestId('repo-status-ok')).toBeInTheDocument();
  });
});