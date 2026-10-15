import { useEffect, useState } from 'react';

/** Живой тик раз в секунду, пока `active`; останавливается на false/unmount. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Минимум, нужный для подсчёта времени работы по одному step-run. */
export interface WorkTimeStepRun {
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Чистое время работы агентов — сумма длительностей step-runs:
 * `updated_at - created_at` у завершённых прогонов, `now - created_at` у
 * текущего running. Простой задачи между итерациями не учитывается.
 * `null`, если step-runs ещё не загружены (нет данных для таймера).
 */
export function sumStepRunWorkMs(
  runs: readonly WorkTimeStepRun[] | null,
  now: number,
): number | null {
  if (runs === null) return null;

  let total = 0;
  for (const run of runs) {
    const start = Date.parse(run.created_at);
    if (!Number.isFinite(start)) continue;
    const end =
      run.status === 'running' ? now : Date.parse(run.updated_at);
    if (Number.isFinite(end)) total += Math.max(0, end - start);
  }
  return total;
}

/** Человекочитаемая длительность: `45с` / `3м 12с` / `1ч 4м`. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}с`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}м ${seconds}с`;
  const hours = Math.floor(minutes / 60);
  return `${hours}ч ${minutes % 60}м`;
}