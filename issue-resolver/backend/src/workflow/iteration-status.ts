import { eq } from 'drizzle-orm';
import { TaskStatus } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { issues, iterations } from '../db/schema';
import { messageOf } from '../util/errors';
import type { IterationRunDeps, RunIssueIterationInput } from './service-contracts';
import { iterationStatusEvent } from './sse-events';
import { nowIso } from '../db/rows';

export function setIterationStatus(
  db: Db,
  iterationId: string,
  status: TaskStatus,
  at: string,
): void {
  db.update(iterations)
    .set({ status, updated_at: at })
    .where(eq(iterations.id, iterationId))
    .run();
}

export function setIssueStatus(
  db: Db,
  issueId: string,
  status: TaskStatus,
  at: string,
): void {
  db.update(issues)
    .set({ status, updated_at: at })
    .where(eq(issues.id, issueId))
    .run();
}

export function publishIterationStatus(
  deps: IterationRunDeps,
  issueId: string,
  iterationId: string,
  status: TaskStatus,
  options: { needsInput?: boolean; error?: string; ts: string },
): void {
  deps.sse.publish(iterationStatusEvent(issueId, iterationId, status, options));
}

export function markIterationRunning(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): void {
  const at = nowIso();
  setIterationStatus(db, input.iteration.id, TaskStatus.running, at);
  setIssueStatus(db, input.issue.id, TaskStatus.running, at);
  publishIterationStatus(deps, input.issue.id, input.iteration.id, TaskStatus.running, {
    ts: at,
  });
}

export function markIterationCrashed(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
  error: unknown,
): string {
  const at = nowIso();
  const message = messageOf(error);
  setIterationStatus(db, input.iteration.id, TaskStatus.failed, at);
  setIssueStatus(db, input.issue.id, TaskStatus.failed, at);
  publishIterationStatus(deps, input.issue.id, input.iteration.id, TaskStatus.failed, {
    error: message,
    ts: at,
  });
  return message;
}