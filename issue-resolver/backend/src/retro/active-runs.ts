import { createActiveRuns } from '../util/active-runs';
import type { RetroRunDeps } from './types';

const activeRetroRuns = createActiveRuns();

export function activeRetroRunId(): string | null {
  return activeRetroRuns.first();
}

export function isRetroRunActive(runId: string): boolean {
  return activeRetroRuns.has(runId);
}

export function markRetroRunActive(runId: string): void {
  activeRetroRuns.add(runId);
}

export function markRetroRunDone(runId: string): void {
  activeRetroRuns.delete(runId);
}

export const AbortRetroResult = Object.freeze({
  aborted: 'aborted',
  notRunning: 'not_running',
  unavailable: 'unavailable',
} as const);
export type AbortRetroResult =
  (typeof AbortRetroResult)[keyof typeof AbortRetroResult];

export function abortRetroRun(
  deps: RetroRunDeps,
  runId: string,
): AbortRetroResult {
  if (!activeRetroRuns.has(runId)) return AbortRetroResult.notRunning;
  if (!deps.registry) return AbortRetroResult.unavailable;
  return deps.registry.abort(runId)
    ? AbortRetroResult.aborted
    : AbortRetroResult.unavailable;
}