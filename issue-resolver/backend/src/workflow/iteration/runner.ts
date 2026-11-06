import type { ExecutionPlan } from '@issue-resolver/shared';
import {
  MAX_PIPELINE_ATTEMPTS,
  MAX_SELF_RETRIES,
  SELF_RETRY_STEPS,
  PipelineStep,
  StepRunStatus,
  StepTransitionKind,
  TaskStatus,
  maxExecutorsFor,
  nextStepDecision,
} from '@issue-resolver/shared';
import { previousAttemptFeedback, type PrTarget } from '../prompts';
import { RefineGateKind } from './refine-gate';
import {
  resolveAgentStallTimeoutMs,
  resolveAgentTimeoutMs,
} from '../timeout';
import {
  DEFAULT_WORKSPACE_ROOT,
  containerNameFor,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../../workspace/paths';
import type {
  RunIterationInput,
  RunIterationResult,
  WorkflowDeps,
} from './contracts';
import { canonicalStepOrder } from './pipeline-order';
import type { StepExecutionPlan } from './step-execution';
import { applyRefineGate } from './refine-gate';
import { runStepAttempt } from './step-cycle';
import { crashFeedback, failedStepFeedback } from './retry-feedback';
import {
  finishIteration,
  type IterationTerminalStatus,
  type TerminalEnv,
} from './terminal';

export async function runIteration(
  deps: WorkflowDeps,
  input: RunIterationInput,
): Promise<RunIterationResult> {
  const { issue, iteration } = input;
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const containerName = containerNameFor(issue.id);
  const workspaceHostDir = workspaceHostDirFor(workspaceRoot, issue.id);
  const workspaceContainerPath = workspaceContainerDirFor(issue.id);

  const repoWorkspaces = input.preparedRepoWorkspaces ?? [];
  const repoPaths = repoWorkspaces.map((workspace) => workspace.path);
  const prTargets: PrTarget[] = repoWorkspaces.map((workspace) => {
    const repo = input.repositories.find(
      (item) => item.repository_url === workspace.repoUrl,
    );
    return {
      path: workspace.path,
      baseBranch: repo?.base_branch ?? workspace.branch,
      createMr: repo?.create_mr ?? false,
    };
  });

  const rawSteps =
    iteration.steps.length > 0 ? iteration.steps : issue.pipelineSteps;
  const steps = canonicalStepOrder(rawSteps);

  let stepIndex = 0;
  let attempt = 1;
  let pipelineAttempt = 1;
  let stepRetries = 0;
  let feedback: string | null = null;
  let refinedPlan: string | null = null;
  let refinedExecution: ExecutionPlan | null = null;
  const agentTimeoutMs = input.agentTimeoutMs ?? resolveAgentTimeoutMs();
  const agentStallMs = input.agentStallTimeoutMs ?? resolveAgentStallTimeoutMs();
  const maxExecutors = maxExecutorsFor(iteration.worker_count);

  const env: TerminalEnv = {
    issue,
    iteration,
    workspaceHostDir,
    workspaceContainerPath,
    containerName,
    repoPaths,
    thinkingLevel: input.thinking_level,
    steps,
  };

  const plan: StepExecutionPlan = {
    deps,
    input,
    steps,
    prTargets,
    containerName,
    workspaceHostDir,
    workspaceContainerPath,
    repoPaths,
    maxExecutors,
    agentTimeoutMs,
    agentStallMs,
  };

  const finish = (status: IterationTerminalStatus): RunIterationResult =>
    finishIteration(deps, env, status, {
      iterationStatus: status,
      needsInput: false,
    });

  // needs_input waits for the user, so it must not notify the terminal hook.
  const finishNeedsInput = (): RunIterationResult => ({
    iterationStatus: TaskStatus.failed,
    needsInput: true,
  });

  while (stepIndex < steps.length) {
    const step = steps[stepIndex];
    const model = (input.step_models?.[step] ?? input.model) || undefined;
    const thinkingLevel =
      (input.step_thinking_levels?.[step] ?? input.thinking_level) || undefined;

    const attemptOutcome = await runStepAttempt(plan, {
      step,
      attempt,
      feedback,
      refinedPlan,
      refinedExecution,
      model,
      thinkingLevel,
    });
    if (attemptOutcome.kind === 'crashed') {
      const maxSelf = MAX_SELF_RETRIES[step] ?? 0;
      if (SELF_RETRY_STEPS.has(step) && stepRetries < maxSelf) {
        stepRetries += 1;
        attempt += 1;
        feedback = crashFeedback(step, attemptOutcome.message, {
          attempt: stepRetries,
          max: maxSelf,
        });
        continue;
      }

      return finish(TaskStatus.failed);
    }

    const { stepRun, result, report, status, agentWorkingDir } =
      attemptOutcome.attempt;

    if (step === PipelineStep.refine && status === StepRunStatus.success) {
      const gate = await applyRefineGate({
        deps,
        issueId: issue.id,
        iterationId: iteration.id,
        stepRunId: stepRun.id,
        agentWorkingDir,
        workspaceHostDir,
        steps,
        maxExecutors,
        report,
        stepRetries,
      });
      if (gate.kind === RefineGateKind.failed) {
        return finish(TaskStatus.failed);
      }
      if (gate.kind === RefineGateKind.retry) {
        stepRetries += 1;
        feedback = gate.feedback;
        attempt += 1;
        continue;
      }
      refinedPlan = gate.refinedPlan;
      refinedExecution = gate.refinedExecution;
    }

    if (status === StepRunStatus.aborted) {
      return finish(TaskStatus.cancelled);
    }

    if (status === StepRunStatus.needs_input) {
      return finishNeedsInput();
    }

    if (status === StepRunStatus.failed && SELF_RETRY_STEPS.has(step)) {
      const maxSelf = MAX_SELF_RETRIES[step] ?? 0;
      if (stepRetries < maxSelf) {
        stepRetries += 1;
        attempt += 1;
        feedback = failedStepFeedback(step, report, result, {
          attempt: stepRetries,
          max: maxSelf,
        });
        continue;
      }
    }

    const decision = nextStepDecision({
      steps,
      currentStep: step,
      result:
        status === StepRunStatus.success
          ? StepRunStatus.success
          : StepRunStatus.failed,
      attempt: pipelineAttempt,
      maxAttempts: MAX_PIPELINE_ATTEMPTS,
      report,
    });

    switch (decision.kind) {
      case StepTransitionKind.advance:
        if (decision.iterationCompleted) {
          return finish(TaskStatus.completed);
        }
        stepIndex += 1;
        stepRetries = 0;
        break;
      case StepTransitionKind.retry_resolve:
        feedback = previousAttemptFeedback(step, report);
        attempt = decision.attempt;
        pipelineAttempt = decision.attempt;
        stepIndex = steps.indexOf(PipelineStep.resolve);
        stepRetries = 0;
        break;
      case StepTransitionKind.needs_input:
        return finishNeedsInput();
      case StepTransitionKind.iteration_failed:
        return finish(TaskStatus.failed);
    }
  }

  return finish(TaskStatus.completed);
}