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

  it('live ON (у дна) — новые события авто-скроллят вниз', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    // scrollHeight=777, clientHeight=300, scrollTop=477 → 0px от дна (у дна)
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });
    el.scrollTop = 477;

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    expect(el.scrollTop).toBe(777);
  });

  it('пользователь отмотал вверх → авто-pause live, новые события НЕ скроллят', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });
    el.scrollTop = 0; // пользователь наверху

    fireEvent.scroll(el);

    // Кнопка перешла в OFF (авто-pause).
    const offButton = screen.getByTestId('scroll-to-bottom');
    expect(offButton).toHaveAttribute('data-live', 'false');
    expect(offButton).toHaveTextContent('▼ live');
    expect(offButton.className).toContain('text-[#00FF41]/40');

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    // Позиция не изменилась — авто-скролл на паузе.
    expect(el.scrollTop).toBe(0);
  });

  it('пользователь докрутил до дна → авто-resume live', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });
    el.scrollTop = 0;
    fireEvent.scroll(el); // авто-pause
    expect(screen.getByTestId('scroll-to-bottom')).toHaveAttribute(
      'data-live',
      'false',
    );

    // Докрутили до дна.
    el.scrollTop = 477; // 777 - 477 - 300 = 0 → у дна
    fireEvent.scroll(el);

    const onButton = screen.getByTestId('scroll-to-bottom');
    expect(onButton).toHaveAttribute('data-live', 'true');
    expect(onButton).toHaveTextContent('● live');

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    // Авто-скролл снова работает.
    expect(el.scrollTop).toBe(777);
  });

  it('клик по кнопке (OFF) — скролл вниз + включение live', () => {
    render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });
    const scrollTo = vi.fn();
    (el as unknown as { scrollTo: (options: ScrollToOptions) => void }).scrollTo =
      scrollTo;

    // Сначала авто-pause: отмотали вверх.
    el.scrollTop = 100;
    fireEvent.scroll(el);
    expect(screen.getByTestId('scroll-to-bottom')).toHaveAttribute(
      'data-live',
      'false',
    );

    // Клик: скролл вниз + live ON.
    fireEvent.click(screen.getByTestId('scroll-to-bottom'));
    const onButton = screen.getByTestId('scroll-to-bottom');
    expect(onButton).toHaveAttribute('data-live', 'true');
    expect(onButton).toHaveTextContent('● live');
    expect(onButton.className).toContain(
      'shadow-[0_0_8px_rgba(0,255,65,0.5)]',
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 777, behavior: 'auto' });
    expect(el.scrollTop).toBe(777);
  });
});