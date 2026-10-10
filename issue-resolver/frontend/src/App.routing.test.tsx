import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import App from './App';

const issue = {
  id: 'issue-1',
  title: 'Fix login bug',
  jira_issue_url: null,
  repositories: [],
  pipeline_steps: ['resolve'],
  status: 'pending',
  created_at: '2026-10-09T00:00:00.000Z',
  updated_at: '2026-10-09T00:00:00.000Z',
};

function setHash(hash: string) {
  window.history.replaceState(null, '', hash || '/');
}

function stubFetch(issues = [issue]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/iterations')) {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (url.endsWith('/issues')) {
      return Promise.resolve({ ok: true, json: async () => issues });
    }
    return Promise.resolve({ ok: true, json: async () => issue });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mobileNav() {
  return screen.getByRole('navigation', { name: 'Мобильная навигация' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setHash('');
});

describe('App routing', () => {
  it('renders the tasks list for #/tasks', async () => {
    stubFetch();
    setHash('#/tasks');
    render(<App />);

    expect(
      await screen.findByText('История запусков Issue Resolver'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('renders TaskDetail for #/tasks/:issueId', async () => {
    const fetchMock = stubFetch();
    setHash('#/tasks/abc');
    render(<App />);

    expect(await screen.findByText('Итерации')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/issues/abc'),
    );
  });

  it('renders TaskDetail for #/tasks/:issueId/result', async () => {
    const fetchMock = stubFetch();
    setHash('#/tasks/abc/result');
    render(<App />);

    expect(await screen.findByText('Итерации')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/issues/abc'),
    );
  });

  it('falls back to the tasks list for an empty hash', async () => {
    stubFetch();
    setHash('');
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Мои задачи' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('falls back to the tasks list for an unknown hash', async () => {
    stubFetch();
    setHash('#/nope');
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Мои задачи' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('navigates to #/tasks from the nav item', async () => {
    stubFetch();
    setHash('');
    render(<App />);

    fireEvent.click(
      within(mobileNav()).getByRole('button', { name: 'Мои задачи' }),
    );

    expect(window.location.hash).toBe('#/tasks');
    expect(
      await screen.findByText('История запусков Issue Resolver'),
    ).toBeInTheDocument();
  });

  it('pushes #/tasks/:issueId when a task is opened', async () => {
    stubFetch();
    setHash('#/tasks');
    render(<App />);

    fireEvent.click(await screen.findByText('Fix login bug'));

    expect(window.location.hash).toBe('#/tasks/issue-1');
    expect(await screen.findByText('Итерации')).toBeInTheDocument();
  });

  it('updates the view when the hash changes', async () => {
    stubFetch();
    setHash('#/new');
    render(<App />);

    expect(screen.getByLabelText('Заголовок')).toBeInTheDocument();

    window.history.replaceState(null, '', '#/tasks');
    window.dispatchEvent(new Event('hashchange'));

    expect(
      await screen.findByText('История запусков Issue Resolver'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('returns to #/tasks from TaskDetail back button', async () => {
    stubFetch();
    setHash('#/tasks/issue-1');
    render(<App />);

    fireEvent.click(await screen.findByText('← Мои задачи'));

    expect(window.location.hash).toBe('#/tasks');
    expect(
      await screen.findByText('История запусков Issue Resolver'),
    ).toBeInTheDocument();
  });
});