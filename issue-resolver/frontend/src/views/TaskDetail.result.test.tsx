import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Issue, Iteration, StepRunWithLog } from '@issue-resolver/shared';
import TaskDetail from './TaskDetail';

const RESULT_URL = '/issue-resolver/api/v1/issues/issue-1/result';

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

function textResponse(
  body: string,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => body,
  } as Response;
}

/** fetch-мок: /result отдаёт resultResponse, остальное — issue/iterations/
 * step-runs. Готовность отчёта определяется статусом итерации (снапшот
 * создаётся на completed), поэтому тесты неготового отчёта передают
 * свой список итераций; по умолчанию одна completed-итерация. */
function stubFetch(
  issue: Issue,
  resultResponse: () => Promise<Response> | Response,
  stepRuns: StepRunWithLog[] = [makeStepRun()],
  iterations: Iteration[] = [makeIteration()],
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse(stepRuns));
    }
    if (url.endsWith('/result')) {
      return Promise.resolve(resultResponse());
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse(iterations));
    }
    return Promise.resolve(jsonResponse(issue));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Ждёт, пока step-runs загрузятся и гейт включит кнопку, затем кликает. */
async function clickOpenResult(): Promise<void> {
  const button = screen.getByTestId('open-result');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — просмотр отчёта', () => {
  it('desired_result md → кнопка «Показать отчёт» на странице, «Скачать» — в модалке', async () => {
    stubFetch(makeIssue({ desired_result: 'md' }), () =>
      textResponse('# Итог'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(screen.getByTestId('open-result')).toHaveTextContent(
      'Показать отчёт',
    );
    // Кнопка «Скачать» теперь в модалке — открываем её.
    fireEvent.click(screen.getByTestId('open-result'));
    const modal = await screen.findByTestId('result-modal');
    const download = within(modal).getByTestId('result-modal-download');
    expect(download).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/download',
    );
    expect(download).toHaveAttribute('download');
  });

  it('итерация без completed → кнопка «Показать отчёт» disabled', async () => {
    stubFetch(
      makeIssue({ desired_result: 'md' }),
      () => textResponse('# Итог'),
      [makeStepRun({ report: '' })],
      [makeIteration({ status: 'failed' })],
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const open = await screen.findByTestId('open-result');
    await waitFor(() => expect(open).toBeDisabled());
  });

  it('пустой список итераций → кнопка «Показать отчёт» disabled', async () => {
    stubFetch(
      makeIssue({ desired_result: 'md' }),
      () => textResponse('# Итог'),
      [makeStepRun()],
      [],
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const open = await screen.findByTestId('open-result');
    await waitFor(() => expect(open).toBeDisabled());
  });

  it('iteration completed + пустой report → кнопка «Показать отчёт» активна', async () => {
    stubFetch(
      makeIssue({ desired_result: 'md' }),
      () => textResponse('# Итог'),
      [makeStepRun({ report: '' })],
      [makeIteration({ status: 'completed' })],
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const open = await screen.findByTestId('open-result');
    await waitFor(() => expect(open).toBeEnabled());
  });

  it('клик открывает модалку с iframe (всегда HTML)', async () => {
    stubFetch(makeIssue(), () =>
      textResponse('<html>отчёт</html>'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await clickOpenResult();

    const modal = await screen.findByTestId('result-modal');
    const frame = within(modal).getByTitle('Отчёт');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', RESULT_URL);
  });

  it('desired_result html → iframe с правильным src', async () => {
    stubFetch(makeIssue({ desired_result: 'html' }), () =>
      textResponse('<html></html>'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await clickOpenResult();

    const modal = await screen.findByTestId('result-modal');
    const frame = within(modal).getByTitle('Отчёт');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', RESULT_URL);
  });

  it('autoOpenResult → модалка открывается сама, без клика (html)', async () => {
    stubFetch(makeIssue({ desired_result: 'html' }), () =>
      textResponse('<html></html>'),
    );

    render(<TaskDetail issueId="issue-1" autoOpenResult />);

    const modal = await screen.findByTestId('result-modal');
    const frame = within(modal).getByTitle('Отчёт');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', RESULT_URL);
  });

  it('модалку отчёта можно закрыть', async () => {
    stubFetch(makeIssue({ desired_result: 'md' }), () =>
      textResponse('# Итог'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await clickOpenResult();
    expect(await screen.findByTestId('result-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('result-modal-close'));
    expect(screen.queryByTestId('result-modal')).toBeNull();
  });

  it('desired_result не задан → кнопка «Показать отчёт» всё равно есть', async () => {
    stubFetch(makeIssue(), () => textResponse('# Итог'));

    render(<TaskDetail issueId="issue-1" />);
    await waitFor(() =>
      expect(screen.getByText('Fix login bug')).toBeInTheDocument(),
    );

    expect(screen.getByTestId('open-result')).toBeInTheDocument();
  });
});