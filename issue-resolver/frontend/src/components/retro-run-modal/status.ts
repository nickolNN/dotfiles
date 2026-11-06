import {
  RetroRunStatus,
  StepRunStatus,
  type RetroRun,
} from '@issue-resolver/shared';

export const STATUS_LABEL: Record<RetroRun['status'], string> = {
  [RetroRunStatus.running]: 'идёт',
  [RetroRunStatus.success]: 'готово',
  [RetroRunStatus.failed]: 'ошибка',
};

export const RUN_STATUS: Record<RetroRun['status'], StepRunStatus> = {
  [RetroRunStatus.running]: StepRunStatus.running,
  [RetroRunStatus.success]: StepRunStatus.success,
  [RetroRunStatus.failed]: StepRunStatus.failed,
};

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  RetroRunStatus.running,
]);
