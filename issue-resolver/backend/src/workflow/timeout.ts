
export const MIN_RESOLVE_AGENT_TIMEOUT_MS = 60_000;

export const DEFAULT_RESOLVE_AGENT_TIMEOUT_MS = 180 * 60_000;

export const RESOLVE_AGENT_TIMEOUT_ENV =
  'ISSUE_RESOLVER_RESOLVE_AGENT_TIMEOUT_MS';

export function resolveAgentTimeoutMs(
  raw: string | undefined = process.env[RESOLVE_AGENT_TIMEOUT_ENV],
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RESOLVE_AGENT_TIMEOUT_MS;
  }
  return Math.max(parsed, MIN_RESOLVE_AGENT_TIMEOUT_MS);
}

export const DEVOPS_TIMEOUT_ENV =
  'ISSUE_RESOLVER_DEVOPS_TIMEOUT_MS';

export const LEGACY_DEVOPS_TIMEOUT_ENV =
  'ISSUE_RESOLVER_BOOTSTRAPPER_TIMEOUT_MS';

export const DEFAULT_DEVOPS_TIMEOUT_MS = DEFAULT_RESOLVE_AGENT_TIMEOUT_MS;

export function resolveDevOpsTimeoutMs(
  raw: string | undefined = process.env[DEVOPS_TIMEOUT_ENV] ??
    process.env[LEGACY_DEVOPS_TIMEOUT_ENV],
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DEVOPS_TIMEOUT_MS;
  }
  return Math.max(parsed, MIN_RESOLVE_AGENT_TIMEOUT_MS);
}

export function withAgentTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

import type { StallRecovery } from '../pi/stall-recovery';

export type { StallRecovery };

export const AGENT_STALL_TIMEOUT_ENV =
  'ISSUE_RESOLVER_AGENT_STALL_TIMEOUT_MS';

export const DEFAULT_AGENT_STALL_TIMEOUT_MS = 15 * 60_000;

export const MIN_AGENT_STALL_TIMEOUT_MS = 30_000;

export function resolveAgentStallTimeoutMs(
  raw: string | undefined = process.env[AGENT_STALL_TIMEOUT_ENV],
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AGENT_STALL_TIMEOUT_MS;
  }
  return Math.max(parsed, MIN_AGENT_STALL_TIMEOUT_MS);
}
export function withAgentStallGuard<T>(
  promise: Promise<T>,
  options: {
    stallMs: number;
    label: string;
    activity: () => number;
    pollMs?: number;
    recover?: StallRecovery[];
    attemptTimeoutMs?: number;
    onStall?: () => void;
  },
): Promise<T> {
  const { stallMs, label, activity } = options;
  const pollMs = Math.max(1, Math.min(options.pollMs ?? 1_000, stallMs));
  const pending = [...(options.recover ?? [])];
  const tried: string[] = [];
  const attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? 30_000);

  const attemptWithCeiling = (
    attempt: StallRecovery['attempt'],
  ): Promise<number> =>
    new Promise<number>((resolveAttempt) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolveAttempt(0);
      }, attemptTimeoutMs);
      const finish = (grace: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveAttempt(grace);
      };
      Promise.resolve()
        .then(attempt)
        .then((grace) => finish(grace ?? 0))
        .catch(() => finish(0));
    });

  return new Promise<T>((resolve, reject) => {
    let seen = activity();
    let seenAt = Date.now();
    let graceMs = 0;
    let recovering = false;
    let finished = false;

    const stop = () => {
      finished = true;
      clearInterval(timer);
    };

    const giveUp = () => {
      stop();
      try {
        options.onStall?.();
      } catch {
      }
      const suffix = tried.length > 0 ? ` (tried: ${tried.join(', ')})` : '';
      reject(new Error(`${label} stalled: no output for ${stallMs}ms${suffix}`));
    };

    const attemptNext = () => {
      const next = pending.shift();
      if (!next) {
        giveUp();
        return;
      }
      tried.push(next.label);
      recovering = true;
      void attemptWithCeiling(next.attempt).then((grace) => {
        recovering = false;
        if (finished) return;
        if (grace > 0) {
          seen = activity();
          seenAt = Date.now();
          graceMs = grace;
          return;
        }
        if (pending.length > 0) attemptNext();
        else giveUp();
      });
    };

    const timer = setInterval(() => {
      const current = activity();
      if (current !== seen) {
        seen = current;
        seenAt = Date.now();
        graceMs = 0;
        return;
      }
      if (recovering) return;
      if (Date.now() - seenAt < (graceMs > 0 ? graceMs : stallMs)) return;
      graceMs = 0;
      attemptNext();
    }, pollMs);

    promise.then(
      (value) => {
        stop();
        resolve(value);
      },
      (error) => {
        stop();
        reject(error);
      },
    );
  });
}
