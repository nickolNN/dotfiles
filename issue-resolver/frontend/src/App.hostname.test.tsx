import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from './App';

/** Фейк EventSource: App подписывается на глобальные SSE-потоки. */
class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}
}

/**
 * Заголовок вкладки = hostname инстанса (значение из `/settings/hostname`) и
 * не сбрасывается на статичный `Issue Resolver` из index.html при перезагрузке
 * любой страницы.
 */
function stubFetch(hostname: string) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/settings/hostname')) {
      return Promise.resolve({ ok: true, json: async () => ({ hostname }) });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.title = '';
  window.history.replaceState(null, '', '/');
});

describe('App hostname → заголовок вкладки', () => {
  it('подставляет сохранённый hostname в заголовок при загрузке', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetch('Home Mac');

    render(<App />);

    await waitFor(() => expect(document.title).toBe('Home Mac'));
  });

  it('без сохранённого hostname оставляет дефолтный заголовок', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetch('');

    render(<App />);

    await waitFor(() => expect(document.title).toBe('Issue Resolver'));
  });

  it('обновляет заголовок после сохранения в настройках', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    window.history.replaceState(null, '', '/#/settings');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/settings/hostname')) {
        const value = init?.method === 'PUT' ? 'New Host' : 'Old Host';
        return Promise.resolve({ ok: true, json: async () => ({ hostname: value }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const input = await screen.findByTestId('settings-hostname-input');
    await waitFor(() => expect(input).toHaveValue('Old Host'));

    fireEvent.change(input, { target: { value: 'New Host' } });
    fireEvent.click(screen.getByTestId('settings-save'));

    await waitFor(() => expect(document.title).toBe('New Host'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/issue-resolver/api/v1/settings/hostname',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});