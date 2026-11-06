import type { RetroRun, RetroRunWithLog } from '@issue-resolver/shared';

export function formatStamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ru-RU');
}

export function withLog(run: RetroRun): RetroRunWithLog {
  return { ...run, stdout: '', stderr: '', events: [], stats: null };
}