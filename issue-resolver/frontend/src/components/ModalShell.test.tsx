import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ModalShell from './ModalShell';

afterEach(() => {
  cleanup();
});

function pressEscape(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

describe('ModalShell', () => {
  it('закрывается по Escape', () => {
    const onClose = vi.fn();
    render(
      <ModalShell onClose={onClose} title="Заголовок">
        тело
      </ModalShell>,
    );

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('закрывается по клику на оверлей, но не по клику внутри карточки', () => {
    const onClose = vi.fn();
    render(
      <ModalShell
        onClose={onClose}
        overlayTestId="shell-overlay"
        title="Заголовок"
      >
        тело
      </ModalShell>,
    );

    fireEvent.click(screen.getByText('тело'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('shell-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('держит слой z-50 и одну кнопку закрытия', () => {
    const onClose = vi.fn();
    render(
      <ModalShell
        onClose={onClose}
        overlayTestId="shell-overlay"
        cardTestId="shell-card"
        closeTestId="shell-close"
        dialogLabel="Заголовок"
        title={<h3>Заголовок</h3>}
      >
        тело
      </ModalShell>,
    );

    expect(screen.getByTestId('shell-overlay')).toHaveClass('z-50');
    expect(screen.getByRole('dialog')).toHaveAttribute(
      'aria-label',
      'Заголовок',
    );
    expect(screen.getAllByLabelText('Закрыть')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('shell-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('во full-раскладке панель занимает весь экран, а клик внутри неё не закрывает', () => {
    const onClose = vi.fn();
    render(
      <ModalShell
        layout="full"
        onClose={onClose}
        overlayTestId="shell-overlay"
        cardTestId="shell-card"
        actions={<span>попытка 2</span>}
        title={<span>Лог шага</span>}
      >
        тело
      </ModalShell>,
    );

    expect(screen.getByTestId('shell-overlay')).toHaveClass('flex-col');
    expect(screen.getByTestId('shell-card')).toHaveClass('flex-1');
    expect(screen.getByTestId('shell-card')).not.toHaveClass('max-w-3xl');
    expect(screen.getByText('попытка 2')).toBeInTheDocument();

    fireEvent.click(screen.getByText('тело'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('shell-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});