import type { StepRunStatus } from '../status';

/** Body fields describing the latest step run of an issue (report or devops). */
export interface RunStatusPayload {
  runId?: string;
  runStatus?: StepRunStatus;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  feedback?: string;
}
