import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

function setPath(path: string) {
  window.history.replaceState(null, '', path || '/');
}

function stubFetch(issues = [issue]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/iterations')) {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (url.endsWith('/repositories')) {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setPath('');
});

describe('App routing', () => {
  it('renders the tasks list for /tasks', async () => {
    stubFetch();
    setPath('/tasks');
    render(<App />);

    expect(await screen.findByText('Fix login bug')).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('renders TaskDetail for /tasks/:issueId', async () => {
    const fetchMock = stubFetch();
    setPath('/tasks/abc');
    render(<App />);

    expect(await screen.findByText('Итераций пока нет.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/issues/abc'),
    );
  });

  it('renders TaskDetail for /tasks/:issueId/result', async () => {
    const fetchMock = stubFetch();
    setPath('/tasks/abc/result');
    render(<App />);

    expect(await screen.findByText('Итераций пока нет.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/issues/abc'),
    );
  });

  it('falls back to the tasks list for an empty path', async () => {
    stubFetch();
    setPath('');
    render(<App />);

    expect(await screen.findByText('Fix login bug')).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('falls back to the tasks list for an unknown path', async () => {
    stubFetch();
    setPath('/nope');
    render(<App />);

    expect(await screen.findByText('Fix login bug')).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('navigates to /tasks from the top nav item', async () => {
    stubFetch();
    setPath('/repositories');
    render(<App />);

    fireEvent.click(
      within(screen.getByTestId('desktop-nav')).getByRole('button', {
        name: 'Задачи',
      }),
    );

    expect(window.location.pathname).toBe('/tasks');
    expect(await screen.findByText('Fix login bug')).toBeInTheDocument();
  });

  it('pushes /tasks/:issueId when a task is opened', async () => {
    stubFetch();
    setPath('/tasks');
    render(<App />);

    fireEvent.click(await screen.findByText('Fix login bug'));

    expect(window.location.pathname).toBe('/tasks/issue-1');
    expect(await screen.findByText('Итераций пока нет.')).toBeInTheDocument();
  });

  it('updates the view when the path changes', async () => {
    stubFetch();
    setPath('/new');
    render(<App />);

    expect(screen.getByLabelText('Заголовок')).toBeInTheDocument();

    window.history.replaceState(null, '', '/tasks');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(await screen.findByText('Fix login bug')).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

});