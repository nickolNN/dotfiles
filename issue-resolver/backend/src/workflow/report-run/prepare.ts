import { join } from 'node:path';
import { PipelineStep, StepRunStatus } from '@issue-resolver/shared';
import {
  createStepRun,
  listStepRunsByIssue,
  updateStepRun,
} from '../../db/step-runs.repo';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceHostDirFor,
} from '../../workspace/paths';
import {
  archiveReportArtifacts,
  archiveReportSession,
} from '../report-archive';
import { stepStatusEvent } from '../sse-events';
import { persistStepRunResult } from '../step-run-persist';
import { markReportRunActive, recordReportOutcome } from './tracking';
import type { ReportRunDeps, RunReportAgentInput } from './types';
import { messageOf } from '../../util/errors';

export type BeginReportRun =
  | { ok: true; startedAt: number }
  | { ok: false; done: Promise<void> };

export async function recordReportRun(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
): Promise<string | null> {
  try {
    const previous = await listStepRunsByIssue(deps.db, input.issueId);
    const stepRun = await createStepRun(deps.db, {
      issueId: input.issueId,
      iterationId: null,
      step: PipelineStep.report,
      attempt: previous.filter((run) => run.step === PipelineStep.report).length + 1,
      context: input.trigger ?? 'report',
    });
    await updateStepRun(deps.db, stepRun.id, { status: StepRunStatus.running });
    return stepRun.id;
  } catch (error) {
    console.error('report run record failed', {
      issueId: input.issueId,
      error,
    });
    return null;
  }
}

export function beginReportRun(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
  reportRunId: string,
  stepRunId: string,
): BeginReportRun {
  let archive;
  try {
    archive = archiveReportArtifacts(deps.workspaceRoot, input.issueId);
  } catch (error) {
    return { ok: false, done: failArchived(deps, input, reportRunId, stepRunId, error) };
  }

  const startedAt = Date.now();
  const staleSessions = archiveSession(deps, input, reportRunId, startedAt);
  console.log(
    `report agent started: issue=${input.issueId} trigger=${input.trigger ?? 'unknown'}${input.origin ? ` origin=${input.origin}` : ''} archived=${archive.dir ?? 'none'} files=[${archive.files.join(', ')}] sessionReset=[${staleSessions.join(', ')}] at=${new Date(startedAt).toISOString()}`,
  );
  deps.sse.publish(
    stepStatusEvent(input.issueId, reportRunId, StepRunStatus.running, {
      step: PipelineStep.report,
      model: input.model ?? null,
    }),
  );
  markReportRunActive(input.issueId);
  return { ok: true, startedAt };
}

async function failArchived(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
  reportRunId: string,
  stepRunId: string,
  error: unknown,
): Promise<void> {
  console.error('report artifacts archive failed', {
    issueId: input.issueId,
    error,
  });
  recordReportOutcome(input.issueId, true);
  deps.sse.publish(
    stepStatusEvent(input.issueId, reportRunId, StepRunStatus.failed),
  );
  await persistStepRunResult(deps.db, stepRunId, {
    label: 'report',
    status: StepRunStatus.failed,
    feedback: `archive failed: ${messageOf(error)}`,
    report: { artifacts: { md: false, html: false } },
    stdout: '',
    stderr: '',
    events: [],
    stats: null,
  });
}

function archiveSession(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
  reportRunId: string,
  startedAt: number,
): string[] {
  try {
    return archiveReportSession(
      input.issueId,
      reportRunId,
      join(
        workspaceHostDirFor(
          deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
          input.issueId,
        ),
        'reports',
        new Date(startedAt).toISOString(),
        'session',
      ),
    );
  } catch (error) {
    console.error('report session archive failed', {
      issueId: input.issueId,
      error,
    });
    return [];
  }
}