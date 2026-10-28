import { useEffect, useRef, useState, type ReactNode } from 'react';

interface AnimatedPresenceProps {
  visible: boolean;
  enterClass?: string;
  exitClass?: string;
  exitDuration?: number;
  children: ReactNode;
  className?: string;
}

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