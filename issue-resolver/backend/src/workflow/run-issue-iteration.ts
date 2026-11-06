import { and, eq } from 'drizzle-orm';
import { TaskStatus } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { iterations } from '../db/schema';
import { DEFAULT_WORKSPACE_ROOT } from '../workspace/paths';
import { runIteration } from './engine';
import type {
  IterationTerminalOutcome,
  RunIterationResult,
} from './iteration/contracts';
import { startNextPendingIteration } from './iteration-queue';
import {
  buildIterationRow,
  buildRunIterationInput,
  buildWorkflowDeps,
} from './iteration-run-input';
import {
  markIterationCrashed,
  markIterationRunning,
  publishIterationStatus,
  setIssueStatus,
  setIterationStatus,
} from './iteration-status';
import { restartDevServerForIteration } from './iteration-dev-server';
import { writeIterationReport } from './iteration-report';
import { upsertMergeRequestsFromResultJson } from './merge-requests';
import { spawnReportAgent } from './report-spawn';
import { snapshotIterationResult } from './result-snapshot';
import type { IterationRunDeps, RunIssueIterationInput } from './service-contracts';
import { nowIso } from '../db/rows';

export async function runIssueIteration(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): Promise<RunIterationResult> {
  const iteration = buildIterationRow(input);
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;

  await restartDevServerForIteration(db, deps, input);
  markIterationRunning(db, deps, input);

  const runInput = await buildRunIterationInput(db, deps, input, iteration);

  let result: RunIterationResult;
  let reportOutcome: IterationTerminalOutcome | null = null;
  try {
    result = await runIteration(
      buildWorkflowDeps(db, deps, input, (outcome) => {
        reportOutcome = outcome;
      }),
      runInput,
    );
  } catch (error) {
    console.error('runIteration failed', error);
    markIterationCrashed(db, deps, input, error);
    await writeIterationReport(db, deps, input, TaskStatus.failed);
    void upsertMergeRequestsFromResultJson(db, workspaceRoot, input.issue.id).catch(
      (error) => console.error('upsertMergeRequests failed', error),
    );
    return { iterationStatus: TaskStatus.failed, needsInput: false };
  }

  if (result.iterationStatus === TaskStatus.completed) {
    await snapshotIterationResult(
      workspaceRoot,
      input.issue.id,
      input.iteration.id,
    );
  }

  if (reportOutcome) {
    void spawnReportAgent(db, deps, reportOutcome);
  }

  const finishedAt = nowIso();
  setIterationStatus(db, input.iteration.id, result.iterationStatus, finishedAt);

  const hasNextPending = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, input.issue.id),
        eq(iterations.status, TaskStatus.pending),
      ),
    )
    .get();

  const issueStatus = hasNextPending ? TaskStatus.pending : result.iterationStatus;
  setIssueStatus(db, input.issue.id, issueStatus, finishedAt);

  void upsertMergeRequestsFromResultJson(db, workspaceRoot, input.issue.id).catch(
    (error) => console.error('upsertMergeRequests failed', error),
  );

  publishIterationStatus(
    deps,
    input.issue.id,
    input.iteration.id,
    result.iterationStatus,
    { needsInput: result.needsInput, ts: finishedAt },
  );

  await writeIterationReport(db, deps, input, result.iterationStatus);

  void startNextPendingIteration(db, deps, input.issue.id).catch((error) =>
    console.error(
      `[queue] startNextPendingIteration failed for issue ${input.issue.id}`,
      error,
    ),
  );

  return result;
}