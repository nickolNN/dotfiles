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

/** Порог «у дна»: если до низа ≤ 1 строки — считаем что пользователь
 * смотрит на последние события и авто-скролл должен работать. */
const AT_BOTTOM_PX = 16;

/**
 * Скроллируемый контейнер с авто-прокруткой вниз при новых событиях.
 * Используется для живого вывода агента в карточке шага.
 *
 * Поведение как в Slack/Discord — авто-следование за новым контентом
 * **пока пользователь у дна**. Ушёл вверх → авто-скролл на паузе, кнопка
 * показывает что есть непрочитанные события. Докрутил до дна → авто-скролл
 * возобновляется. Кнопка всегда прыгает вниз и включает live.
 */
export default function AutoScrollBox({
  children,
  className,
  scrollKey,
}: AutoScrollBoxProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef(true);
  const [live, setLive] = useState(true);

  /** Проверка: скролл-позиция в пределах порога от дна. */
  const isAtBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return true; // нет DOM — считаем у дна (монтирование)
    return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
  }, []);

  /**
   * Пользователь крутит колесом/тачпадом.
   * Ушёл от дна → live OFF (пауза). Вернулся ко дну → live ON (resume).
   */
  const handleScroll = useCallback(() => {
    const atBottom = isAtBottom();
    if (atBottom && !liveRef.current) {
      liveRef.current = true;
      setLive(true);
    } else if (!atBottom && liveRef.current) {
      liveRef.current = false;
      setLive(false);
    }
  }, [isAtBottom]);

  /** Кнопка: прыжок вниз + включение live. */
  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    liveRef.current = true;
    setLive(true);
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    }
    if (el.scrollTop < el.scrollHeight - el.clientHeight) {
      const prev = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
      el.style.scrollBehavior = prev;
    }
  }, []);

  /**
   * Синхронный скролл ко дну при изменении данных — только если
   * live включён (пользователь не отмотал вверх).
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !liveRef.current) return;
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prev;
  }, [scrollKey ?? children]);

  /**
   * ResizeObserver на ребёнке — ловит ВСЕ изменения лейаута ПОСЛЕ
   * рендера (переносы текста, анимации, внутренние скроллбары).
   * Только в браузере; в jsdom fallback на синхронный scrollTop выше.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const content = el.firstElementChild;
    if (!content) return;

    let rafId = 0;
    const scrollIfLive = () => {
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

    const observer = new ResizeObserver(scrollIfLive);
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
        onScroll={handleScroll}
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
        aria-label={
          live
            ? 'Авто-прокрутка включена'
            : 'Прокрутить вниз и включить авто-прокрутку'
        }
        aria-pressed={live}
        title={
          live
            ? 'Авто-прокрутка включена — крутаните вверх чтобы поставить на паузу'
            : 'Прокрутить вниз (новые события ниже)'
        }
        onClick={scrollToBottom}
        className={`absolute bottom-2 right-2 z-10 border px-2 py-1 text-[10px] uppercase tracking-wider transition-base${
          live
            ? ' border-[#00FF41] bg-[#003B00] text-[#00FF41] shadow-[0_0_8px_rgba(0,255,65,0.5)]'
            : ' border-[#008F11]/50 bg-[#000200]/70 text-[#00FF41]/40 hover:text-[#00FF41]'
        }`}
      >
        {live ? '● live' : '▼ live'}
      </button>
    </div>
  );
}