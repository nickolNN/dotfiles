import { describe, expect, it } from 'vitest';
import { sumStepRunWorkMs } from './time';

describe('sumStepRunWorkMs', () => {
  it('null → null (step-runs ещё не загружены)', () => {
    expect(sumStepRunWorkMs(null, 0)).toBeNull();
  });

  it('суммирует updated_at - created_at завершённых прогонов', () => {
    const runs = [
      {
        status: 'success',
        created_at: '2026-10-09T00:00:00.000Z',
        updated_at: '2026-10-09T00:03:00.000Z',
      },
      {
        status: 'failed',
        created_at: '2026-10-09T00:20:00.000Z',
        updated_at: '2026-10-09T00:25:00.000Z',
      },
    ];
    expect(sumStepRunWorkMs(runs, 0)).toBe(8 * 60_000);
  });

  it('текущий running считает now - created_at', () => {
    const now = Date.parse('2026-10-09T00:01:00.000Z');
    const runs = [
      {
        status: 'running',
        created_at: '2026-10-09T00:00:00.000Z',
        updated_at: '2026-10-09T00:00:00.000Z',
      },
    ];
    expect(sumStepRunWorkMs(runs, now)).toBe(60_000);
  });

  it('пустой список → 0, битые даты пропускаются', () => {
    expect(sumStepRunWorkMs([], 0)).toBe(0);
    expect(
      sumStepRunWorkMs(
        [{ status: 'success', created_at: 'nope', updated_at: 'nope' }],
        0,
      ),
    ).toBe(0);
  });
});