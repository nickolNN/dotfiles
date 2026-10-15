import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
 *
 * Плавающая кнопка работает как бинарный переключатель:
 * - **ON  («● live»)** — жёсткая авто-прокрутка ко дну на каждое новое
 *   событие. Пользователь может крутить, но следующий апдейт всё равно
 *   утащит вниз.
 * - **OFF («● live»)** — авто-прокрутка отключена. Пользователь свободно
 *   листает вывод. Клик по кнопке скроллит ко дну и снова включает ON.
 *
 * По умолчанию режим включён (live).
 */
export default function AutoScrollBox({
  children,
  className,
  scrollKey,
}: AutoScrollBoxProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef(true);
  const [live, setLive] = useState(true);

  /**
   * Переключение live-режима.
   *
   * OFF → ON: скроллим ко дну и включаем слежение.
   * ON  → OFF: просто выключаем, не трогаем позицию.
   */
  const toggleLive = useCallback(() => {
    const el = ref.current;
    const next = !liveRef.current;
    liveRef.current = next;
    setLive(next);

    if (next && el) {
      // Включили live — мгновенно прыгаем ко дну.
      if (typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      }
      if (el.scrollTop < el.scrollHeight - el.clientHeight) {
        const previous = el.style.scrollBehavior;
        el.style.scrollBehavior = 'auto';
        el.scrollTop = el.scrollHeight;
        el.style.scrollBehavior = previous;
      }
    }
  }, []);

  /**
   * Синхронный скролл ко дну при изменении данных.
   *
   * В браузере это «первый проход» — ResizeObserver ниже доведёт позицию
   * до окончательной после всех внутренних лейаут-изменений. В jsdom
   * (тесты, нет ResizeObserver) это единственный механизм.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !liveRef.current) return;
    const previous = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = previous;
  }, [scrollKey ?? children]);

  /**
   * ResizeObserver на контенте скролл-контейнера — ловит ВСЕ изменения
   * лейаута ПОСЛЕ того, как браузер их полностью рассчитал (переносы
   * текста, появление внутренних скроллбаров в дочерних overflow:auto
   * блоках, завершение CSS-анимаций).
   *
   * Только в браузере; в jsdom ResizeObserver отсутствует — fallback
   * на синхронный scrollTop выше.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const content = el.firstElementChild;
    if (!content) return;

    let rafId = 0;
    const scrollToBottom = () => {
      if (!liveRef.current || !el) return;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!liveRef.current || !el) return;
        const prev = el.style.scrollBehavior;
        el.style.scrollBehavior = 'auto';
        el.scrollTop = el.scrollHeight;
        el.style.scrollBehavior = prev;
      });
    };

    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(content);

    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div className="relative">
      <div
        ref={ref}
        className={className}
        style={{
          scrollBehavior: 'auto',
          overflowAnchor: 'none',
        }}
      >
        {children}
      </div>
      <button
        type="button"
        data-testid="scroll-to-bottom"
        data-live={live ? 'true' : 'false'}
        aria-label={live ? 'Выключить авто-прокрутку' : 'Прокрутить вниз и включить авто-прокрутку'}
        aria-pressed={live}
        title={
          live
            ? 'Авто-прокрутка включена — нажмите, чтобы выключить'
            : 'Прокрутить вниз и включить авто-прокрутку'
        }
        onClick={toggleLive}
        className={`absolute bottom-2 right-2 z-10 border px-2 py-1 text-[10px] uppercase tracking-wider transition-base${
          live
            ? ' border-[#00FF41] bg-[#003B00] text-[#00FF41] shadow-[0_0_8px_rgba(0,255,65,0.5)]'
            : ' border-[#008F11]/50 bg-[#000200]/70 text-[#00FF41]/40 hover:text-[#00FF41]'
        }`}
      >
        ● live
      </button>
    </div>
  );
}