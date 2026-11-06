import { useEffect, useRef, type MutableRefObject } from "react";

export const POLL_INTERVAL_MS = 4000;

export interface PollContext {
  isActive: () => boolean;
}

export function hydrateLaggingRun<T>(
  load: () => Promise<T | null>,
  ctx: PollContext,
  apply: (value: T | null) => void,
): void {
  load()
    .then((value) => {
      if (ctx.isActive()) apply(value);
    })
    .catch(() => {
      if (ctx.isActive()) apply(null);
    });
}

interface UseStatusPollOptions<T> {
  enabled: boolean;
  fetch: () => Promise<T>;
  apply: (value: T, ctx: PollContext) => void;
  onError?: (ctx: PollContext) => void;
  intervalMs?: number;
}

export function useStatusPoll<T>({
  enabled,
  fetch,
  apply,
  onError,
  intervalMs = POLL_INTERVAL_MS,
}: UseStatusPollOptions<T>): MutableRefObject<() => void> {
  const latest = useRef({ fetch, apply, onError });
  latest.current = { fetch, apply, onError };
  const activeRef = useRef(false);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    activeRef.current = true;
    const ctx: PollContext = { isActive: () => activeRef.current };
    const poll = () => {
      latest.current
        .fetch()
        .then((value) => {
          if (activeRef.current) latest.current.apply(value, ctx);
        })
        .catch(() => {
          if (activeRef.current) latest.current.onError?.(ctx);
        });
    };
    pollRef.current = poll;
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      activeRef.current = false;
      pollRef.current = () => {};
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return pollRef;
}