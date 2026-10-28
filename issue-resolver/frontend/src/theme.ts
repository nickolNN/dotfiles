import type { StepRunStatus, TaskStatus } from '@issue-resolver/shared';

export const MATRIX = {
  bg: '#0D0208',
  panel: '#003B00',
  border: '#008F11',
  green: '#00FF41',
} as const;

export const statusColor: Record<TaskStatus, string> = {
  draft: '#8A8A8A',
  pending: '#008F11',
  running: '#00B4FF',
  preparing: '#FFB000',
  completed: '#00FF41',
  failed: '#FF0033',
  cancelled: '#8A8A8A',
  question: '#FFB000',
};

export const stepStatusColor: Record<StepRunStatus | 'aborted', string> = {
  pending: '#008F11',
  running: '#00B4FF',
  success: '#00FF41',
  failed: '#FF0033',
  aborted: '#FF0033',
  needs_input: '#FFB000',
  skipped: '#8A8A8A',
};