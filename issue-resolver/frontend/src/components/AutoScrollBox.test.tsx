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

describe('AutoScrollBox — кнопка «вниз» и пиннинг ко дну', () => {
  it('рендерит плавающую кнопку с testid, aria-label и стартовым «pinned»', () => {
    render(<AutoScrollBox scrollKey={0}>вывод</AutoScrollBox>);

    const button = screen.getByTestId('scroll-to-bottom');
    expect(button).toHaveAttribute('aria-label');
    expect(button).toHaveAttribute('data-pinned', 'true');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('пока у дна — новые события авто-скроллят вниз', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });
    el.scrollTop = 477; // ровно у дна
    fireEvent.scroll(el);

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    expect(el.scrollTop).toBe(777);
  });

  it('скролл вверх ставит авто-следование на паузу', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });

    el.scrollTop = 0; // пользователь отмотал наверх
    fireEvent.scroll(el);

    const button = screen.getByTestId('scroll-to-bottom');
    expect(button).toHaveAttribute('data-pinned', 'false');

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    // Авто-скролл не «дёргает» пользователя обратно ко дну.
    expect(el.scrollTop).toBe(0);
  });

  it('клик по кнопке форсит пиннинг и мгновенный прыжок ко дну (behavior: auto)', () => {
    render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });
    const scrollTo = vi.fn();
    (el as unknown as { scrollTo: (options: ScrollToOptions) => void }).scrollTo =
      scrollTo;

    el.scrollTop = 0;
    fireEvent.scroll(el);
    expect(screen.getByTestId('scroll-to-bottom')).toHaveAttribute(
      'data-pinned',
      'false',
    );

    fireEvent.click(screen.getByTestId('scroll-to-bottom'));

    expect(scrollTo).toHaveBeenCalledWith({ top: 777, behavior: 'auto' });
    expect(el.scrollTop).toBe(777);
    expect(screen.getByTestId('scroll-to-bottom')).toHaveAttribute(
      'data-pinned',
      'true',
    );
  });

  it('после клика авто-следование снова работает', () => {
    const { rerender } = render(<AutoScrollBox scrollKey={0}>x</AutoScrollBox>);
    const el = scrollEl();
    setLayout(el, { scrollHeight: 777, clientHeight: 300 });

    el.scrollTop = 0;
    fireEvent.scroll(el); // отмотано — пауза
    fireEvent.click(screen.getByTestId('scroll-to-bottom')); // форсим пиннинг

    rerender(<AutoScrollBox scrollKey={1}>x</AutoScrollBox>);

    expect(el.scrollTop).toBe(777);
  });
});