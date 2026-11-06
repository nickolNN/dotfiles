import { StepRunStatus } from '@issue-resolver/shared';

export function isActiveStatus(status: StepRunStatus): boolean {
  return status === StepRunStatus.running || status === StepRunStatus.pending;
}

export function isQuestionEligibleStatus(status: StepRunStatus): boolean {
  return isActiveStatus(status) || status === StepRunStatus.needs_input;
}

export function statusOf(
  run: { id: string; status: StepRunStatus },
  liveStatusByRun: Record<string, StepRunStatus>,
): StepRunStatus {
  return liveStatusByRun[run.id] ?? run.status;
}