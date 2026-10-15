import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AutoScrollBox from './AutoScrollBox';

/** Скролл-контейнер — сосед кнопки внутри relative-обёртки. */
function scrollEl(): HTMLElement {
  const button = screen.getByTestId('scroll-to-bottom');
  return button.previousElementSibling as HTMLElement;
}

/** jsdom не считает layout — задаём размеры руками. */
function setLayout(
  el: HTMLElement,
  { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AutoScrollBox — кнопка live и авто-прокрутка', () => {
  it('рендерит плавающую кнопку с testid, aria-label и стартовым live=ON', () => {
    render(<AutoScrollBox scrollKey={0}>вывод</AutoScrollBox>);

    const button = screen.getByTestId('scroll-to-bottom');
    expect(button).toHaveAttribute('aria-label');
    expect(button).toHaveAttribute('data-live', 'true');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('● live');
    // ON = яркая (активный режим)
    expect(button.className).toContain('shadow-[0_0_8px_rgba(0,255,65,0.5)]');
  });

  it('live ON — новые события авто-скроллят вниз', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    expect(el.scrollTop).toBe(777);
  });

  it('live ON — скролл пользователя не выключает авто-следование (жёсткий режим)', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });

    el.scrollTop = 0; // пользователь отмотал наверх
    fireEvent.scroll(el);

    // Кнопка всё ещё показывает live (ON) — прокрутка пользователя
    // не снимает режим.
    const button = screen.getByTestId('scroll-to-bottom');
    expect(button).toHaveAttribute('data-live', 'true');

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    // Авто-скролл всё равно утащит ко дну — live ON.
    expect(el.scrollTop).toBe(777);
  });

  it('клик по кнопке: ON → OFF (без скролла), OFF → ON (скролл ко дну)', () => {
    render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });
    const scrollTo = vi.fn();
    (el as unknown as { scrollTo: (options: ScrollToOptions) => void }).scrollTo =
      scrollTo;

    // Шаг 1: ON → OFF — скролл НЕ дёргается, кнопка становится приглушённой.
    fireEvent.click(screen.getByTestId('scroll-to-bottom'));
    const offButton = screen.getByTestId('scroll-to-bottom');
    expect(offButton).toHaveAttribute('data-live', 'false');
    expect(offButton).toHaveTextContent('● live');
    // OFF = приглушённая
    expect(offButton.className).toContain('text-[#00FF41]/40');
    // scrollTo не вызывался при выключении.
    expect(scrollTo).not.toHaveBeenCalled();

    // Шаг 2: OFF → ON — скролл ко дну, кнопка яркая.
    fireEvent.click(screen.getByTestId('scroll-to-bottom'));
    const onButton = screen.getByTestId('scroll-to-bottom');
    expect(onButton).toHaveAttribute('data-live', 'true');
    expect(onButton).toHaveTextContent('● live');
    expect(onButton.className).toContain('shadow-[0_0_8px_rgba(0,255,65,0.5)]');
    expect(scrollTo).toHaveBeenCalledWith({ top: 777, behavior: 'auto' });
    expect(el.scrollTop).toBe(777);
  });

  it('live OFF — новые события НЕ авто-скроллят', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });

    // Выключаем live.
    fireEvent.click(screen.getByTestId('scroll-to-bottom'));

    el.scrollTop = 100;
    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    // Позиция не изменилась — live OFF.
    expect(el.scrollTop).toBe(100);
  });
});