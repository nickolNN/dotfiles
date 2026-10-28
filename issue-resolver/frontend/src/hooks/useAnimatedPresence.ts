import { useCallback, useRef, useState } from 'react';

interface AnimatedPresenceState {
  mounted: boolean;
  enterClass: string;
  exitClass: string;
  exiting: boolean;
  exit: () => void;
  enter: () => void;
}

interface UseAnimatedPresenceOptions {
  enterDuration?: number;
  exitDuration?: number;
  initialMounted?: boolean;
}

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