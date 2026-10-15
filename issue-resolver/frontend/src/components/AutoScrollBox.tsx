import {
  useCallback,
  useEffect,
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

/** Порог в пикселях от нижнего края: ближе — считаем «прибитым» ко дну. */
const PIN_THRESHOLD_PX = 50;

/**
 * Скроллируемый контейнер с авто-прокруткой вниз при новых событиях.
 * Используется для живого вывода агента в карточке шага.
 *
 * Автоскролл работает только пока пользователь находится у нижнего края
 * (≤50px от дна). Если пользователь отмотал выше — автоскролл
 * приостанавливается и возобновляется, когда он вернётся к нижнему краю.
 *
 * Плавающая кнопка «↓ вниз» даёт явный контроль: клик мгновенно прокручивает
 * ко дну и снова включает авто-следование (в т.ч. после того, как пиннинг
 * сбился). Пока пиннинг активен, кнопка остаётся в приглушённом «live»-виде,
 * чтобы не мешать чтению.
 */
export default function AutoScrollBox({
  children,
  className,
  scrollKey,
}: AutoScrollBoxProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // ref нужен синхронно в эффекте автопрокрутки, state — чтобы перерисовать
  // кнопку при смене «прибит / отмотан».
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const updatePinned = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setPinned((current) => (current === next ? current : next));
  }, []);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    updatePinned(
      el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX,
    );
  }, [updatePinned]);

  useEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [scrollKey ?? children]);

  /**
   * Принудительный прыжок ко дну. Мгновенный (`behavior: 'auto'`): smooth-
   * анимация заставила бы `onScroll` ловить промежуточные позиции и снимать
   * пиннинг на полпути. После прыжка снова следуем за выводом.
   */
  const jumpToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    }
    // Движки без `scrollTo` (jsdom) или если он не сдвинул позицию — ставим
    // scrollTop напрямую, на время отключив smooth, чтобы прыжок был мгновенным.
    if (el.scrollTop < el.scrollHeight - el.clientHeight) {
      const previous = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
      el.style.scrollBehavior = previous;
    }
    updatePinned(true);
  }, [updatePinned]);

  return (
    <div className="relative">
      <div
        ref={ref}
        className={className}
        style={{ scrollBehavior: scrollKey !== undefined ? 'smooth' : 'auto' }}
        onScroll={handleScroll}
      >
        {children}
      </div>
      <button
        type="button"
        data-testid="scroll-to-bottom"
        data-pinned={pinned ? 'true' : 'false'}
        aria-label="Прокрутить вниз"
        aria-pressed={pinned}
        title={
          pinned ? 'Слежение за выводом включено' : 'Прокрутить вниз'
        }
        onClick={jumpToBottom}
        className={`absolute bottom-2 right-2 z-10 border px-2 py-1 text-[10px] uppercase tracking-wider transition-base${
          pinned
            ? ' border-[#008F11]/50 bg-[#000200]/70 text-[#00FF41]/40 hover:text-[#00FF41]'
            : ' border-[#00FF41] bg-[#003B00] text-[#00FF41] shadow-[0_0_8px_rgba(0,255,65,0.5)]'
        }`}
      >
        {pinned ? '● live' : '↓ вниз'}
      </button>
    </div>
  );
}