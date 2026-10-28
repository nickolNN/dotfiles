import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Issue, Iteration } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [],
    pipeline_steps: ['resolve'],
    status: 'running',
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
    // Подготовка рабочей папки идёт именно в статусе `preparing`.
    status: 'preparing',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** Минимальный фейк EventSource: ручная отдача onmessage. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function stubFetch() {
  const issue = makeIssue();
  const iteration = makeIteration();

  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

/** Публикует `workspace_progress` от бэкенда. */
function emitProgress(
  step: string,
  status: string,
  extra: Record<string, unknown> = {},
): void {
  act(() => {
    FakeEventSource.instances[0].emit({
      type: 'workspace_progress',
      issueId: 'issue-1',
      iterationId: 'iter-1',
      data: JSON.stringify({ step, status, ...extra }),
      ts: '2026-10-09T00:00:00.000Z',
    });
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — прогресс подготовки воркспейса', () => {
  it('workspace_progress — самостоятельная панель перед списком итераций', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    emitProgress('creating_dirs', 'done');
    emitProgress('cloning', 'done', { repo: 'owner/repo' });
    emitProgress('checking_instructions', 'done', { repo: 'owner/repo' });
    emitProgress('devops', 'running', { repo: 'owner/repo' });
    emitProgress('installing', 'running');

    const panel = await screen.findByTestId('workspace-progress');
    expect(within(panel).getByText('Подготовка проектов')).toBeInTheDocument();
    expect(within(panel).getByText('Создание рабочей папки')).toBeInTheDocument();
    expect(within(panel).getByText('Клонирование owner/repo')).toBeInTheDocument();
    expect(
      within(panel).getByText('Проверка инструкции запуска owner/repo'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('DevOps owner/repo'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('Установка зависимостей'),
    ).toBeInTheDocument();

    // Панель — отдельный блок перед списком итераций: рендерится ровно
    // один раз и стоит до первой карточки итерации.
    const firstCard = screen.getByText(/Итерация #1/);
    expect(
      panel.compareDocumentPosition(firstCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(firstCard).not.toContainElement(panel);
    expect(screen.getAllByTestId('workspace-progress')).toHaveLength(1);
  });

  it('status running → ⏳, done → ✓, error → ✕ + message', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const stepOf = (step: string) =>
      screen
        .getAllByTestId('workspace-step')
        .find((node) => node.getAttribute('data-step') === step);

    emitProgress('creating_dirs', 'running');
    expect(stepOf('creating_dirs')).toHaveAttribute('data-status', 'running');
    expect(stepOf('creating_dirs')).toHaveTextContent('⏳');

    emitProgress('creating_dirs', 'done');
    expect(stepOf('creating_dirs')).toHaveAttribute('data-status', 'done');
    expect(stepOf('creating_dirs')).toHaveTextContent('✓');

    emitProgress('installing', 'error', { message: 'install failed' });
    expect(stepOf('installing')).toHaveAttribute('data-status', 'error');
    expect(stepOf('installing')).toHaveTextContent('✕');
    expect(stepOf('installing')).toHaveTextContent('install failed');
  });

  it('log DevOps → SessionView с накоплением stdout/stderr', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    emitProgress('devops', 'running', { repo: 'owner/repo' });
    const emitLog = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => {
      act(() => {
        FakeEventSource.instances[0].emit({
          type: 'log',
          issueId: 'issue-1',
          iterationId: 'iter-1',
          stepRunId: 'issue.issue-1.devops',
          stream,
          data: text,
          ts: '2026-10-09T00:00:00.000Z',
        });
      });
    };
    emitLog('> npm ci\n');
    emitLog('added 42 packages\n');
    emitLog('npm warn deprecated\n', 'stderr');

    // Синтетический stepRunId `{issueId}/devops` — сессия над панелью
    // подготовки; чанки stdout/stderr копятся как text-события.
    const session = await screen.findByTestId('devops-session');
    expect(session).toHaveTextContent('npm ci');
    expect(session).toHaveTextContent('added 42 packages');
    expect(session).toHaveTextContent('npm warn deprecated');
  });

  it('log с чужим stepRunId не попадает в DevOps-сессию', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    emitProgress('devops', 'running', { repo: 'owner/repo' });
    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'log',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        stepRunId: 'run-1',
        stream: 'stdout',
        data: 'step output',
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    const panel = await screen.findByTestId('workspace-progress');
    expect(within(panel).queryByTestId('devops-session')).toBeNull();
  });

  it('iteration_status failed с error → красный баннер', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'iteration_status',
        issueId: 'issue-1',
        iterationId: 'iter-1',
        data: JSON.stringify({
          iterationId: 'iter-1',
          status: 'failed',
          needsInput: false,
          error: 'clone failed — repository not found',
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    const banner = await screen.findByTestId('iteration-error');
    expect(banner).toHaveTextContent('Ошибка подготовки');
    expect(banner).toHaveTextContent('clone failed — repository not found');
  });

  it('ready → через 3с панель помечается затухающей', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    vi.useFakeTimers();
    emitProgress('ready', 'done');
    expect(screen.getByTestId('workspace-progress')).toHaveAttribute(
      'data-fading',
      'false',
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('workspace-progress')).toHaveAttribute(
      'data-fading',
      'true',
    );
  });

  it('без событий панели нет', async () => {
    stubFetch();
    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(screen.queryByTestId('workspace-progress')).toBeNull();
  });
});