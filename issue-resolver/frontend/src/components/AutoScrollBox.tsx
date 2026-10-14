import { useCallback, useEffect, useRef, type ReactNode } from 'react';

interface AutoScrollBoxProps {
  children: ReactNode;
  className?: string;
  /**
   * Значение-триггер: при его изменении контейнер прокручивается вниз.
   * По умолчанию — сами `children`, т.е. прокрутка при любом новом рендере
   * содержимого.
   */
  scrollKey?: unknown;
}

/** Порог в пикселях от нижнего края: ближе — считаем «прибитым» ко дну. */
const PIN_THRESHOLD_PX = 50;

/**
 * Скроллируемый контейнер с авто-прокруткой вниз при новых событиях.
 * Используется для живого вывода агента в карточке шага.
 *
 * Автоскролл работает только пока пользователь находится у нижнего края
 * (≤50px от дна). Если пользователь отмотал выше — автоскролл
 * приостанавливается и возобновляется, когда он вернётся к нижнему краю.
 */
export default function AutoScrollBox({
  children,
  className,
  scrollKey,
}: AutoScrollBoxProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [scrollKey ?? children]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ scrollBehavior: scrollKey !== undefined ? 'smooth' : 'auto' }}
      onScroll={handleScroll}
    >
      {children}
    </div>
  );
}