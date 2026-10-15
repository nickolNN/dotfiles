import { useEffect, useRef, useState, type ReactNode } from 'react';

interface AnimatedPresenceProps {
  /** Управляет видимостью: true = показать (с анимацией), false = скрыть (с анимацией) */
  visible: boolean;
  /** Класс для анимации появления (без префикса animate-). Default: 'fade-in-up' */
  enterClass?: string;
  /** Класс для анимации исчезновения. Default: 'fade-out-up' */
  exitClass?: string;
  /** Длительность exit-анимации в ms. Default: 350 */
  exitDuration?: number;
  children: ReactNode;
  className?: string;
}

/**
 * Оборачивает содержимое, добавляя анимацию появления/исчезновения.
 * Когда `visible` становится false, сначала проигрывается exit-анимация,
 * потом элемент убирается из DOM.
 *
 * Использование:
 * ```tsx
 * <AnimatedPresence visible={showPanel}>
 *   <div className="panel p-4">Содержимое</div>
 * </AnimatedPresence>
 * ```
 */
export default function AnimatedPresence({
  visible,
  enterClass = 'fade-in-up',
  exitClass = 'fade-out-up',
  exitDuration = 350,
  children,
  className,
}: AnimatedPresenceProps) {
  const [state, setState] = useState<'hidden' | 'entering' | 'visible' | 'exiting'>(
    visible ? 'visible' : 'hidden',
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      if (state === 'hidden') {
        setState('entering');
      }
    } else {
      if (state === 'visible' || state === 'entering') {
        setState('exiting');
        timerRef.current = setTimeout(() => {
          setState('hidden');
          timerRef.current = null;
        }, exitDuration);
      }
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, exitDuration]);

  // Сброс таймера при размонтировании
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (state === 'hidden') return null;

  const animClass =
    state === 'exiting'
      ? `animate-${exitClass}`
      : state === 'entering'
        ? `animate-${enterClass}`
        : '';

  return (
    <div className={`${animClass} ${className ?? ''}`}>{children}</div>
  );
}