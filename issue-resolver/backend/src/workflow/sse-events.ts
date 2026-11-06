import type {
  PipelineStep,
  SSEEvent,
  StepRunStatus,
  TaskStatus,
} from '@issue-resolver/shared';
export { noticeEvent, stepEvent, streamEvent } from '../pi/agent-session';

import { nowIso } from '../db/rows';

export { nowIso };

export interface StepStatusOptions {
  iterationId?: string;
  step?: PipelineStep | 'retro';
  model?: string | null;
}

export const stepStatusEvent = (
  issueId: string,
  stepRunId: string,
  status: StepRunStatus,
  options?: StepStatusOptions,
): SSEEvent => ({
  type: 'step_status',
  issueId,
  ...(options?.iterationId ? { iterationId: options.iterationId } : {}),
  stepRunId,
  data: options?.step
    ? JSON.stringify({
        status,
        step: options.step,
        ...(options.model !== undefined ? { model: options.model } : {}),
      })
    : status,
  ts: nowIso(),
});

export const iterationStatusEvent = (
  issueId: string,
  iterationId: string,
  status: TaskStatus,
  options: { needsInput?: boolean; error?: string; ts: string },
): SSEEvent => ({
  type: 'iteration_status',
  issueId,
  iterationId,
  data: JSON.stringify({
    iterationId,
    status,
    needsInput: options.needsInput ?? false,
    ...(options.error ? { error: options.error } : {}),
  }),
  ts: options.ts,
});
