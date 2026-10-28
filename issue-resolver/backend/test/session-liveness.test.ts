import { describe, expect, it } from 'vitest';
import { isSessionStale, quietMinutes, SESSION_STALE_MS } from '../src/pi/session-liveness';

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('session liveness', () => {
  it('свежее сердцебиение → сессия жива', () => {
    expect(isSessionStale(at(-20_000))).toBe(false);
  });

  it('тишина дольше окна → мертва', () => {
    expect(isSessionStale(at(-SESSION_STALE_MS - 1_000))).toBe(true);
  });

  it('битый timestamp считается мёртвым, а не вечным running', () => {
    expect(isSessionStale('not-a-date')).toBe(true);
  });

  it('минуты тишины не округляются в ноль', () => {
    expect(quietMinutes(at(-10_000))).toBe(1);
    expect(quietMinutes(at(-5 * 60_000))).toBe(5);
  });
});
