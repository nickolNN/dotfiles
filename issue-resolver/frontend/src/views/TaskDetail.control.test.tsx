import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  Issue,
  Iteration,
  SessionControlSnapshot,
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

function makeSnapshot(): SessionControlSnapshot {
  return {
    state: {
      model: 'Claude Sonnet 4',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
      thinkingLevel: 'medium',
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      isStreaming: true,
      sessionName: 'Resolve',
    },
    models: [
      { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
    ],
    thinkingLevels: ['low', 'medium', 'high'],
    commands: [
      {
        name: 'compact',
        description: 'сжать контекст',
        argumentHint: '[инструкции]',
        source: 'extension',
      },
      { name: 'help', description: 'справка', source: 'prompt' },
      {
        name: 'new',
        description: 'новая сессия',
        argumentHint: '[текст]',
        source: 'builtin',
      },
      {
        name: 'thinking',
        description: 'уровень размышления',
        argumentHint: '[off|minimal|low|medium|high|xhigh|max]',
        source: 'builtin',
      },
    ],
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

interface StubOptions {
  snapshot?: SessionControlSnapshot | null;
  stepRun?: Partial<StepRunWithLog>;
  /** Кастомный ответ POST /prompt (по тексту сообщения). */
  promptResponder?: (message: string) => unknown;
}

function stubControlFetch(options: StubOptions = {}) {
  const issue = makeIssue();
  const iteration = makeIteration();
  const stepRun = makeStepRun(options.stepRun);
  const snapshot = options.snapshot === undefined ? makeSnapshot() : options.snapshot;

  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/control') && method === 'GET') {
        return Promise.resolve(
          snapshot === null
            ? jsonResponse(
                { error: 'no active step session' },
                { ok: false, status: 409 },
              )
            : jsonResponse(snapshot),
        );
      }
      if (url.endsWith('/control') && method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true, data: {} }));
      }
      if (url.endsWith('/prompt')) {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as { message?: string })
          : {};
        return Promise.resolve(
          jsonResponse(
            options.promptResponder
              ? options.promptResponder(body.message ?? '')
              : { ok: true, disposition: 'started' },
          ),
        );
      }
      if (url.endsWith('/question-answers')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.endsWith('/step-runs')) {
        return Promise.resolve(jsonResponse([stepRun]));
      }
      if (url.endsWith('/iterations')) {
        return Promise.resolve(jsonResponse([iteration]));
      }
      return Promise.resolve(jsonResponse(issue));
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function postCall(
  fetchMock: ReturnType<typeof vi.fn>,
  suffix: string,
): [string, RequestInit] | undefined {
  return fetchMock.mock.calls.find(
    ([url, init]) =>
      (init as RequestInit | undefined)?.method === 'POST' &&
      String(url).endsWith(suffix),
  ) as [string, RequestInit] | undefined;
}

