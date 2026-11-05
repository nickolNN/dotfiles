export const TaskStatus = Object.freeze({
  draft: 'draft',
  pending: 'pending',
  running: 'running',
  preparing: 'preparing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  question: 'question',
} as const);
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const StepRunStatus = Object.freeze({
  pending: 'pending',
  running: 'running',
  success: 'success',
  failed: 'failed',
  needs_input: 'needs_input',
  skipped: 'skipped',
  aborted: 'aborted',
} as const);
export type StepRunStatus = (typeof StepRunStatus)[keyof typeof StepRunStatus];

export const StepReportStatus = Object.freeze({
  pass: 'pass',
  fail: 'fail',
  blocked: 'blocked',
} as const);
export type StepReportStatus =
  (typeof StepReportStatus)[keyof typeof StepReportStatus];

export const ScenarioStatus = Object.freeze({
  pass: 'pass',
  fail: 'fail',
} as const);
export type ScenarioStatus =
  (typeof ScenarioStatus)[keyof typeof ScenarioStatus];

export const RetroRunStatus = Object.freeze({
  running: 'running',
  success: 'success',
  failed: 'failed',
} as const);
export type RetroRunStatus =
  (typeof RetroRunStatus)[keyof typeof RetroRunStatus];

export const RepoConnectionStatus = Object.freeze({
  ok: 'ok',
  error: 'error',
  unknown: 'unknown',
} as const);
export type RepoConnectionStatus =
  (typeof RepoConnectionStatus)[keyof typeof RepoConnectionStatus];

export const RunInstructionsStatus = Object.freeze({
  unknown: 'unknown',
  generated: 'generated',
  failed: 'failed',
} as const);
export type RunInstructionsStatus =
  (typeof RunInstructionsStatus)[keyof typeof RunInstructionsStatus];

export const RoomAgentStatus = Object.freeze({
  running: 'running',
  finished: 'finished',
  aborted: 'aborted',
  failed: 'failed',
} as const);
export type RoomAgentStatus =
  (typeof RoomAgentStatus)[keyof typeof RoomAgentStatus];

export const WorkspaceProgressStatus = Object.freeze({
  running: 'running',
  done: 'done',
  warning: 'warning',
  error: 'error',
} as const);
export type WorkspaceProgressStatus =
  (typeof WorkspaceProgressStatus)[keyof typeof WorkspaceProgressStatus];