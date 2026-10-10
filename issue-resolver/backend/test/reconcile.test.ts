import { randomUUID } from 'node:crypto';
import type { StepRunStatus } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { reconcileInterruptedRuns } from '../src/db/reconcile';
import { issues, iterations, stepRuns } from '../src/db/schema';

const NOW = '2026-06-01T00:00:00.000Z';

function newId(): string {
  return randomUUID();
}

function insertIssue(db: Db, status: 'running' | 'completed'): string {
  const id = newId();
  db.insert(issues)
    .values({
      id,
      title: 'Задача примирения',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status,
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return id;
}

function insertIteration(
  db: Db,
  issueId: string,
  status: 'running' | 'completed',
): string {
  const id = newId();
  db.insert(iterations)
    .values({
      id,
      issue_id: issueId,
      number: 1,
      context: '',
      steps: ['resolve'],
      status,
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return id;
}

function insertStepRun(
  db: Db,
  iterationId: string,
  status: StepRunStatus,
  attempt: number,
): string {
  const id = newId();
  db.insert(stepRuns)
    .values({
      id,
      iteration_id: iterationId,
      step: 'resolve',
      attempt,
      status,
      context: 'ctx',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return id;
}

describe('reconcileInterruptedRuns', () => {
  it('переводит прерванные шаги в failed с feedback, итерацию и задачу в failed', () => {
    const db = createDb(':memory:');
    const issueId = insertIssue(db, 'running');
    const iterationId = insertIteration(db, issueId, 'running');
    insertStepRun(db, iterationId, 'running', 1);
    insertStepRun(db, iterationId, 'pending', 2);
    insertStepRun(db, iterationId, 'needs_input', 3);
    insertStepRun(db, iterationId, 'success', 4);
    insertStepRun(db, iterationId, 'failed', 5);

    reconcileInterruptedRuns(db);

    const runStatuses = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, iterationId))
      .all();

    const interrupted = runStatuses.filter(
      (row) => row.feedback === 'interrupted by server restart',
    );
    expect(interrupted).toHaveLength(3);
    expect(interrupted.every((row) => row.status === 'failed')).toBe(true);

    // Завершённые шаги не трогаются: 'success' остаётся, пре-существующий
    // 'failed' не получает feedback о рестарте.
    const success = runStatuses.find((row) => row.status === 'success');
    expect(success?.feedback).toBeNull();
    const preexistingFailed = runStatuses.filter(
      (row) => row.status === 'failed' && row.feedback === null,
    );
    expect(preexistingFailed).toHaveLength(1);

    const iteration = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, iterationId))
      .get();
    expect(iteration?.status).toBe('failed');

    const issue = db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .get();
    expect(issue?.status).toBe('failed');
  });

  it('не трогает завершённые итерации, их шаги и задачи', () => {
    const db = createDb(':memory:');
    const issueId = insertIssue(db, 'completed');
    const iterationId = insertIteration(db, issueId, 'completed');
    insertStepRun(db, iterationId, 'success', 1);
    const otherIssueId = insertIssue(db, 'completed');
    insertIteration(db, otherIssueId, 'completed');

    reconcileInterruptedRuns(db);

    const iteration = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, iterationId))
      .get();
    expect(iteration?.status).toBe('completed');

    const runs = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.iteration_id, iterationId))
      .all();
    expect(runs.every((row) => row.status === 'success')).toBe(true);

    const issue = db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .get();
    expect(issue?.status).toBe('completed');
  });

  it('не трогает окончательно завершённый шаг у running-итерации (только прерванные)', () => {
    const db = createDb(':memory:');
    const issueId = insertIssue(db, 'running');
    const iterationId = insertIteration(db, issueId, 'running');
    const doneStep = insertStepRun(db, iterationId, 'success', 1);
    insertStepRun(db, iterationId, 'running', 2);

    reconcileInterruptedRuns(db);

    const doneAfter = db.select().from(stepRuns).where(eq(stepRuns.id, doneStep)).get();
    expect(doneAfter?.status).toBe('success');
  });
});