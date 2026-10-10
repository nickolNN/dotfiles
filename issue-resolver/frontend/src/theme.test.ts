import { describe, expect, it } from 'vitest';
import type { StepRunStatus, TaskStatus } from '@issue-resolver/shared';
import { MATRIX, statusColor, stepStatusColor } from './theme';

const STATUSES: TaskStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
];

const STEP_STATUSES: StepRunStatus[] = [
  'pending',
  'running',
  'success',
  'failed',
  'needs_input',
  'skipped',
];

/** `aborted` придёт в StepRunStatus после синка shared (-820). */
const STEP_STATUS_KEYS = [...STEP_STATUSES, 'aborted'];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

describe('theme tokens', () => {
  it('exposes the Matrix base palette', () => {
    expect(MATRIX.bg).toBe('#0D0208');
    expect(MATRIX.panel).toBe('#003B00');
    expect(MATRIX.border).toBe('#008F11');
    expect(MATRIX.green).toBe('#00FF41');
  });

  it('maps exactly the five TaskStatus values to valid hex colors', () => {
    expect(Object.keys(statusColor).sort()).toEqual([...STATUSES].sort());

    for (const status of STATUSES) {
      expect(statusColor[status], status).toMatch(HEX);
    }
  });

  it('uses the specified pill colors for each status', () => {
    expect(statusColor.completed).toBe('#00FF41');
    expect(statusColor.failed).toBe('#FF0033');
    expect(statusColor.running).toBe('#00B4FF');
    expect(statusColor.pending).toBe('#008F11');
    expect(statusColor.cancelled).toBe('#8A8A8A');
  });

  it('maps every StepRunStatus (plus aborted) to a valid hex color', () => {
    expect(Object.keys(stepStatusColor).sort()).toEqual(
      [...STEP_STATUS_KEYS].sort(),
    );

    for (const status of STEP_STATUS_KEYS) {
      expect(stepStatusColor[status as StepRunStatus], status).toMatch(HEX);
    }
  });

  it('uses the specified colors for each step status', () => {
    expect(stepStatusColor.pending).toBe('#008F11');
    expect(stepStatusColor.running).toBe('#00B4FF');
    expect(stepStatusColor.success).toBe('#00FF41');
    expect(stepStatusColor.failed).toBe('#FF0033');
    expect(stepStatusColor.needs_input).toBe('#FFB000');
    expect(stepStatusColor.skipped).toBe('#8A8A8A');
    expect(stepStatusColor.aborted).toBe('#FF0033');
  });
});