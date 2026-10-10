import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';

function stubEmptyIssues() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('renders the tasks list by default', async () => {
    stubEmptyIssues();
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Мои задачи' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('switches to the tasks list from the mobile navigation', async () => {
    stubEmptyIssues();
    render(<App />);

    const mobile = screen.getByRole('navigation', {
      name: 'Мобильная навигация',
    });
    fireEvent.click(within(mobile).getByRole('button', { name: 'Мои задачи' }));

    expect(
      await screen.findByText('История запусков Issue Resolver'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('returns to the new issue form from the mobile navigation', () => {
    stubEmptyIssues();
    render(<App />);

    const mobile = screen.getByRole('navigation', {
      name: 'Мобильная навигация',
    });
    fireEvent.click(within(mobile).getByRole('button', { name: 'Мои задачи' }));
    fireEvent.click(within(mobile).getByRole('button', { name: 'Новая задача' }));

    expect(screen.getByLabelText('Заголовок')).toBeInTheDocument();
  });

  it('opens the task detail when a task is clicked in the list', async () => {
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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/iterations')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.endsWith('/issues')) {
        return Promise.resolve({ ok: true, json: async () => [issue] });
      }
      return Promise.resolve({ ok: true, json: async () => issue });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    const mobile = screen.getByRole('navigation', {
      name: 'Мобильная навигация',
    });
    fireEvent.click(within(mobile).getByRole('button', { name: 'Мои задачи' }));

    fireEvent.click(await screen.findByText('Fix login bug'));

    expect(await screen.findByText('Итерации')).toBeInTheDocument();
  });
});