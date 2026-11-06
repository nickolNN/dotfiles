import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEscapeKey } from './useEscapeKey';

function keydownCalls(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(([type]) => type === 'keydown');
}

function press(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useEscapeKey', () => {
  it('не подписывается при active: false', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderHook(() => useEscapeKey(false, vi.fn()));

    expect(keydownCalls(addSpy)).toHaveLength(0);
  });

  it('подписывается при active: true и снимает подписку при false', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { rerender } = renderHook(
      ({ active }) => useEscapeKey(active, vi.fn()),
      { initialProps: { active: true } },
    );

    expect(keydownCalls(addSpy)).toHaveLength(1);

    rerender({ active: false });
    expect(keydownCalls(removeSpy)).toHaveLength(1);
  });

  it('снимает подписку при размонтировании', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useEscapeKey(true, vi.fn()));

    expect(keydownCalls(addSpy)).toHaveLength(1);
    unmount();
    expect(keydownCalls(removeSpy)).toHaveLength(1);
  });

  it('Escape зовёт колбэк, остальные клавиши — нет', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(true, onEscape));

    press('Enter');
    expect(onEscape).not.toHaveBeenCalled();

    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('смена инлайн-колбэка не переподписывает листенер и зовёт новый', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useEscapeKey(true, cb),
      { initialProps: { cb: first } },
    );

    expect(keydownCalls(addSpy)).toHaveLength(1);

    rerender({ cb: second });
    expect(keydownCalls(addSpy)).toHaveLength(1);

    press('Escape');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
