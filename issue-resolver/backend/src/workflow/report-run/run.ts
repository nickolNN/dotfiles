import {
  IssueRunKind,
  PipelineStep,
  SessionAddress,
  StepRunStatus,
  stepRunOutcome,
} from '@issue-resolver/shared';
import {
  issueSessionDir,
  sessionDisplayName,
} from '../../pi/session-paths';
import { runTarget } from '../../pi/session-registry';
import { soloRunExcludeTools } from '../../pi/tool-policy';
import { stallRecoveries } from '../../pi/stall-recovery';
import { describeReportArtifacts } from '../report-archive';
import { STEP_SYSTEM_APPEND } from '../prompts';
import { STEP_FAILURE_TEXT } from '../step-failure';
import {
  resolveAgentStallTimeoutMs,
  withAgentStallGuard,
} from '../timeout';
import { stepStatusEvent } from '../sse-events';
import { beginReportRun, recordReportRun } from './prepare';
import { createReportSession } from './step-session';
import { settleReportRun } from './settle';
import { isReportRunActive } from './tracking';
import { skipIfActive } from '../../util/active-runs';
import type {
  ReportRunDeps,
  ReportRunState,
  RunReportAgentInput,
} from './types';

export async function runReportAgent(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
): Promise<void> {
  const reportRunId = SessionAddress.forIssueRun(
    input.issueId,
    IssueRunKind.report,
  ).toString();

  if (
    skipIfActive(isReportRunActive, IssueRunKind.report, input.issueId, input.trigger)
  ) {
    return;
  }

  const stepRunId = await recordReportRun(deps, input);
  if (stepRunId === null) return;

  const begun = beginReportRun(deps, input, reportRunId, stepRunId);
  if (!begun.ok) {
    await begun.done;
    return;
  }
  const { startedAt } = begun;

  const state: ReportRunState = {
    status: StepRunStatus.failed,
    failure: undefined,
    anchorPath: null,
  };
  const session = createReportSession({
    deps,
    input,
    stepRunId,
    reportRunId,
    onAnchor: (path) => {
      state.anchorPath = path;
    },
  });

  try {
    const reportRun = deps.pi.run(input.containerName, input.prompt, {
      cwd: input.hostDir,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      stepRunId: reportRunId,
      issueId: input.issueId,
      registry: deps.control,
      sessionDir: issueSessionDir(input.issueId),
      excludeTools: soloRunExcludeTools(),
      systemAppend: STEP_SYSTEM_APPEND,
      sessionName: sessionDisplayName({
        step: PipelineStep.report,
        issueId: input.issueId,
      }),
      ...session.callbacks,
    });
    const stallMs = resolveAgentStallTimeoutMs();
    const result = await withAgentStallGuard(reportRun, {
      stallMs,
      label: 'report agent',
      activity: () => session.activity(),
      recover: stallRecoveries({
        control: deps.control,
        target: runTarget(reportRunId),
        graceMs: stallMs,
      }),
      onStall: () => {
        void deps.control?.send(runTarget(reportRunId), {
          type: 'abort_retry',
        });
        deps.control?.abort(reportRunId);
      },
    });
    state.observedModel = result.stats?.model ?? undefined;
    session.setStats(result.stats ?? null);
    const outcome = stepRunOutcome({
      exitCode: result.exitCode,
      report: result.report,
      modelReplied: result.modelReplied,
      requiresStepReport: false,
      aborted: result.aborted,
    });
    state.status =
      outcome.status === StepRunStatus.success
        ? StepRunStatus.success
        : StepRunStatus.failed;
    if (state.status === StepRunStatus.failed) {
      state.failure =
        outcome.failure === null
          ? `exit status: ${outcome.status}`
          : STEP_FAILURE_TEXT[outcome.failure];
    }
  } catch (error) {
    state.failure = error;
    state.status = StepRunStatus.failed;
  } finally {
    await settleReportRun(deps, input, {
      session,
      stepRunId,
      startedAt,
      state,
    });
  }

  deps.sse.publish(
    stepStatusEvent(input.issueId, reportRunId, state.status),
  );
  const durationMs = Date.now() - startedAt;
  if (state.status === StepRunStatus.success) {
    console.log(
      `report agent finished: issue=${input.issueId} trigger=${input.trigger ?? 'unknown'} durationMs=${durationMs} artifacts: ${describeReportArtifacts(input.hostDir)}`,
    );
    return;
  }
  console.error('report agent failed', {
    issueId: input.issueId,
    durationMs,
    error: state.failure,
  });
}