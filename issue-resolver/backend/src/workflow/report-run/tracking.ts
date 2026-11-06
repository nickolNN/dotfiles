import { SESSION_HEARTBEAT_MS, StepRunStatus } from '@issue-resolver/shared';
import { createActiveRuns } from '../../util/active-runs';

const activeReportRuns = createActiveRuns();

export const REPORT_RUN_HEARTBEAT_MS = SESSION_HEARTBEAT_MS;

const lastReportOutcome = new Map<string, StepRunStatus>();

export function isReportRunActive(issueId: string): boolean {
  return activeReportRuns.has(issueId);
}

export function markReportRunActive(issueId: string): void {
  activeReportRuns.add(issueId);
}

export function unmarkReportRunActive(issueId: string): void {
  activeReportRuns.delete(issueId);
}

export function lastReportFailed(issueId: string): boolean {
  return lastReportOutcome.get(issueId) === StepRunStatus.failed;
}

export function recordReportOutcome(issueId: string, failed: boolean): void {
  if (failed) {
    lastReportOutcome.set(issueId, StepRunStatus.failed);
    return;
  }
  lastReportOutcome.delete(issueId);
}