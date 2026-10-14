import { useCallback, useRef, useState } from 'react';

interface AnimatedPresenceState {
  /** Монтирован ли элемент в DOM (true = рендерим, false = убрали после анимации) */
  mounted: boolean;
  /** Класс для анимации появления (навесить при монтировании) */
  enterClass: string;
  /** Класс для анимации исчезновения (навесить перед размонтированием) */
  exitClass: string;
  /** Флаг: анимация исчезновения в процессе */
  exiting: boolean;
  /** Запустить исчезновение. Коллбэк вызовется после animationend. */
  exit: () => void;
  /** Монтировать элемент (сбросить состояние для повторного появления). */
  enter: () => void;
}

interface UseAnimatedPresenceOptions {
  /** Длительность enter-анимации в ms (должна совпадать с CSS). Default: 300 */
  enterDuration?: number;
  /** Длительность exit-анимации в ms. Default: 350 */
  exitDuration?: number;
  /** Начальное состояние: монтирован ли элемент. Default: true */
  initialMounted?: boolean;
}

/**
 * Управляет монтированием/размонтированием с CSS-анимациями.
 *
 * Паттерн использования:
 * ```tsx
 * const { mounted, exiting, exit, enterClass, exitClass } = useAnimatedPresence();
 * if (!mounted) return null;
 * return (
 *   <div
 *     className={`${exiting ? exitClass : enterClass}`}
 *     onAnimationEnd={() => { if (exiting) setMounted(false); }}
 *   >
 *     ...
 *   </div>
 * );
 * ```
 */
export function useAnimatedPresence(
  options: UseAnimatedPresenceOptions = {},
): AnimatedPresenceState {
  const { exitDuration = 350, initialMounted = true } = options;

  const [mounted, setMounted] = useState(initialMounted);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const exit = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setExiting(true);
    timerRef.current = setTimeout(() => {
      setMounted(false);
      setExiting(false);
      timerRef.current = null;
    }, exitDuration);
  }, [exitDuration]);

  const enter = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setExiting(false);
    setMounted(true);
  }, []);

  return {
    mounted,
    enterClass: 'animate-fade-in-up',
    exitClass: 'animate-fade-out-up',
    exiting,
    exit,
    enter,
  };
}