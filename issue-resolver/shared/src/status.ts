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

export const RunState = Object.freeze({
  idle: 'idle',
  running: 'running',
  success: 'success',
  failed: 'failed',
} as const);
export type RunState = (typeof RunState)[keyof typeof RunState];

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

export const StepAgentStatus = Object.freeze({
  running: 'running',
  finished: 'finished',
  aborted: 'aborted',
  failed: 'failed',
} as const);
export type StepAgentStatus =
  (typeof StepAgentStatus)[keyof typeof StepAgentStatus];

export const StepAgentRole = Object.freeze({
  worker: 'worker',
  coordinator: 'coordinator',
} as const);
export type StepAgentRole =
  (typeof StepAgentRole)[keyof typeof StepAgentRole];

export const ExecutionMode = Object.freeze({
  single: 'single',
  stages: 'stages',
} as const);
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

export const SSEStream = Object.freeze({
  stdout: 'stdout',
  stderr: 'stderr',
  rpc: 'rpc',
  mr: 'mr',
  system: 'system',
} as const);
export type SSEStream = (typeof SSEStream)[keyof typeof SSEStream];

export const FindingSeverity = Object.freeze({
  info: 'info',
  low: 'low',
  minor: 'minor',
  major: 'major',
  critical: 'critical',
} as const);
export type FindingSeverity =
  (typeof FindingSeverity)[keyof typeof FindingSeverity];

const FINDING_SEVERITIES: ReadonlySet<string> = new Set(
  Object.values(FindingSeverity),
);

export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === 'string' && FINDING_SEVERITIES.has(value);
}

export const DesiredResult = Object.freeze({
  md: 'md',
  html: 'html',
} as const);
export type DesiredResult = (typeof DesiredResult)[keyof typeof DesiredResult];

export const CompactionReason = Object.freeze({
  manual: 'manual',
  threshold: 'threshold',
  overflow: 'overflow',
} as const);
export type CompactionReason =
  (typeof CompactionReason)[keyof typeof CompactionReason];

export const StepFailureReason = Object.freeze({
  no_model_reply: 'no_model_reply',
  no_report: 'no_report',
  agent_exit: 'agent_exit',
  report_fail: 'report_fail',
} as const);
export type StepFailureReason =
  (typeof StepFailureReason)[keyof typeof StepFailureReason];

export const SSEEventType = Object.freeze({
  log: 'log',
  step_status: 'step_status',
  step_event: 'step_event',
  iteration_status: 'iteration_status',
  workspace_progress: 'workspace_progress',
  issue_deleting: 'issue_deleting',
  issue_deleted: 'issue_deleted',
  container_stats: 'container_stats',
} as const);
export type SSEEventType = (typeof SSEEventType)[keyof typeof SSEEventType];

export const ThinkingLevel = Object.freeze({
  off: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const);
export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];

const THINKING_LEVELS: ReadonlySet<string> = new Set(
  Object.values(ThinkingLevel),
);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.has(value);
}

export const IssueDeletingPhase = Object.freeze({
  stopping_processes: 'stopping_processes',
  removing_db_record: 'removing_db_record',
  removing_workspace: 'removing_workspace',
  removing_container: 'removing_container',
  error: 'error',
} as const);
export type IssueDeletingPhase =
  (typeof IssueDeletingPhase)[keyof typeof IssueDeletingPhase];

export const WorkspaceProgressStep = Object.freeze({
  creating_dirs: 'creating_dirs',
  cloning: 'cloning',
  checking_instructions: 'checking_instructions',
  devops: 'devops',
  installing: 'installing',
  dev_server: 'dev_server',
  ready: 'ready',
} as const);
export type WorkspaceProgressStep =
  (typeof WorkspaceProgressStep)[keyof typeof WorkspaceProgressStep];

export const WorkspaceProgressStatus = Object.freeze({
  running: 'running',
  done: 'done',
  warning: 'warning',
  error: 'error',
} as const);
export type WorkspaceProgressStatus =
  (typeof WorkspaceProgressStatus)[keyof typeof WorkspaceProgressStatus];

export const SessionNoticeLevel = Object.freeze({
  info: 'info',
  warning: 'warning',
  error: 'error',
} as const);
export type SessionNoticeLevel =
  (typeof SessionNoticeLevel)[keyof typeof SessionNoticeLevel];
