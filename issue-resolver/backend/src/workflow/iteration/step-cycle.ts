import type {
  ExecutionPlan,
  PipelineStep,
  StepReport,
  StepExecutionResult,
  StepRun,
  ThinkingLevel,
} from '@issue-resolver/shared';
import { StepRunStatus } from '@issue-resolver/shared';
import { stepReportMtimes } from '../step-report';
import { stepStatusEvent } from '../sse-events';
import { executeStepAgent, type StepExecutionPlan } from './step-execution';
import { recordStepCompletion, recordStepCrash, resolveStepReport } from './step-completion';

export interface StepAttemptArgs {
  step: PipelineStep;
  attempt: number;
  feedback: string | null;
  refinedPlan: string | null;
  refinedExecution: ExecutionPlan | null;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface StepAttempt {
  stepRun: StepRun;
  result: StepExecutionResult;
  report: StepReport | null;
  status: StepRunStatus;
  agentWorkingDir: string;
}

export type StepAttemptOutcome =
  | { kind: 'ok'; attempt: StepAttempt }
  | { kind: 'crashed'; message: string };

export async function runStepAttempt(
  plan: StepExecutionPlan,
  args: StepAttemptArgs,
): Promise<StepAttemptOutcome> {
  const { deps, input } = plan;
  const { issue, iteration } = input;
  const { step, model, thinkingLevel } = args;

  const stepRun = await deps.store.createStepRun({
    issueId: issue.id,
    iterationId: iteration.id,
    step,
    attempt: args.attempt,
    context: iteration.context,
  });
  await deps.store.updateStepRun(stepRun.id, { status: StepRunStatus.running });
  deps.sse.publish(
    stepStatusEvent(issue.id, stepRun.id, StepRunStatus.running, {
      iterationId: iteration.id,
      step,
      model: model ?? null,
    }),
  );

  const reportsBefore = await stepReportMtimes(plan.workspaceHostDir);

  let execution: Awaited<ReturnType<typeof executeStepAgent>>;
  try {
    execution = await executeStepAgent(plan, {
      step,
      stepRun,
      attempt: args.attempt,
      feedback: args.feedback,
      refinedPlan: args.refinedPlan,
      refinedExecution: args.refinedExecution,
      model,
      thinkingLevel,
    });
  } catch (error) {
    const message = await recordStepCrash({
      deps,
      issueId: issue.id,
      iterationId: iteration.id,
      step,
      stepRun,
      error,
    });
    return { kind: 'crashed', message };
  }

  const { result, agentWorkingDir } = execution;
  const { report, status } = await resolveStepReport({
    deps,
    issueId: issue.id,
    iterationId: iteration.id,
    step,
    stepRunId: stepRun.id,
    workspaceHostDir: plan.workspaceHostDir,
    reportsBefore,
    result,
  });
  await deps.store.updateStepRun(stepRun.id, { status });
  await recordStepCompletion({
    deps,
    input,
    step,
    stepRun,
    status,
    workspaceHostDir: plan.workspaceHostDir,
    repoWorkspaces: plan.input.preparedRepoWorkspaces ?? [],
    result,
    report,
  });

  return {
    kind: 'ok',
    attempt: { stepRun, result, report, status, agentWorkingDir },
  };
}