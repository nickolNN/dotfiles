import { MS_PER_SECOND, SECONDS_PER_MINUTE } from './constants';

export function formatToolDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < MS_PER_SECOND) return `${Math.round(ms)}ms`;
  const totalSec = ms / MS_PER_SECOND;
  if (totalSec < SECONDS_PER_MINUTE) return `${totalSec.toFixed(1)}s`;
  const minutes = Math.floor(totalSec / SECONDS_PER_MINUTE);
  const seconds = Math.round(totalSec % SECONDS_PER_MINUTE);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
