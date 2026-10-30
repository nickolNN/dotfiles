import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { RetroRun, RetroRunWithLog } from '@issue-resolver/shared';
import Settings from './Settings';

const NOW = '2026-10-30T07:00:00.000Z';

function retroRun(overrides: Partial<RetroRun> = {}): RetroRun {
  return {
    id: 'run-1',
    status: 'success',
    model: 'qwen-test',
    instructions: null,
    session_limit: null,
    thinking_level: null,
    report: null,
    error: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function retroRunWithLog(
  overrides: Partial<RetroRunWithLog> = {},
): RetroRunWithLog {
  return {
    ...retroRun(),
    stdout: '',
    stderr: '',
    events: [],
    stats: null,
    ...overrides,
  };
}

const jsonOk = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

interface StubOptions {
  runs?: RetroRun[];
  created?: RetroRun;
  detail?: RetroRunWithLog;
}

function stubApi(options: StubOptions = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/settings/hostname')) return jsonOk({ hostname: '' });
    if (url.endsWith('/models')) {
      return jsonOk([
        {
          id: 'qwen-test',
          name: 'Qwen Test',
          thinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
        },
        {
          id: 'other-model',
          name: 'Other',
          thinkingLevels: ['off', 'low', 'medium', 'high'],
        },
      ]);
    }
    if (url.endsWith('/settings/retro') && method === 'POST') {
      return jsonOk(options.created ?? retroRun({ status: 'running' }));
    }
    if (/\/settings\/retro\/[^/]+\/abort$/.test(url)) {
      return jsonOk({ ok: true });
    }
    if (url.endsWith('/settings/retro')) {
      return jsonOk({ runs: options.runs ?? [] });
    }
    if (/\/settings\/retro\/[^/]+$/.test(url)) {
      return jsonOk(options.detail ?? retroRunWithLog());
    }
    return jsonOk({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderSettings() {
  return render(<Settings hostname="" onHostnameChange={() => {}} />);
}

describe('Settings — память и ретро', () => {
  it('кнопка открывает модалку с моделью, числом сессий и полем инструкций', async () => {
    stubApi();
    renderSettings();

    fireEvent.click(screen.getByTestId('settings-retro-open'));

    expect(await screen.findByTestId('retro-modal')).toBeInTheDocument();
    expect(screen.getByTestId('retro-model')).toBeInTheDocument();
    expect(screen.getByTestId('retro-sessions')).toHaveValue(10);
    expect(screen.getByTestId('retro-instructions')).toBeInTheDocument();
    expect(await screen.findByText('Qwen Test')).toBeInTheDocument();
  });

  it('запуск отправляет модель, лимит сессий и инструкции в запрос', async () => {
    const fetchMock = stubApi();
    renderSettings();

    fireEvent.click(screen.getByTestId('settings-retro-open'));
    fireEvent.change(await screen.findByTestId('retro-model'), {
      target: { value: 'qwen-test' },
    });
    fireEvent.change(await screen.findByTestId('retro-thinking'), {
      target: { value: 'high' },
    });
    fireEvent.change(screen.getByTestId('retro-sessions'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByTestId('retro-instructions'), {
      target: { value: 'посмотри на миграции' },
    });
    fireEvent.click(screen.getByTestId('retro-start'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/settings/retro') && init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        model: 'qwen-test',
        thinking_level: 'high',
        session_limit: 3,
        instructions: 'посмотри на миграции',
      });
    });
    expect(await screen.findByTestId('retro-status')).toHaveTextContent('идёт');
  });

  it('пустые поля не уходят в запрос', async () => {
    const fetchMock = stubApi();
    renderSettings();

    fireEvent.click(screen.getByTestId('settings-retro-open'));
    await screen.findByTestId('retro-model');
    fireEvent.change(screen.getByTestId('retro-sessions'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('retro-start'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/settings/retro') && init?.method === 'POST',
      );
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({});
    });
  });

  it('история: клик по прогону показывает markdown-отчёт', async () => {
    stubApi({
      runs: [retroRun({ id: 'old-run' })],
      detail: retroRunWithLog({
        id: 'old-run',
        report: '## Память\n\nСлито 3 записи.',
      }),
    });
    renderSettings();

    fireEvent.click(screen.getByTestId('settings-retro-open'));
    const history = await screen.findByTestId('retro-history');
    fireEvent.click(history.querySelector('button') as HTMLButtonElement);

    expect(await screen.findByTestId('retro-report')).toBeInTheDocument();
    expect(screen.getByText('Слито 3 записи.')).toBeInTheDocument();
    expect(screen.getByTestId('retro-download')).toBeInTheDocument();
  });

  it('«Остановить» шлёт abort и показывает причину из прогона', async () => {
    const fetchMock = stubApi({
      created: retroRun({ status: 'running' }),
      detail: retroRunWithLog({
        status: 'failed',
        error: 'прогон остановлен оператором',
      }),
    });
    renderSettings();

    fireEvent.click(screen.getByTestId('settings-retro-open'));
    fireEvent.click(await screen.findByTestId('retro-start'));
    fireEvent.click(await screen.findByTestId('retro-abort'));

    await waitFor(() => {
      const abort = fetchMock.mock.calls.find(
        ([url, init]) =>
          /\/settings\/retro\/[^/]+\/abort$/.test(String(url)) &&
          init?.method === 'POST',
      );
      expect(abort).toBeTruthy();
    });
    expect(await screen.findByTestId('retro-run-error')).toHaveTextContent(
      'остановлен оператором',
    );
  });

  it('клик по прогону в истории подставляет его параметры в форму', async () => {
    stubApi({
      runs: [retroRun({ id: 'old-run' })],
      detail: retroRunWithLog({
        id: 'old-run',
        model: 'other-model',
        thinking_level: 'low',
        session_limit: 5,
        instructions: 'посмотри на миграции',
      }),
    });
    renderSettings();

    fireEvent.click(screen.getByTestId('settings-retro-open'));
    const history = await screen.findByTestId('retro-history');
    fireEvent.click(history.querySelector('button') as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByTestId('retro-model')).toHaveValue('other-model');
    });
    expect(screen.getByTestId('retro-sessions')).toHaveValue(5);
    expect(screen.getByTestId('retro-thinking')).toHaveValue('low');
    expect(screen.getByTestId('retro-thinking')).not.toBeDisabled();
    expect(screen.getByTestId('retro-instructions')).toHaveValue(
      'посмотри на миграции',
    );
    expect(screen.getByTestId('retro-run-params')).toHaveTextContent('5 сессий');
  });
});