import type { ExecutionPlan, StepReport } from '@issue-resolver/shared';
import { PipelineStep, SessionNoticeLevel } from '@issue-resolver/shared';
import {
  MAX_SELF_RETRIES,
  REFINED_PLAN_CHAR_LIMIT,
  executionPlanProblem,
} from '@issue-resolver/shared';
import type { WorkflowDeps } from './contracts';
import type { ExpandedPlan } from '../plan-brief';
import { planShapeWarnings, readExpandedPlan } from '../plan-brief';
import { noticeEvent, stepEvent } from '../sse-events';

export interface RefineOutcome {
  refinedPlan: string | null;
  refinedExecution: ExecutionPlan | null;
  planProblem: string | null;
  maxPlanAttempts: number;
}

export interface RefineReportInput {
  deps: WorkflowDeps;
  issueId: string;
  iterationId: string;
  stepRunId: string;
  agentWorkingDir: string;
  workspaceHostDir: string;
  steps: PipelineStep[];
  maxExecutors: number;
  report: StepReport | null;
}

const MALFORMED_EXECUTION =
  'execution is present but unreadable — mode must be single or stages';

const notice = (
  deps: WorkflowDeps,
  issueId: string,
  iterationId: string,
  stepRunId: string,
  level: SessionNoticeLevel,
  message: string,
): void => {
  deps.sse.publish(
    stepEvent(issueId, iterationId, stepRunId, noticeEvent(level, message)),
  );
};

function refinedPlanText(
  expandedPlan: ExpandedPlan | null,
  fallback: string | null,
): string | null {
  if (!expandedPlan) return fallback;
  if (!expandedPlan.truncated) return expandedPlan.text;
  return `${expandedPlan.text}\n[plan.md is longer than ${REFINED_PLAN_CHAR_LIMIT} characters — read the full brief from plan.md in the working folder]`;
}

export async function applyRefineReport(
  input: RefineReportInput,
): Promise<RefineOutcome> {
  const { deps, issueId, iterationId, stepRunId, report } = input;
  const expandedPlan =
    (await readExpandedPlan(input.agentWorkingDir)) ??
    (await readExpandedPlan(input.workspaceHostDir));
  const refinedPlan = refinedPlanText(expandedPlan, report?.summary ?? null);
  for (const message of planShapeWarnings(expandedPlan?.text ?? null)) {
    notice(deps, issueId, iterationId, stepRunId, SessionNoticeLevel.warning, message);
  }
  if (expandedPlan?.truncated) {
    notice(
      deps,
      issueId,
      iterationId,
      stepRunId,
      SessionNoticeLevel.warning,
      `plan.md длиннее ${REFINED_PLAN_CHAR_LIMIT} символов — в промпт исполнителя вошло начало брифа, полный план он читает из plan.md.`,
    );
  }

  const refinedExecution = report?.execution ?? null;
  const executionMalformed = report?.executionMalformed === true;
  if (
    refinedExecution === null &&
    !executionMalformed &&
    input.steps.includes(PipelineStep.resolve)
  ) {
    notice(
      deps,
      issueId,
      iterationId,
      stepRunId,
      SessionNoticeLevel.warning,
      'refine не вернул execution-план — resolve пойдёт одним агентом (single). Задача больше одного рабочего набора — планировщик обязан вернуть stages.',
    );
    console.warn(
      `refine step run ${stepRunId}: no execution plan — resolve runs as single`,
    );
  }

  return {
    refinedPlan,
    refinedExecution,
    planProblem: executionMalformed
      ? MALFORMED_EXECUTION
      : executionPlanProblem(refinedExecution, input.maxExecutors),
    maxPlanAttempts: MAX_SELF_RETRIES.refine ?? 0,
  };
}