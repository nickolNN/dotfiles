import type { StepRunStatus } from '@issue-resolver/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Db } from './client';
import { issues, iterations, stepRuns } from './schema';

const INTERRUPTED_STEP_STATUSES: StepRunStatus[] = [
  'pending',
  'running',
  'needs_input',
];

export function reconcileInterruptedRuns(db: Db): void {
  const now = new Date().toISOString();

  const interrupted = db
    .select({ id: stepRuns.id })
    .from(stepRuns)
    .where(inArray(stepRuns.status, INTERRUPTED_STEP_STATUSES))
    .all();

  if (interrupted.length > 0) {
    db.update(stepRuns)
      .set({
        status: 'failed',
        feedback: 'interrupted by server restart',
        updated_at: now,
      })
      .where(inArray(stepRuns.status, INTERRUPTED_STEP_STATUSES))
      .run();
  }

  const interruptedIterations = db
    .select({ id: iterations.id, issueId: iterations.issue_id })
    .from(iterations)
    .innerJoin(issues, eq(issues.id, iterations.issue_id))
    .where(
      or(
        inArray(iterations.status, ['running', 'preparing']),
        and(eq(iterations.status, 'pending'), eq(issues.status, 'preparing')),
      ),
    )
    .all();

  if (interruptedIterations.length > 0) {
    db.update(iterations)
      .set({ status: 'failed', updated_at: now })
      .where(
        inArray(
          iterations.id,
          interruptedIterations.map((row) => row.id),
        ),
      )
      .run();

    const issueIds = [
      ...new Set(interruptedIterations.map((row) => row.issueId)),
    ];
    if (issueIds.length > 0) {
      db.update(issues)
        .set({ status: 'failed', updated_at: now })
        .where(
          and(
            inArray(issues.id, issueIds),
            inArray(issues.status, ['running', 'preparing', 'question']),
          ),
        )
        .run();
    }
  }

  if (interrupted.length > 0 || interruptedIterations.length > 0) {
    console.error(
      `[reconcile] interrupted by restart: ${interrupted.length} step_run(s) → failed, ${interruptedIterations.length} iteration(s) → failed`,
    );
  }

  const stalePending = db
    .select({ issueId: iterations.issue_id })
    .from(iterations)
    .innerJoin(issues, eq(issues.id, iterations.issue_id))
    .where(
      and(
        eq(iterations.status, 'pending'),
        inArray(issues.status, ['completed', 'failed']),
      ),
    )
    .all();

  if (stalePending.length > 0) {
    const ids = [...new Set(stalePending.map((row) => row.issueId))];
    db.update(issues)
      .set({ status: 'pending', updated_at: now })
      .where(inArray(issues.id, ids))
      .run();
    console.error(
      `[reconcile] stale pending iteration(s) in completed/failed issue(s): ${ids.length} issue(s) → pending`,
    );
  }
}