import { PipelineStep, SessionNoticeLevel } from '@issue-resolver/shared';
import type {
  SessionEvent,
  StepExecutionResult,
  StepReport,
  StepRun,
} from '@issue-resolver/shared';
import {
  StepReportStatus,
  StepRunStatus,
  stepRunOutcome,
  type StepRunOutcome,
} from '@issue-resolver/shared';
import { formatPrPublishErrors } from '../../pr/mr';
import type { GitPrepareResult } from '../../git/service';
import { failureReportOverride } from '../step-failure';
import {
  readStepReportFile,
  screenshotsDirOf,
  stepReportContractPath,
  type StepReportMtimes,
} from '../step-report';
import { noticeEvent, stepEvent, stepStatusEvent, streamEvent } from '../sse-events';
import type { RunIterationInput, WorkflowDeps } from './contracts';
import {
  publishPrResult,
  type PrPublishOutcome,
} from '../pr-publish';
import { messageOf } from '../../util/errors';
import { SSEStream } from '@issue-resolver/shared';

export interface StepReportResolution {
  report: StepReport | null;
  status: StepRunStatus;
}

export async function resolveStepReport(input: {
  deps: WorkflowDeps;
  issueId: string;
  iterationId: string;
  step: PipelineStep;
  stepRunId: string;
  workspaceHostDir: string;
  reportsBefore: StepReportMtimes;
  result: StepExecutionResult;
}): Promise<StepReportResolution> {
  const { deps, issueId, iterationId, step, stepRunId } = input;
  const source = await readStepReportFile(
    input.workspaceHostDir,
    input.reportsBefore,
  );
  const rawReport = source?.report ?? input.result.report;
  const contractPath = stepReportContractPath(input.workspaceHostDir);
  if (source !== null && source.path !== contractPath) {
    const message = `step result written to ${source.path} instead of ${contractPath} (the contract path)`;
    console.error(`workflow: step '${step}' (${stepRunId}): ${message}`);
    deps.sse.publish(
      streamEvent(issueId, iterationId, stepRunId, SSEStream.system, message),
    );
  }

  const outcome: StepRunOutcome = stepRunOutcome({
    exitCode: input.result.exitCode,
    report: rawReport,
    modelReplied: input.result.modelReplied,
    aborted: input.result.aborted,
  });
  const failureReport = failureReportOverride(outcome, rawReport);
  const report: StepReport | null = failureReport ?? rawReport;
  if (failureReport !== null) {
    console.error(`workflow: step '${step}' (${stepRunId}): ${outcome.failure}`);
    deps.sse.publish(
      stepEvent(
        issueId,
        iterationId,
        stepRunId,
        noticeEvent(SessionNoticeLevel.error, failureReport.summary),
      ),
    );
  }
  return { report, status: outcome.status };
}

export interface StepCompletionInput {
  deps: WorkflowDeps;
  input: RunIterationInput;
  step: PipelineStep;
  stepRun: StepRun;
  status: StepRunStatus;
  workspaceHostDir: string;
  repoWorkspaces: GitPrepareResult['repoWorkspaces'];
  result: StepExecutionResult;
  report: StepReport | null;
}

const prNoTargetEvent = (
  input: StepCompletionInput,
): SessionEvent | null =>
  input.step === PipelineStep.pr &&
  input.status === StepRunStatus.success &&
  input.repoWorkspaces.length > 0 &&
  !input.repoWorkspaces.some((workspace) =>
    input.input.repositories.some(
      (repo) =>
        repo.repository_url === workspace.repoUrl && (repo.create_mr ?? false),
    ),
  )
    ? noticeEvent(
        SessionNoticeLevel.warning,
        'pr-шаг: ни один репозиторий не отмечен для MR (create_mr = false у всех) — ветки и MR не создавались, результат остался файлами в рабочей папке.',
      )
    : null;