async function openRunningModal(options: StubOptions = {}) {
  const fetchMock = stubControlFetch(options);
  render(<TaskDetail issueId="issue-1" />);
  await screen.findByText('Fix login bug');
  fireEvent.click(await screen.findByTestId('step-expand'));
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaskDetail — панель управления живой сессией (Phase B)', () => {
  it('рендерит селекторы модели/thinking, режим отправки и кнопки', async () => {
    await openRunningModal();

    expect(await screen.findByTestId('live-controls')).toBeInTheDocument();
    expect(screen.getByTestId('send-mode')).toHaveValue('steer');
    expect(screen.getByTestId('control-model')).toHaveValue(
      'anthropic/claude-sonnet-4',
    );
    expect(screen.getByTestId('control-thinking')).toHaveValue('medium');
    expect(screen.getByTestId('control-compact')).toBeInTheDocument();
    expect(screen.getByTestId('control-clear-queue')).toBeInTheDocument();
    expect(screen.getByTestId('abort-iteration-modal')).toBeInTheDocument();
  });

  it('без живого сеанса (409) панель скрыта, поле ввода остаётся', async () => {
    await openRunningModal({ snapshot: null });

    expect(await screen.findByLabelText('Сообщение')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('live-controls')).toBeNull();
    });
    expect(screen.queryByTestId('send-mode')).toBeNull();
  });

  it('палитра слэш-команд: фильтрует и заполняет команду по клику', async () => {
    await openRunningModal();
    await screen.findByTestId('live-controls');

    const input = screen.getByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: '/' } });

    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('command-option-compact')).toBeInTheDocument();
    expect(screen.getByTestId('command-option-help')).toBeInTheDocument();
    // источник команды виден в палитре (builtin/extension/prompt/skill)
    expect(screen.getByTestId('command-option-new')).toHaveTextContent(
      'builtin',
    );
    // подсказка аргументов видна рядом с опцией
    expect(screen.getByTestId('command-option-compact')).toHaveTextContent(
      '[инструкции]',
    );

    fireEvent.click(screen.getByTestId('command-option-help'));
    expect(input).toHaveValue('/help ');
  });

  it('палитра слэш-команд: Enter заполняет первую подходящую', async () => {
    await openRunningModal();
    await screen.findByTestId('live-controls');

    const input = screen.getByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: '/co' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input).toHaveValue('/compact ');
  });

  it('режим prompt шлёт promptIteration без mode', async () => {
    const fetchMock = await openRunningModal();
    await screen.findByTestId('send-mode');

    fireEvent.change(screen.getByTestId('send-mode'), {
      target: { value: 'prompt' },
    });
    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: 'новая инструкция' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      const call = postCall(fetchMock, '/prompt');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        message: 'новая инструкция',
      });
    });
  });

  it('режим follow-up шлёт mode=followUp, steer — mode=steer', async () => {
    const fetchMock = await openRunningModal();
    await screen.findByTestId('send-mode');

    fireEvent.change(screen.getByTestId('send-mode'), {
      target: { value: 'followUp' },
    });
    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: 'потом' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      const call = postCall(fetchMock, '/prompt');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        message: 'потом',
        mode: 'followUp',
      });
    });
  });

  it('слэш-команда уходит как prompt (без mode) даже в режиме steer', async () => {
    const fetchMock = await openRunningModal();
    await screen.findByTestId('send-mode');

    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: '/compact' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      const call = postCall(fetchMock, '/prompt');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        message: '/compact',
      });
    });
  });

  it('смена модели шлёт set_model(provider, modelId)', async () => {
    const fetchMock = await openRunningModal();
    await screen.findByTestId('control-model');

    fireEvent.change(screen.getByTestId('control-model'), {
      target: { value: 'openai/gpt-5' },
    });

    await waitFor(() => {
      const call = postCall(fetchMock, '/control');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        command: {
          type: 'set_model',
          provider: 'openai',
          modelId: 'gpt-5',
        },
      });
    });
  });

  it('опция «следующая» шлёт cycle_model', async () => {
    const fetchMock = await openRunningModal();
    await screen.findByTestId('control-model');

    fireEvent.change(screen.getByTestId('control-model'), {
      target: { value: '__cycle__' },
    });

    await waitFor(() => {
      const call = postCall(fetchMock, '/control');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        command: { type: 'cycle_model' },
      });
    });
  });

  it('смена thinking-level шлёт set_thinking_level', async () => {
    const fetchMock = await openRunningModal();
    await screen.findByTestId('control-thinking');

    fireEvent.change(screen.getByTestId('control-thinking'), {
      target: { value: 'high' },
    });

    await waitFor(() => {
      const call = postCall(fetchMock, '/control');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        command: { type: 'set_thinking_level', level: 'high' },
      });
    });
  });

  it('«очистить очередь» шлёт clear_queue', async () => {
    const fetchMock = await openRunningModal();
    fireEvent.click(await screen.findByTestId('control-clear-queue'));

    await waitFor(() => {
      const call = postCall(fetchMock, '/control');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        command: { type: 'clear_queue' },
      });
    });
  });

  it('compact: панель инструкций и отправка с инструкциями', async () => {
    const fetchMock = await openRunningModal();
    fireEvent.click(await screen.findByTestId('control-compact'));

    expect(screen.getByTestId('compact-panel')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Инструкции компакции'), {
      target: { value: 'сожми историю' },
    });
    fireEvent.click(screen.getByTestId('compact-run'));

    await waitFor(() => {
      const call = postCall(fetchMock, '/control');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1].body))).toEqual({
        command: {
          type: 'compact',
          instructions: 'сожми историю',
        },
      });
    });
  });

  it('editor_text из событий префилит поле ввода', async () => {
    await openRunningModal({
      stepRun: {
        events: [{ type: 'editor_text', text: 'префилл из расширения' }],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Сообщение')).toHaveValue(
        'префилл из расширения',
      );
    });
  });

  it('ошибка управляющей команды показывается в control-error', async () => {
    const fetchMock = stubControlFetch();
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/control') && method === 'POST') {
          return Promise.resolve(
            jsonResponse({ error: 'no active step session' }, { ok: false, status: 409 }),
          );
        }
        if (url.endsWith('/control')) {
          return Promise.resolve(jsonResponse(makeSnapshot()));
        }
        if (url.endsWith('/question-answers')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.endsWith('/step-runs')) {
          return Promise.resolve(jsonResponse([makeStepRun()]));
        }
        if (url.endsWith('/iterations')) {
          return Promise.resolve(jsonResponse([makeIteration()]));
        }
        return Promise.resolve(jsonResponse(makeIssue()));
      },
    );

    render(<TaskDetail issueId="issue-1" />);
    await screen.findByText('Fix login bug');
    fireEvent.click(await screen.findByTestId('step-expand'));
    fireEvent.click(await screen.findByTestId('control-clear-queue'));

    expect(await screen.findByTestId('control-error')).toHaveTextContent(
      'no active step session',
    );
  });

  it('палитра: ArrowDown перемещает выбор, Enter заполняет выбранную', async () => {
    await openRunningModal();
    await screen.findByTestId('live-controls');

    const input = screen.getByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: '/' } });

    expect(screen.getByTestId('command-option-compact')).toHaveAttribute(
      'data-active',
      'true',
    );

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('command-option-help')).toHaveAttribute(
      'data-active',
      'true',
    );

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/help ');
  });

  it('палитра: builtin-команда видна и клик по ней заполняет ввод', async () => {
    await openRunningModal();
    await screen.findByTestId('live-controls');

    const input = screen.getByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: '/new' } });

    const option = screen.getByTestId('command-option-new');
    expect(option).toHaveTextContent('builtin');
    expect(option).toHaveTextContent('[текст]');

    fireEvent.click(option);
    expect(input).toHaveValue('/new ');
    // подсказка аргументов показана под полем после заполнения
    expect(screen.getByTestId('command-hint')).toHaveTextContent('/new [текст]');
  });

  it('queue recall возвращает текст в композер (append к черновику)', async () => {
    await openRunningModal({
      stepRun: {
        events: [{ type: 'queue', steering: ['стоп'], followUp: [] }],
      },
    });

    const input = await screen.findByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: 'мой черновик' } });
    fireEvent.click(await screen.findByTestId('queue-recall-steer-0'));

    expect(input).toHaveValue('мой черновик стоп');
  });

  it('handled-failed builtin: показывает серверную ошибку и сохраняет черновик', async () => {
    await openRunningModal({
      promptResponder: () => ({
        ok: false,
        disposition: 'handled',
        error: 'Неизвестный уровень размышления: bogus',
      }),
    });
    await screen.findByTestId('live-controls');

    const input = screen.getByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: '/thinking bogus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByTestId('message-error')).toHaveTextContent(
      'Неизвестный уровень размышления',
    );
    // черновик НЕ очищен
    expect(input).toHaveValue('/thinking bogus');
  });

  it('noop handled /help: чистит черновик без ошибки', async () => {
    await openRunningModal({
      promptResponder: () => ({ ok: true, disposition: 'handled' }),
    });
    await screen.findByTestId('live-controls');

    const input = screen.getByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: '/help' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(input).toHaveValue('');
    });
    expect(screen.queryByTestId('message-error')).toBeNull();
  });
});