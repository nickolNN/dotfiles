import type { StepRunStatus, TaskStatus } from '@issue-resolver/shared';

/** Базовая палитра «Matrix Code Green». */
export const MATRIX = {
  bg: '#0D0208',
  panel: '#003B00',
  border: '#008F11',
  green: '#00FF41',
} as const;

/** Цвет индикатора статуса задачи (зелёный код + красная/синяя таблетки). */
export const statusColor: Record<TaskStatus, string> = {
  pending: '#008F11',
  running: '#00B4FF',
  completed: '#00FF41',
  failed: '#FF0033',
  cancelled: '#8A8A8A',
};

/**
 * Цвет статуса шага конвейера (для строк step-run). `aborted` идёт в наборе
 * заранее — shared добавит его в StepRunStatus после синка (-820).
 */
export const stepStatusColor: Record<StepRunStatus | 'aborted', string> = {
  pending: '#008F11',
  running: '#00B4FF',
  success: '#00FF41',
  failed: '#FF0033',
  aborted: '#FF0033',
  needs_input: '#FFB000',
  skipped: '#8A8A8A',
};