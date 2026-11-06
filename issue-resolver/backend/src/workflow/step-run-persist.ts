import type { SessionEvent, SessionStats, StepRunStatus } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { createStepOutput, updateStepRun } from '../db/step-runs.repo';

export interface StepRunResultInput {
  label: string;
  status: StepRunStatus;
  feedback: string | null;
  report: unknown;
  stdout: string;
  stderr: string;
  events: SessionEvent[];
  stats: SessionStats | null;
}

export async function persistStepRunResult(
  db: Db,
  stepRunId: string,
  input: StepRunResultInput,
): Promise<void> {
  try {
    await updateStepRun(db, stepRunId, {
      status: input.status,
      feedback: input.feedback,
    });
    await createStepOutput(db, {
      stepRunId,
      report: JSON.stringify(input.report),
      stdout: input.stdout,
      stderr: input.stderr,
      events: input.events,
      stats: input.stats,
    });
  } catch (error) {
    console.error(`${input.label} run persistence failed`, {
      stepRunId,
      error,
    });
  }
}
