import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestJson,
  requestJsonOrNull,
  requestVoid,
  send,
  withQuery,
} from './http';

function response(
  body: unknown,
  init: { ok?: boolean; status?: number; bodyBroken?: boolean } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      if (init.bodyBroken) throw new SyntaxError('bad json');
      return body;
    },
    text: async () => (init.bodyBroken ? '' : String(body)),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('http — withQuery', () => {
  it('кодирует пробел как %20, а не +', () => {
    expect(withQuery('/x', { q: 'a b' })).toBe('/x?q=a%20b');
    expect(withQuery('/x', { q: 'a b' })).not.toContain('+');
  });

  it('кодирует слэши в path как %2F', () => {
    expect(withQuery('/result/files/content', { path: 'shots/cat.png' })).toBe(
      '/result/files/content?path=shots%2Fcat.png',
    );
  });

  it('добавляет параметры к URL с уже имеющейся строкой запроса', () => {
    expect(withQuery('/x?fixed=1', { a: 'b' })).toBe('/x?fixed=1&a=b');
  });

  it('не меняет URL при пустом объекте и отбрасывает пустые значения', () => {
    expect(withQuery('/x', {})).toBe('/x');
    expect(withQuery('/x', { a: undefined, b: null, c: '' })).toBe('/x');
  });
});

describe('http — ошибки', () => {
  it('requestJson бросает сообщение из тела ошибки', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response({ error: 'boom' }, { ok: false, status: 500 }))),
    );

    await expect(requestJson('/x')).rejects.toThrow('boom');
  });

  it('requestJson на битом теле бросает статусное сообщение', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(null, { ok: false, status: 502, bodyBroken: true }),
        ),
      ),
    );

    await expect(requestJson('/x')).rejects.toThrow(
      'Запрос завершился со статусом 502',
    );
  });

  it('requestJsonOrNull: 404 → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response({}, { ok: false, status: 404 }))),
    );

    await expect(requestJsonOrNull('/x')).resolves.toBeNull();
  });

  it('requestJsonOrNull: 500 → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(response({ error: 'server down' }, { ok: false, status: 500 })),
      ),
    );

    await expect(requestJsonOrNull('/x')).resolves.toBeNull();
  });

  it('requestJsonOrNull: сетевая ошибка → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );

    await expect(requestJsonOrNull('/x')).resolves.toBeNull();
  });
});

describe('http — send', () => {
  it('requestVoid не парсит тело успешного ответа', async () => {
    const json = vi.fn();
    const text = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 204, json, text } as unknown as Response)),
    );

    await expect(requestVoid('/x', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('не дублирует Content-Type, если заголовок уже передан', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(response({})),
    );
    vi.stubGlobal('fetch', fetchMock);

    await send('/x', {
      json: { a: 1 },
      headers: { 'Content-Type': 'application/vnd.api+json', 'X-Test': '1' },
    });

    const init = fetchMock.mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/vnd.api+json');
    expect(headers.get('X-Test')).toBe('1');
  });

  it('ставит Content-Type один раз для json без явных заголовков', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(response({})),
    );
    vi.stubGlobal('fetch', fetchMock);

    await send('/x', { json: { a: 1 } });

    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });
});
