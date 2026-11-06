import { StepRunStatus } from '@issue-resolver/shared';
import { useEffect, useState } from 'react';

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

interface WorkTimeStepRun {
  status: string;
  created_at: string;
  updated_at: string;
}

export interface StepRunTimes {
  created_at: string;
  updated_at: string;
}

export function stepDurationMs(
  run: StepRunTimes,
  live: boolean,
  now: number,
): number | null {
  const created = Date.parse(run.created_at);
  if (!Number.isFinite(created)) return null;
  const end = live ? now : Date.parse(run.updated_at);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - created);
}

export function sumStepRunWorkMs(
  runs: readonly WorkTimeStepRun[] | null,
  now: number,
): number | null {
  if (runs === null) return null;

  let total = 0;
  for (const run of runs) {
    const duration = stepDurationMs(
      run,
      run.status === StepRunStatus.running,
      now,
    );
    if (duration !== null) total += duration;
  }
  return total;
}

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