export async function recordStepCompletion(
  input: StepCompletionInput,
): Promise<void> {
  const { deps, step, stepRun, status, report, result } = input;
  const { issue, iteration } = input.input;
  const issueId = issue.id;
  const iterationId = iteration.id;

  let prPublish: PrPublishOutcome | null = null;
  if (
    step === PipelineStep.pr &&
    status === StepRunStatus.success &&
    input.repoWorkspaces.length > 0
  ) {
    try {
      prPublish = await publishPrResult(
        deps,
        input.input,
        input.repoWorkspaces,
        report?.title || issue.title,
        report?.description || report?.summary || '',
        stepRun.id,
        report?.merge_requests,
      );
    } catch (error) {
      const message = messageOf(error);
      console.error('publishPrResult failed', error);
      prPublish = { artifacts: [], errors: [{ repositoryUrl: '', message }] };
    }
  }

  const prNoTargetNotice = prNoTargetEvent(input);

  const prErrors = prPublish?.errors ?? [];
  const prErrorMessage = formatPrPublishErrors(prErrors);
  const outputEvents: SessionEvent[] = [
    ...(result.events ?? []),
    ...(prNoTargetNotice ? [prNoTargetNotice] : []),
    ...prErrors.map((error) =>
      noticeEvent(
        SessionNoticeLevel.error,
        `Публикация MR/ветки не удалась — ${error.message}`,
      ),
    ),
  ];
  const persistedReport: StepReport | null =
    prErrors.length > 0
      ? {
          ...(report ?? { status: StepReportStatus.pass, summary: '' }),
          pr_error: prErrorMessage,
        }
      : report;

  const screenshotsDir = await screenshotsDirOf(input.workspaceHostDir);
  await deps.store.createStepOutput({
    stepRunId: stepRun.id,
    report: persistedReport ? JSON.stringify(persistedReport) : '',
    ...(screenshotsDir ? { screenshotsDir } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    events: outputEvents,
    stats: result.stats ?? null,
  });
  deps.sse.publish(stepStatusEvent(issueId, stepRun.id, status, { iterationId }));
  if (prNoTargetNotice) {
    deps.sse.publish(
      stepEvent(issueId, iterationId, stepRun.id, prNoTargetNotice),
    );
  }

  if (prErrors.length > 0) {
    await deps.store.updateStepRun(stepRun.id, {
      status: StepRunStatus.failed,
    });
    deps.sse.publish(
      stepStatusEvent(issueId, stepRun.id, StepRunStatus.failed, { iterationId }),
    );
    for (const error of prErrors) {
      deps.sse.publish(
        stepEvent(
          issueId,
          iterationId,
          stepRun.id,
          noticeEvent(
            SessionNoticeLevel.error,
            `Публикация MR/ветки не удалась — ${error.message}`,
          ),
        ),
      );
    }
  }
}
export interface StepCrashInput {
  deps: WorkflowDeps;
  issueId: string;
  iterationId: string;
  step: PipelineStep;
  stepRun: StepRun;
  error: unknown;
}

export async function recordStepCrash(input: StepCrashInput): Promise<string> {
  const { deps, issueId, iterationId, step, stepRun } = input;
  const message = messageOf(input.error);
  console.error(
    `workflow: pi agent for step '${step}' failed or timed out`,
    input.error,
  );
  await deps.store.updateStepRun(stepRun.id, { status: StepRunStatus.failed });
  await deps.store.createStepOutput({
    stepRunId: stepRun.id,
    report: JSON.stringify({
      status: StepReportStatus.fail,
      summary:
        step === PipelineStep.resolve
          ? 'resolve agent failed/hung'
          : `${step} agent failed/hung`,
    }),
    stdout: '',
    stderr: message,
    events: [],
    stats: null,
  });
  deps.sse.publish(
    stepStatusEvent(issueId, stepRun.id, StepRunStatus.failed, { iterationId }),
  );
  return message;
}
