import type {
  IssueRunKind,
  RunStatusPayload,
  StepRun,
} from '@issue-resolver/shared';
import { RunState, StepRunStatus } from '@issue-resolver/shared';
import type { Db } from '../../db/client';
import { getLatestStepRunForIssue, updateStepRun } from '../../db/step-runs.repo';
import { isSessionStale, quietMinutes } from '../../pi/session-liveness';

export async function abortStaleRun(
  db: Db,
  run: StepRun | null | undefined,
  options: { label: IssueRunKind; active: boolean; now: number },
): Promise<void> {
  if (!run || run.status !== StepRunStatus.running || options.active) return;
  if (!isSessionStale(run.updated_at, options.now)) return;
  const minutes = quietMinutes(run.updated_at, options.now);
  const feedback = `${options.label} failed: нет активности ${minutes} мин — прогон прерван`;
  await updateStepRun(db, run.id, { status: StepRunStatus.failed, feedback });
  run.status = StepRunStatus.failed;
  run.feedback = feedback;
}

export function statusFromRun(
  run: StepRun | null | undefined,
  active: boolean,
): RunState | null {
  if (active) return RunState.running;
  if (!run) return null;
  if (run.status === StepRunStatus.success) return RunState.success;
  if (run.status === StepRunStatus.failed) return RunState.failed;
  return RunState.running;
}

export function runStatusPayload(
  run: StepRun | null | undefined,
): RunStatusPayload {
  if (!run) return {};
  const terminal =
    run.status === StepRunStatus.success || run.status === StepRunStatus.failed;
  return {
    runId: run.id,
    runStatus: run.status,
    startedAt: run.created_at,
    ...(terminal ? { finishedAt: run.updated_at } : {}),
    updatedAt: run.updated_at,
    ...(run.feedback ? { feedback: run.feedback } : {}),
  };
}