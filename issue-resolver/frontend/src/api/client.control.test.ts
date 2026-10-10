import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionControlSnapshot } from '@issue-resolver/shared';
import {
  getIterationControl,
  promptIteration,
  sendIterationCommand,
} from './client';

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
    ],
    thinkingLevels: ['low', 'medium', 'high'],
    commands: [{ name: 'compact', description: 'сжать', source: 'extension' }],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api/client — управление живой pi-сессией', () => {
  it('promptIteration: POST /prompt с message+mode и disposition', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ ok: true, disposition: 'queued' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await promptIteration('iter-1', 'привет', 'steer');

    expect(result).toEqual({ ok: true, disposition: 'queued' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/issue-resolver/api/v1/iterations/iter-1/prompt');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      message: 'привет',
      mode: 'steer',
    });
  });

  it('promptIteration: без mode тело содержит только message', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ ok: true, disposition: 'started' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await promptIteration('iter-1', 'новая инструкция');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ message: 'новая инструкция' });
  });

  it('promptIteration: HTTP 200 ok:false + error пробрасываются (handled-failed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            ok: false,
            disposition: 'handled',
            error: 'Неизвестный уровень размышления: bogus',
          }),
        ),
      ),
    );

    const result = await promptIteration('iter-1', '/thinking bogus');
    expect(result).toEqual({
      ok: false,
      disposition: 'handled',
      error: 'Неизвестный уровень размышления: bogus',
    });
  });

  it('promptIteration: noop handled (ok:true) без error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ ok: true, disposition: 'handled' })),
      ),
    );

    const result = await promptIteration('iter-1', '/help');
    expect(result).toEqual({ ok: true, disposition: 'handled' });
  });

  it('promptIteration: не-2xx → {ok:false}, без исключения', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: 'no active step session' }, { ok: false, status: 409 })),
      ),
    );

    const result = await promptIteration('iter-1', 'hi', 'steer');
    expect(result.ok).toBe(false);
  });

  it('promptIteration: сетевой сбой → {ok:false}', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))));
    await expect(promptIteration('iter-1', 'hi')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('getIterationControl: 200 со снимком', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(makeSnapshot()))));

    const snapshot = await getIterationControl('iter-1');
    expect(snapshot?.state.model).toBe('Claude Sonnet 4');
    expect(snapshot?.commands).toHaveLength(1);
  });

  it('getIterationControl: 409 → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: 'no session' }, { ok: false, status: 409 }))),
    );
    expect(await getIterationControl('iter-1')).toBeNull();
  });

  it('getIterationControl: мусорная форма → null', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ nope: true }))));
    expect(await getIterationControl('iter-1')).toBeNull();
  });

  it('sendIterationCommand: POST /control с командой и распаковкой ответа', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ ok: true, data: { level: 'high' } })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendIterationCommand('iter-1', {
      type: 'set_thinking_level',
      level: 'high',
    });

    expect(result).toEqual({ ok: true, data: { level: 'high' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/issue-resolver/api/v1/iterations/iter-1/control');
    expect(JSON.parse(String(init?.body))).toEqual({
      command: { type: 'set_thinking_level', level: 'high' },
    });
  });

  it('sendIterationCommand: не-2xx → {ok:false, error}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: 'no active step session' }, { ok: false, status: 409 })),
      ),
    );

    const result = await sendIterationCommand('iter-1', { type: 'clear_queue' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no active step session');
  });

  it('sendIterationCommand: сетевой сбой → {ok:false}', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const result = await sendIterationCommand('iter-1', { type: 'clear_queue' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('offline');
  });
});