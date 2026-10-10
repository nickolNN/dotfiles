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
import type {
  Issue,
  Iteration,
  SessionQuestion,
  StepRunWithLog,
} from '@issue-resolver/shared';
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
    status: 'running',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function question(overrides: Partial<SessionQuestion> = {}): SessionQuestion {
  return {
    id: 'q-1',
    method: 'select',
    title: 'Какой подход выбрать?',
    options: ['вариант-a', 'вариант-b'],
    ...overrides,
  };
}

function makeStepRun(
  overrides: Partial<StepRunWithLog> = {},
): StepRunWithLog {
  return {
    id: 'run-1',
    iteration_id: 'iter-1',
    step: 'resolve',
    attempt: 1,
    status: 'running',
    context: '',
    feedback: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    stdout: '',
    stderr: '',
    events: [],
    stats: null,
    report: null,
    screenshots_dir: null,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

/** Различает GET (issue/iterations/step-runs) и POST ui-response. */
function stubFetch(
  uiResponse: () => Promise<Response> = () =>
    Promise.resolve(jsonResponse({ ok: true })),
  stepRuns: StepRunWithLog[] = [makeStepRun()],
  iterationOverrides: Partial<Iteration> = {},
  answeredIds: string[] = [],
) {
  const issue = makeIssue();
  const iteration = makeIteration(iterationOverrides);

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/ui-response')) {
      return uiResponse();
    }
    if (url.endsWith('/question-answers')) {
      return Promise.resolve(jsonResponse({ answered_ids: answeredIds }));
    }
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse(stepRuns));
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Минимальный фейк EventSource: ручная доставка onmessage. */
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

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — интерактивная модалка вопроса', () => {
  it('pending select-вопрос: модалка с radio по options', async () => {
    stubFetch(undefined, [
      makeStepRun({
        events: [{ type: 'question', ...question() }],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    expect(
      within(modal).getByTestId('question-prompt'),
    ).toHaveTextContent('Какой подход выбрать?');
    expect(within(modal).getByRole('radio', { name: 'вариант-a' })).toBeChecked();
    expect(
      within(modal).getByRole('radio', { name: 'вариант-b' }),
    ).not.toBeChecked();
  });

  it('pending input-вопрос: модалка с текстовым полем', async () => {
    stubFetch(undefined, [
      makeStepRun({
        events: [
          {
            type: 'question',
            ...question({
              id: 'q-input',
              method: 'input',
              title: 'Имя ветки?',
              options: undefined,
              placeholder: 'feature/...',
            }),
          },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    const field = within(modal).getByLabelText('Ответ');
    expect(field).toHaveAttribute('placeholder', 'feature/...');
    // Пустое значение — «Ответить» заблокировано.
    expect(within(modal).getByRole('button', { name: 'Ответить' })).toBeDisabled();

    fireEvent.change(field, { target: { value: 'feature/login' } });
    expect(within(modal).getByRole('button', { name: 'Ответить' })).toBeEnabled();
  });

  it('live-вопрос приходит по SSE и открывает модалку', async () => {
    stubFetch(undefined, [makeStepRun({ events: [] })]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emit({
        type: 'step_event',
        issueId: 'issue-1',
        stepRunId: 'run-1',
        data: JSON.stringify({
          stepRunId: 'run-1',
          event: { type: 'question', ...question({ id: 'q-live' }) },
        }),
        ts: '2026-10-09T00:00:00.000Z',
      });
    });

    expect(await screen.findByTestId('question-modal')).toBeInTheDocument();
  });

  it('submit: POST /iterations/iter-1/ui-response с выбранным value', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({ events: [{ type: 'question', ...question() }] }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    fireEvent.click(within(modal).getByRole('radio', { name: 'вариант-b' }));
    fireEvent.click(within(modal).getByRole('button', { name: 'Ответить' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/ui-response'),
      );
      expect(call).toBeTruthy();
      const [url, init] = call!;
      expect(String(url).endsWith('/iterations/iter-1/ui-response')).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({
        id: 'q-1',
        value: 'вариант-b',
      });
    });
  });

  it('confirm: кнопка «Да» шлёт confirmed:true', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({
        events: [
          {
            type: 'question',
            ...question({
              id: 'q-confirm',
              method: 'confirm',
              title: 'Продолжать?',
              options: undefined,
            }),
          },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    expect(within(modal).getByRole('button', { name: 'Да' })).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Да' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/ui-response'),
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        id: 'q-confirm',
        confirmed: true,
      });
    });
  });

  it('cancel: «Отмена» шлёт cancelled:true', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({ events: [{ type: 'question', ...question() }] }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    fireEvent.click(within(modal).getByTestId('question-cancel'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/ui-response'),
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        id: 'q-1',
        cancelled: true,
      });
    });
  });

  it('отвеченный id не показывается снова — открывается следующий вопрос', async () => {
    stubFetch(undefined, [
      makeStepRun({
        events: [
          { type: 'question', ...question({ id: 'q-1', title: 'Первый?' }) },
          { type: 'question', ...question({ id: 'q-2', title: 'Второй?' }) },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(
      within(await screen.findByTestId('question-modal')).getByTestId(
        'question-prompt',
      ),
    ).toHaveTextContent('Первый?');

    fireEvent.click(
      within(screen.getByTestId('question-modal')).getByRole('button', {
        name: 'Ответить',
      }),
    );

    // Первый гасится, но на очереди второй — модалка не исчезает, а меняет вопрос.
    await waitFor(() => {
      const modal = screen.getByTestId('question-modal');
      expect(within(modal).getByTestId('question-prompt')).toHaveTextContent(
        'Второй?',
      );
      expect(within(modal).getByTestId('question-prompt')).not.toHaveTextContent(
        'Первый?',
      );
    });
  });

  it('шаг pending, итерация running: модалка открыта и radio кликабелен', async () => {
    stubFetch(
      undefined,
      [
        makeStepRun({
          status: 'pending',
          events: [{ type: 'question', ...question() }],
        }),
      ],
      { status: 'running' },
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    const optionB = within(modal).getByRole('radio', { name: 'вариант-b' });
    expect(optionB).not.toBeChecked();

    fireEvent.click(optionB);
    expect(optionB).toBeChecked();
    expect(
      within(modal).getByRole('radio', { name: 'вариант-a' }),
    ).not.toBeChecked();
  });

  it('завершённая итерация: персистентный вопрос не всплывает', async () => {
    stubFetch(
      undefined,
      [
        makeStepRun({
          status: 'success',
          events: [{ type: 'question', ...question() }],
        }),
      ],
      { status: 'completed' },
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    // Завершённый шаг показывает саммари/заглушку, а не живой вывод.
    await screen.findByText('Результат отсутствует.');

    expect(screen.queryByTestId('question-modal')).toBeNull();
  });

  it('серверный ответ гасит модалку после перезагрузки (итерация running)', async () => {
    const fetchMock = stubFetch(
      undefined,
      [
        makeStepRun({
          status: 'running',
          events: [{ type: 'question', ...question({ id: 'q-1' }) }],
        }),
      ],
      { status: 'running' },
      ['q-1'],
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    // Дожидаемся, что серверные ответы реально запрошены и применены.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith('/question-answers'),
        ),
      ).toBe(true);
    });
    await screen.findAllByTestId('step-run-log');

    expect(screen.queryByTestId('question-modal')).toBeNull();
  });

  it('неотвеченный вопрос завершённого шага не открывает модалку (итерация running)', async () => {
    stubFetch(
      undefined,
      [
        makeStepRun({
          status: 'success',
          events: [{ type: 'question', ...question({ id: 'q-done' }) }],
        }),
      ],
      { status: 'running' },
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    await screen.findAllByTestId('step-run-log');

    expect(screen.queryByTestId('question-modal')).toBeNull();
  });

  it('неотвеченный вопрос активного шага открывает модалку (итерация running)', async () => {
    stubFetch(
      undefined,
      [
        makeStepRun({
          status: 'running',
          events: [{ type: 'question', ...question({ id: 'q-active' }) }],
        }),
      ],
      { status: 'running' },
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    expect(await screen.findByTestId('question-modal')).toBeInTheDocument();
  });

  it('ошибка отправки: показывает text-[#FF0033] баннер', async () => {
    stubFetch(
      () =>
        Promise.resolve(
          jsonResponse(
            { error: 'no active step session' },
            { ok: false, status: 409 },
          ),
        ),
      [makeStepRun({ events: [{ type: 'question', ...question() }] })],
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    fireEvent.click(
      within(await screen.findByTestId('question-modal')).getByRole('button', {
        name: 'Ответить',
      }),
    );

    const banner = await screen.findByTestId('question-error');
    expect(banner).toHaveTextContent('no active step session');
    expect(banner.className).toContain('text-[#FF0033]');
  });

  it('input: автофокус, каретка в конец и Enter отправляет значение', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({
        events: [
          {
            type: 'question',
            ...question({
              id: 'q-input',
              method: 'input',
              title: 'Имя ветки?',
              options: undefined,
              prefill: 'feature/',
            }),
          },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const input = (await screen.findByLabelText('Ответ')) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    // Префилл не оставляет каретку в позиции 0.
    expect(input.value).toBe('feature/');
    expect(input.selectionStart).toBe(input.value.length);

    fireEvent.change(input, { target: { value: 'feature/login' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/ui-response'),
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        id: 'q-input',
        value: 'feature/login',
      });
    });
  });

  it('input: Enter на пустом значении не отправляет', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({
        events: [
          {
            type: 'question',
            ...question({
              id: 'q-input-empty',
              method: 'input',
              title: 'Имя ветки?',
              options: undefined,
            }),
          },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const input = (await screen.findByLabelText('Ответ')) as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'Enter' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('editor: Ctrl+Enter отправляет, обычный Enter — нет', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({
        events: [
          {
            type: 'question',
            ...question({
              id: 'q-editor',
              method: 'editor',
              title: 'Опиши изменения',
              options: undefined,
            }),
          },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const textarea = (await screen.findByLabelText(
      'Ответ',
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(textarea));

    fireEvent.change(textarea, { target: { value: 'первая строка' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false);

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/ui-response'),
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        id: 'q-editor',
        value: 'первая строка',
      });
    });
  });

  it('select: radio в фокусе на маунте, Enter отправляет первый вариант', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({
        events: [
          { type: 'question', ...question({ id: 'q-select-enter' }) },
        ],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    const first = within(modal).getByRole('radio', { name: 'вариант-a' });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(first, { key: 'Enter' });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/ui-response'),
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        id: 'q-select-enter',
        value: 'вариант-a',
      });
    });
  });

  it('Escape отменяет модалку (cancelled:true)', async () => {
    const fetchMock = stubFetch(undefined, [
      makeStepRun({
        events: [{ type: 'question', ...question({ id: 'q-escape' }) }],
      }),
    ]);

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');

    const modal = await screen.findByTestId('question-modal');
    fireEvent.keyDown(modal, { key: 'Escape' });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/ui-response'),
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        id: 'q-escape',
        cancelled: true,
      });
    });
  });
});