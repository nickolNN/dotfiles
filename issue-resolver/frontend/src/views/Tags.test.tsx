import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { SavedRepo, Tag, TagRepositoryWithRepo } from '@issue-resolver/shared';
import Tags from './Tags';

function savedRepo(id: string): SavedRepo {
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
  };
}

function repoLink(id: string): TagRepositoryWithRepo {
  return {
    id: `link-${id}`,
    tag_id: 'tag-1',
    repository_id: id,
    bootstrap_enabled: true,
    created_at: '2026-10-12T00:00:00.000Z',
    repository: savedRepo(id),
  };
}

function makeTag(id: string, repositories: TagRepositoryWithRepo[] = []): Tag {
  return {
    id,
    name: 'Frontend',
    description: null,
    run_instructions: null,
    run_instructions_status: 'unknown',
    repositories,
    created_at: '2026-10-12T00:00:00.000Z',
    updated_at: '2026-10-12T00:00:00.000Z',
  };
}

const jsonOk = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

function stubTagsApi(options: { tags?: Tag[]; updated?: Tag } = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/repositories') && method === 'GET') {
      return jsonOk([savedRepo('repo-1')]);
    }
    if (url.endsWith('/tags') && method === 'GET') {
      return jsonOk(options.tags ?? []);
    }
    if (url.endsWith('/tags') && method === 'POST') {
      return jsonOk(options.updated ?? makeTag('new'));
    }
    if (/\/tags\/[^/]+$/.test(url) && method === 'PUT') {
      return jsonOk(options.updated ?? makeTag('tag-1', [repoLink('repo-1')]));
    }
    if (/\/tags\/[^/]+$/.test(url) && method === 'DELETE') {
      return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
    }
    return jsonOk([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Tags', () => {
  it('opens create form when + button clicked (createSignal)', async () => {
    stubTagsApi({ tags: [] });
    const { rerender } = render(<Tags />);
    await screen.findByTestId('tag-list-empty');

    rerender(<Tags createSignal={1} />);

    expect(await screen.findByTestId('tag-form')).toBeInTheDocument();
  });

  it('shows only the expandable repo count, no duplicate counter', async () => {
    const tag = makeTag('tag-1', [repoLink('repo-1'), repoLink('repo-2')]);
    stubTagsApi({ tags: [tag] });

    render(<Tags />);
    await screen.findByTestId('tag-card');

    const toggle = screen.getByTestId('tag-repositories-toggle');
    expect(toggle).toHaveTextContent('Репозитории (2)');
    // Текстовая строка «N репозиториев» из карточки убрана — счётчик только в кнопке.
    expect(screen.queryByText(/^\d+ репозитори/)).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getAllByTestId('tag-repository')).toHaveLength(2);
  });

  it('does not render repo toggle for a tag without repositories', async () => {
    stubTagsApi({ tags: [makeTag('tag-1', [])] });

    render(<Tags />);
    await screen.findByTestId('tag-card');

    expect(screen.queryByTestId('tag-repositories-toggle')).toBeNull();
  });

  it('renders edit/delete as icon buttons, not text links', async () => {
    stubTagsApi({ tags: [makeTag('tag-1', [])] });

    render(<Tags />);
    await screen.findByTestId('tag-card');

    const edit = screen.getByTestId('tag-edit');
    const del = screen.getByTestId('tag-delete');

    expect(edit).toHaveAttribute('aria-label', 'Редактировать тег');
    expect(del).toHaveAttribute('aria-label', 'Удалить тег');
    expect(edit.querySelector('svg')).toBeTruthy();
    expect(del.querySelector('svg')).toBeTruthy();
    // Раньше были текстовые ссылки — теперь текста нет.
    expect(screen.queryByText('Редактировать')).toBeNull();
    expect(screen.queryByText('Удалить')).toBeNull();
  });

  it('opens edit form and deletes a tag via icon buttons', async () => {
    const tag = makeTag('tag-1', [repoLink('repo-1')]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubTagsApi({ tags: [tag] });

    render(<Tags />);
    await screen.findByTestId('tag-card');

    fireEvent.click(screen.getByTestId('tag-edit'));
    expect(await screen.findByTestId('tag-form')).toBeInTheDocument();
    expect(screen.getByTestId('tag-name')).toHaveValue('Frontend');
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));

    await screen.findByTestId('tag-card');
    fireEvent.click(screen.getByTestId('tag-delete'));

    await waitFor(() => expect(screen.queryByTestId('tag-card')).toBeNull());
    expect(confirmSpy).toHaveBeenCalled();
  });
});