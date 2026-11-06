import type { RetroRunStatus, SessionEvent, SSEEvent } from '@issue-resolver/shared';
import { stepStatusEvent } from '../workflow/sse-events';
import { RETRO_SCOPE_ID } from './config';
import type { RetroRunDeps } from './types';
import { nowIso } from '../db/rows';

function publish(
  deps: RetroRunDeps,
  runId: string,
  event: Pick<SSEEvent, 'type' | 'data' | 'stream'>,
): void {
  deps.sse?.publish({
    type: event.type,
    issueId: RETRO_SCOPE_ID,
    stepRunId: runId,
    ...(event.stream ? { stream: event.stream } : {}),
    data: event.data,
    ts: nowIso(),
  });
}

export function publishStatus(
  deps: RetroRunDeps,
  runId: string,
  status: RetroRunStatus,
): void {
  deps.sse?.publish(
    stepStatusEvent(RETRO_SCOPE_ID, runId, status, { step: 'retro' }),
  );
}

export function publishLog(
  deps: RetroRunDeps,
  runId: string,
  stream: 'stdout' | 'stderr',
  chunk: string,
): void {
  if (!chunk) return;
  publish(deps, runId, { type: 'log', stream, data: chunk });
}

export function publishSessionEvent(
  deps: RetroRunDeps,
  runId: string,
  event: SessionEvent,
): void {
  publish(deps, runId, {
    type: 'step_event',
    data: JSON.stringify({ stepRunId: runId, event }),
  });
}