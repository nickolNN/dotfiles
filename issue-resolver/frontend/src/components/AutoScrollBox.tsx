import { useEffect, useRef, type ReactNode } from 'react';

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

/**
 * Скроллируемый контейнер с авто-прокруткой вниз при новых событиях.
 * Используется для живого вывода агента в карточке шага.
 */
export default function AutoScrollBox({
  children,
  className,
  scrollKey,
}: AutoScrollBoxProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollKey ?? children]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}