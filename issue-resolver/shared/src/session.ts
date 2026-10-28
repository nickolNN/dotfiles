/**
 * Session liveness, shared by the backend and the UI.
 *
 * A run's row says `running` while its process lives, but the row alone cannot
 * tell a live run from a dead one: the process dies, the row stays. The writer
 * refreshes `updated_at` every heartbeat; a reader treats anything quieter than
 * the stale window as dead.
 */

/** While a session is alive its row is refreshed at this interval. */
export const SESSION_HEARTBEAT_MS = 20_000;

/**
 * A `running` row untouched for longer than this is dead, not busy. Set well
 * above the heartbeat so one slow write does not look like a death.
 */
export const SESSION_STALE_MS = 120_000;

/** Minutes a run has been quiet, rounded up to at least one. */
export function quietMinutes(
  lastActivityIso: string,
  now: number = Date.now(),
): number {
  return Math.max(1, Math.round((now - Date.parse(lastActivityIso)) / 60_000));
}

/** True when a `running` row has missed its heartbeat window. */
export function isSessionStale(
  lastActivityIso: string,
  now: number = Date.now(),
  staleMs: number = SESSION_STALE_MS,
): boolean {
  const last = Date.parse(lastActivityIso);
  if (Number.isNaN(last)) return true;
  return now - last > staleMs;
}