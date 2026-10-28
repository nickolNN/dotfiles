
export const SESSION_HEARTBEAT_MS = 20_000;

export const SESSION_STALE_MS = 120_000;

export function quietMinutes(
  lastActivityIso: string,
  now: number = Date.now(),
): number {
  return Math.max(1, Math.round((now - Date.parse(lastActivityIso)) / 60_000));
}

export function isSessionStale(
  lastActivityIso: string,
  now: number = Date.now(),
  staleMs: number = SESSION_STALE_MS,
): boolean {
  const last = Date.parse(lastActivityIso);
  if (Number.isNaN(last)) return true;
  return now - last > staleMs;
}