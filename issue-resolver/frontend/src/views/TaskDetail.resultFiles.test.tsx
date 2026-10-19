import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  Issue,
  Iteration,
  StepRunWithLog,
  WorkspaceFile,
} from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

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

function makeStepRun(overrides: Partial<StepRunWithLog> = {}): StepRunWithLog {
  return {
    id: 'run-1',
    iteration_id: 'iter-1',
    step: 'resolve',
    attempt: 1,
    status: 'success',
    context: '',
    feedback: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    stdout: '',
    stderr: '',
    events: [],
    stats: null,
    report: '{"status":"pass","summary":"ok"}',
    screenshots_dir: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function textResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}

/** fetch-мок: /result/files отдаёт файлы, остальное — issue/iterations/result. */
function stubFetch(
  issue: Issue,
  files: WorkspaceFile[],
  iterations: Iteration[] = [makeIteration()],
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/result/files/content')) {
      return Promise.resolve(textResponse('file body'));
    }
    if (url.endsWith('/result/files')) {
      return Promise.resolve(jsonResponse(files));
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse([makeStepRun()]));
    }
    if (url.endsWith('/result')) {
      return Promise.resolve(textResponse('# Итог'));
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse(iterations));
    }
    return Promise.resolve(jsonResponse(issue));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — порождённые файлы отчёта', () => {
  it('готовый отчёт + файлы → кнопка «Артефакты (2)», клик открывает модалку со ссылками', async () => {
    const files: WorkspaceFile[] = [
      {
        name: 'index.html',
        rel_path: 'index.html',
        size: 2048,
        mime_type: 'text/html',
      },
      {
        name: 'styles.css',
        rel_path: 'styles.css',
        size: 100,
        mime_type: 'text/css',
      },
    ];
    stubFetch(makeIssue({ desired_result: 'html' }), files);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    // В шапке больше нет списка ссылок — вместо них кнопка-счётчик.
    expect(screen.queryByTestId('result-files')).toBeNull();
    expect(screen.queryByTestId('result-file-download')).toBeNull();
    const open = await screen.findByTestId('open-artifacts');
    await waitFor(() => expect(open).toBeEnabled());
    expect(open).toHaveTextContent('Артефакты (2)');

    fireEvent.click(open);
    const modal = await screen.findByTestId('artifacts-modal');
    const downloads = within(modal).getAllByTestId('artifact-download');
    expect(downloads).toHaveLength(2);
    expect(downloads[0]).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/files/content?path=index.html',
    );
    expect(downloads[0]).toHaveAttribute('download', 'index.html');
    expect(downloads[1]).toHaveAttribute('download', 'styles.css');
    expect(downloads[1]).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/files/content?path=styles.css',
    );
  });

  it('rel_path с подпапкой кодируется в query ссылки скачивания', async () => {
    stubFetch(makeIssue({ desired_result: 'html' }), [
      {
        name: 'leaf.txt',
        rel_path: 'nested/leaf.txt',
        size: 4,
        mime_type: 'text/plain',
      },
    ]);

    render(<TaskDetail issueId="issue-1" />);
    const open = await screen.findByTestId('open-artifacts');
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);

    expect(await screen.findByTestId('artifact-download')).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/files/content?path=nested%2Fleaf.txt',
    );
  });

  it('пустой список файлов → кнопка «Артефакты (0)» задизейблена, модалки нет', async () => {
    stubFetch(makeIssue({ desired_result: 'md' }), []);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() =>
      expect(screen.getByTestId('open-result')).toBeEnabled(),
    );

    const open = screen.getByTestId('open-artifacts');
    expect(open).toBeDisabled();
    expect(open).toHaveTextContent('Артефакты (0)');
    expect(screen.queryByTestId('result-files')).toBeNull();
    expect(screen.queryByTestId('result-file-download')).toBeNull();
    expect(screen.queryByTestId('artifacts-modal')).toBeNull();
    // сама кнопка «Скачать» теперь в модалке отчёта
    fireEvent.click(screen.getByTestId('open-result'));
    const modal = await screen.findByTestId('result-modal');
    expect(within(modal).getByTestId('result-modal-download')).toBeInTheDocument();
  });

  it('ссылка архива ведёт на /result/files/archive с явным именем', async () => {
    stubFetch(makeIssue({ desired_result: 'html' }), []);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() =>
      expect(screen.getByTestId('open-result')).toBeEnabled(),
    );

    const archive = screen.getByTestId('download-archive');
    expect(archive).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/files/archive',
    );
    expect(archive).toHaveAttribute('download', 'issue-issue-1.tar.gz');
    expect(archive).toHaveTextContent('Скачать всё (.tar.gz)');
    expect(archive).not.toHaveAttribute('aria-disabled');
  });

  it.each([
    ['md', 'report.md'],
    ['html', 'report.html'],
  ] as const)(
    'download-result для desired_result=%s получает имя %s',
    async (desired, filename) => {
      stubFetch(makeIssue({ desired_result: desired }), []);

      render(<TaskDetail issueId="issue-1" />);
      await screen.findByText('Fix login bug');
      await waitFor(() =>
        expect(screen.getByTestId('open-result')).toBeEnabled(),
      );

      // Кнопка «Скачать» теперь в модалке.
      fireEvent.click(screen.getByTestId('open-result'));
      const modal = await screen.findByTestId('result-modal');
      expect(within(modal).getByTestId('result-modal-download')).toHaveAttribute(
        'download',
        filename,
      );
    },
  );

  it('пока отчёт не готов — архив задизейблен и клик отбит', async () => {
    // Итераций нет → resultReady = false.
    stubFetch(makeIssue({ desired_result: 'html' }), [], []);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const archive = screen.getByTestId('download-archive');
    expect(archive).toHaveAttribute('aria-disabled', 'true');
    expect(archive).toHaveAttribute('tabindex', '-1');
  });
});