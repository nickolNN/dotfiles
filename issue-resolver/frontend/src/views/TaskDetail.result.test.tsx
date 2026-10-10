import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Issue, Iteration } from '@issue-resolver/shared';
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

/** fetch-мок: /result отдаёт resultResponse, остальное — issue/iterations. */
function stubFetch(
  issue: Issue,
  resultResponse: () => Promise<Response> | Response,
) {
  const iteration = makeIteration();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/result')) {
      return Promise.resolve(resultResponse());
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
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

describe('TaskDetail — просмотр результата', () => {
  it('desired_result md → кнопки «Показать результат» и «Скачать»', async () => {
    stubFetch(makeIssue({ desired_result: 'md' }), () =>
      textResponse('# Итог'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(screen.getByTestId('open-result')).toHaveTextContent(
      'Показать результат',
    );
    const download = screen.getByTestId('download-result');
    expect(download).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/download',
    );
    expect(download).toHaveAttribute('download');
  });

  it('md: клик открывает модалку и рендерит markdown результата', async () => {
    const fetchMock = stubFetch(makeIssue({ desired_result: 'md' }), () =>
      textResponse('## Итог\nвсё хорошо'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(screen.getByTestId('open-result'));

    const modal = await screen.findByTestId('result-modal');
    const markdown = await within(modal).findByTestId('result-markdown');
    expect(markdown).toHaveTextContent('Итог');
    expect(markdown).toHaveTextContent('всё хорошо');
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/result')),
    ).toBe(true);
  });

  it('md: 404 → «Результат ещё не создан»', async () => {
    stubFetch(makeIssue({ desired_result: 'md' }), () =>
      textResponse('', { ok: false, status: 404 }),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(screen.getByTestId('open-result'));

    expect(
      await screen.findByText('Результат ещё не создан'),
    ).toBeInTheDocument();
  });

  it('desired_result html → iframe с правильным src', async () => {
    stubFetch(makeIssue({ desired_result: 'html' }), () =>
      textResponse('<html></html>'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(screen.getByTestId('open-result'));

    const modal = await screen.findByTestId('result-modal');
    const frame = within(modal).getByTitle('Результат');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', RESULT_URL);
  });

  it('autoOpenResult → модалка открывается сама, без клика (html)', async () => {
    stubFetch(makeIssue({ desired_result: 'html' }), () =>
      textResponse('<html></html>'),
    );

    render(<TaskDetail issueId="issue-1" autoOpenResult />);

    const modal = await screen.findByTestId('result-modal');
    const frame = within(modal).getByTitle('Результат');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', RESULT_URL);
  });

  it('модалку результата можно закрыть', async () => {
    stubFetch(makeIssue({ desired_result: 'md' }), () =>
      textResponse('# Итог'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(screen.getByTestId('open-result'));
    expect(await screen.findByTestId('result-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('result-modal-close'));
    expect(screen.queryByTestId('result-modal')).toBeNull();
  });

  it('desired_result pr → кнопок результата нет', async () => {
    stubFetch(makeIssue({ desired_result: 'pr' }), () =>
      textResponse('# Итог'),
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(screen.queryByTestId('open-result')).toBeNull();
    expect(screen.queryByTestId('download-result')).toBeNull();
  });

  it('desired_result не задан → кнопок результата нет', async () => {
    stubFetch(makeIssue(), () => textResponse('# Итог'));

    render(<TaskDetail issueId="issue-1" />);
    await waitFor(() =>
      expect(screen.getByText('Fix login bug')).toBeInTheDocument(),
    );

    expect(screen.queryByTestId('open-result')).toBeNull();
    expect(screen.queryByTestId('download-result')).toBeNull();
  });
});