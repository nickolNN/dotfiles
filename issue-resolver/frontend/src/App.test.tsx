import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import App from './App';
import { useUIStore } from './stores/ui';

function stubEmpty() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
  );
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  useUIStore.getState().setContainerStats(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('App', () => {
  it('renders the tasks list by default with the tasks tab active', async () => {
    stubEmpty();
    render(<App />);

    expect(
      await screen.findByText('Пока нет ни одной задачи.'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('desktop-nav')).getByRole('button', {
        name: 'Задачи',
      }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('switches to the repositories page from the top navigation', async () => {
    stubEmpty();
    render(<App />);

    const desktopNav = within(screen.getByTestId('desktop-nav'));
    fireEvent.click(desktopNav.getByRole('button', { name: 'Репозитории' }));

    expect(await screen.findByTestId('repositories-page')).toBeInTheDocument();
    expect(
      desktopNav.getByRole('button', { name: 'Репозитории' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByLabelText('Заголовок')).not.toBeInTheDocument();
  });

  it('opens the new issue form from the + button on the tasks tab', () => {
    stubEmpty();
    render(<App />);

    const primary = screen.getByTestId('primary-action');
    expect(primary).toHaveAttribute('aria-label', 'Создать задачу');
    fireEvent.click(primary);

    expect(screen.getByLabelText('Заголовок')).toBeInTheDocument();
  });

  it('opens the add-repo dialog from the + button on the repositories tab', async () => {
    stubEmpty();
    render(<App />);

    fireEvent.click(
      within(screen.getByTestId('desktop-nav')).getByRole('button', {
        name: 'Репозитории',
      }),
    );
    await screen.findByTestId('repositories-page');

    const primary = screen.getByTestId('primary-action');
    expect(primary).toHaveAttribute('aria-label', 'Добавить репозиторий');
    fireEvent.click(primary);

    expect(await screen.findByTestId('repo-form')).toBeInTheDocument();
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

    fireEvent.click(await screen.findByText('Fix login bug'));

    expect(await screen.findByText('Итераций пока нет.')).toBeInTheDocument();
    expect(screen.getByTestId('task-island')).toBeInTheDocument();
  });

  it('shows container stats placeholder on the list while no data yet', async () => {
    const issue = {
      id: 'issue-1',
      title: 'Fix login bug',
      jira_issue_url: null,
      repositories: [],
      pipeline_steps: ['resolve'],
      status: 'running',
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

    await screen.findByText('Fix login bug');
    const stats = screen.getByTestId('container-stats');
    expect(stats).toHaveTextContent('CPU —');
    expect(stats).toHaveTextContent('MEM —');
    expect(screen.getByTestId('cpu-health')).toHaveClass('bg-[#00FF41]/20');
    expect(screen.getByTestId('mem-health')).toHaveClass('bg-[#00FF41]/20');

    expect(
      FakeEventSource.instances.some((source) =>
        source.url.endsWith('/api/v1/container-stats-stream'),
      ),
    ).toBe(true);
  });

  it('shows live container stats on all pages, independent of the open task', async () => {
    const issue = {
      id: 'issue-1',
      title: 'Fix login bug',
      jira_issue_url: null,
      repositories: [],
      pipeline_steps: ['resolve'],
      status: 'running',
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

    await screen.findByText('Fix login bug');
    const globalStreams = FakeEventSource.instances.filter((source) =>
      source.url.endsWith('/api/v1/stream'),
    );
    expect(globalStreams.length).toBeGreaterThan(0);

    act(() => {
      for (const stream of globalStreams) {
        stream.emit({
          type: 'container_stats',
          issueId: '__global__',
          data: JSON.stringify({
            cpuPercent: 12.45,
            memoryUsageBytes: 268435456,
            memoryLimitBytes: 2147483648,
            pids: 5,
          }),
          ts: '2026-10-13T00:00:00.000Z',
        });
      }
    });

    expect(await screen.findByTestId('container-stats')).toHaveTextContent(
      'CPU 12.4%',
    );
    expect(screen.getByTestId('cpu-health')).toHaveStyle({
      backgroundColor: '#00FF41',
    });
    expect(screen.getByTestId('mem-health')).toHaveStyle({
      backgroundColor: '#00FF41',
    });

    fireEvent.click(screen.getByText('Fix login bug'));
    await screen.findByText('Итераций пока нет.');
    fireEvent.click(
      within(screen.getByTestId('desktop-nav')).getByRole('button', {
        name: 'Задачи',
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('container-stats')).toHaveTextContent(
        'CPU 12.4%',
      ),
    );
    expect(screen.getByTestId('cpu-health')).toHaveStyle({
      backgroundColor: '#00FF41',
    });
  });

  it('renders the mobile topbar with stats and +, the bottom nav, and hides the desktop header', async () => {
    stubEmpty();
    render(<App />);
    await screen.findByText('Пока нет ни одной задачи.');

    const topbar = screen.getByTestId('mobile-topbar');
    expect(topbar).toHaveClass('sm:hidden');
    expect(
      within(topbar).getByTestId('container-stats-mobile'),
    ).toHaveTextContent('CPU —');
    const mobileAction = within(topbar).getByTestId('primary-action-mobile');
    expect(mobileAction).toHaveAttribute('aria-label', 'Создать задачу');

    const mobileNav = screen.getByTestId('mobile-nav');
    expect(mobileNav).toHaveAttribute('aria-label', 'Мобильная навигация');
    expect(mobileNav).toHaveClass('fixed', 'bottom-0', 'sm:hidden');
    expect(
      within(mobileNav).getByRole('button', { name: 'Теги' }),
    ).toBeInTheDocument();

    expect(screen.getByTestId('desktop-header')).toHaveClass('hidden', 'sm:block');

    fireEvent.click(mobileAction);
    expect(screen.getByLabelText('Заголовок')).toBeInTheDocument();
  });
});