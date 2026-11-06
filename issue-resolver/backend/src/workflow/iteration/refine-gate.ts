import type {
  ExecutionPlan,
  StepReport,
} from '@issue-resolver/shared';
import {
  PipelineStep,
  SessionNoticeLevel,
  StepRunStatus,
} from '@issue-resolver/shared';
import { noticeEvent, stepEvent, stepStatusEvent } from '../sse-events';
import type { WorkflowDeps } from './contracts';
import { applyRefineReport } from './refine-outcome';
import { refineRejectedFeedback } from './retry-feedback';

export interface RefineGateInput {
  deps: WorkflowDeps;
  issueId: string;
  iterationId: string;
  stepRunId: string;
  agentWorkingDir: string;
  workspaceHostDir: string;
  steps: PipelineStep[];
  maxExecutors: number;
  report: StepReport | null;
  stepRetries: number;
}

export const RefineGateKind = Object.freeze({
  planned: 'planned',
  retry: 'retry',
  failed: 'failed',
} as const);
export type RefineGateKind =
  (typeof RefineGateKind)[keyof typeof RefineGateKind];

export type RefineGate =
  | {
      kind: typeof RefineGateKind.planned;
      refinedPlan: string | null;
      refinedExecution: ExecutionPlan | null;
    }
  | { kind: typeof RefineGateKind.retry; feedback: string }
  | { kind: typeof RefineGateKind.failed };

export async function applyRefineGate(
  input: RefineGateInput,
): Promise<RefineGate> {
  const { deps, issueId, iterationId, stepRunId } = input;
  const refine = await applyRefineReport({
    deps,
    issueId,
    iterationId,
    stepRunId,
    agentWorkingDir: input.agentWorkingDir,
    workspaceHostDir: input.workspaceHostDir,
    steps: input.steps,
    maxExecutors: input.maxExecutors,
    report: input.report,
  });

  if (refine.planProblem === null) {
    return {
      kind: RefineGateKind.planned,
      refinedPlan: refine.refinedPlan,
      refinedExecution: refine.refinedExecution,
    };
  }

  const message = `refine: execution-план отклонён — ${refine.planProblem}.`;
  const stopNotice = input.steps.includes(PipelineStep.resolve)
    ? 'итерация остановлена, resolve не запускался'
    : 'итерация остановлена';
  await deps.store.updateStepRun(stepRunId, {
    status: StepRunStatus.failed,
    feedback: message,
  });
  deps.sse.publish(
    stepStatusEvent(issueId, stepRunId, StepRunStatus.failed, { iterationId }),
  );
  if (input.stepRetries < refine.maxPlanAttempts) {
    const next = input.stepRetries + 1;
    deps.sse.publish(
      stepEvent(
        issueId,
        iterationId,
        stepRunId,
        noticeEvent(
          SessionNoticeLevel.warning,
          `${message} Перепланирование ${next}/${refine.maxPlanAttempts}.`,
        ),
      ),
    );
    return {
      kind: RefineGateKind.retry,
      feedback: refineRejectedFeedback(refine.planProblem),
    };
  }

  deps.sse.publish(
    stepEvent(
      issueId,
      iterationId,
      stepRunId,
      noticeEvent(
        SessionNoticeLevel.error,
        `${message} бюджет перепланирования исчерпан (${refine.maxPlanAttempts} повторов refine) — ${stopNotice}.`,
      ),
    ),
  );
  return { kind: RefineGateKind.failed };
}