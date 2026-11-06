import { PipelineStep } from '@issue-resolver/shared';
import type {
  ExecutionPlan,
  SessionEvent,
  StepExecutionResult,
  StepRun,
  WorkerTask,
} from '@issue-resolver/shared';
import {
  ExecutionMode,
  SessionAddress,
  TaskStatus,
  planExecutionMode,
} from '@issue-resolver/shared';
import type { RepoChangeDigest } from '../../git/service';
import { issueSessionDir, sessionDisplayName } from '../../pi/session-paths';
import { iterationTarget, type StepAgentInfo } from '../../pi/session-registry';
import { stallRecoveries } from '../../pi/stall-recovery';
import { soloRunExcludeTools } from '../../pi/tool-policy';
import { STEP_SYSTEM_APPEND, buildStepPrompt, type PrTarget } from '../prompts';
import { runStagedResolve } from '../staged-resolve';
import {
  withAgentStallGuard,
  withAgentTimeout,
} from '../timeout';
import { stepEvent, streamEvent } from '../sse-events';
import type { WorkflowDeps } from './contracts';
import type { RunIterationInput } from './contracts';
import { SSEStream } from '@issue-resolver/shared';

export interface StepExecutionPlan {
  deps: WorkflowDeps;
  input: RunIterationInput;
  steps: PipelineStep[];
  prTargets: PrTarget[];
  containerName: string;
  workspaceHostDir: string;
  workspaceContainerPath: string;
  repoPaths: string[];
  maxExecutors: number;
  agentTimeoutMs: number;
  agentStallMs: number;
}

export interface StepExecutionRequest {
  step: PipelineStep;
  stepRun: StepRun;
  attempt: number;
  feedback: string | null;
  refinedPlan: string | null;
  refinedExecution: ExecutionPlan | null;
  model?: string;
  thinkingLevel?: string;
}

export interface StepExecutionOutcome {
  result: StepExecutionResult;
  agentWorkingDir: string;
}

async function changeDigestOf(
  git: WorkflowDeps['git'],
  repoPaths: string[],
): Promise<RepoChangeDigest[]> {
  if (repoPaths.length === 0) return [];
  try {
    return await git.changeDigest(repoPaths);
  } catch (error) {
    console.error('workflow: change digest failed, prompt without it', error);
    return [];
  }
}

export async function executeStepAgent(
  plan: StepExecutionPlan,
  request: StepExecutionRequest,
): Promise<StepExecutionOutcome> {
  const { deps, input } = plan;
  const { issue, iteration } = input;
  const { step, stepRun } = request;
  const agentWorkingDir = deps.local
    ? plan.workspaceHostDir
    : plan.workspaceContainerPath;

  const stateDigest = await changeDigestOf(deps.git, plan.repoPaths);
  const promptContext = {
    issueTitle: issue.title,
    description: input.description ?? '',
    jiraText: input.jiraText ?? null,
    context: iteration.context,
    reviewContext: iteration.review_context ?? '',
    feedback: request.feedback,
    repoPaths: plan.repoPaths,
    desiredResult: issue.desiredResult,
    previousOutcome: input.previousOutcome,
    attachmentPaths: input.attachmentPaths ?? [],
    pipelineSteps: plan.steps,
    devServerPort: input.devServerPort ?? null,
    credentials: input.credentials ?? null,
    prTargets: plan.prTargets,
    workerCount: iteration.worker_count ?? undefined,
    stateDigest,
    workingDir: agentWorkingDir,
    attempt: request.attempt,
  };
  let stepActivity = 0;
  const runOptions = {
    model: request.model,
    thinkingLevel: request.thinkingLevel,
    cwd: agentWorkingDir,
    iterationId: iteration.id,
    issueId: issue.id,
    registry: deps.control,
    timeoutMs: plan.agentTimeoutMs,
    sessionDir: issueSessionDir(issue.id),
    systemAppend: STEP_SYSTEM_APPEND,
    sessionName: sessionDisplayName({
      step,
      issueId: issue.id,
      attempt: stepRun.attempt,
    }),
    onStdout: (chunk: string, agent?: StepAgentInfo) => {
      stepActivity += 1;
      deps.sse.publish(
        streamEvent(issue.id, iteration.id, stepRun.id, SSEStream.stdout, chunk, agent?.id),
      );
    },
    onStderr: (chunk: string, agent?: StepAgentInfo) => {
      stepActivity += 1;
      deps.sse.publish(
        streamEvent(issue.id, iteration.id, stepRun.id, SSEStream.stderr, chunk, agent?.id),
      );
    },
    onEvent: (event: SessionEvent, agent?: StepAgentInfo) => {
      stepActivity += 1;
      deps.sse.publish(
        stepEvent(issue.id, iteration.id, stepRun.id, event, agent?.id),
      );
      if (event.type === 'question') {
        deps.onQuestionStatus?.(TaskStatus.question);
        void deps.store
          .appendStepRunEvent(stepRun.id, event)
          .catch((error) =>
            console.error('workflow: failed to persist question event', error),
          );
      } else if (event.type === 'question_answered') {
        deps.onQuestionStatus?.(TaskStatus.running);
        void deps.store
          .appendStepRunEvent(stepRun.id, event)
          .catch((error) =>
            console.error(
              'workflow: failed to persist question_answered event',
              error,
            ),
          );
      }
    },
  };

  const topology =
    step === PipelineStep.resolve
      ? planExecutionMode(request.refinedExecution)
      : ExecutionMode.single;
  const onWorkerStart = (
    item: WorkerTask,
    total: number,
    agent: StepAgentInfo,
  ): void =>
    deps.sse.publish(
      streamEvent(
        issue.id,
        iteration.id,
        stepRun.id,
        SSEStream.system,
        `worker ${item.index + 1}/${total}: ${item.task}`,
        agent.id,
      ),
    );

  const stagedOptions = {
    ...runOptions,
    stepRunId: stepRun.id,
    onWorkerStart,
    hostWorkspaceDir: plan.workspaceHostDir,
  };
  const soloStepOptions =
    topology === ExecutionMode.stages
      ? runOptions
      : { ...runOptions, excludeTools: soloRunExcludeTools() };

  let agentRun: Promise<StepExecutionResult>;
  if (topology === ExecutionMode.stages) {
    const execution = request.refinedExecution;
    if (execution === null) {
      throw new Error(
        'workflow: staged resolve has no refined execution plan',
      );
    }
    agentRun = runStagedResolve(
      deps.pi,
      {
        containerName: plan.containerName,
        execution,
        maxExecutors: plan.maxExecutors,
        ...promptContext,
        refinedPlan: request.refinedPlan,
      },
      stagedOptions,
    );
  } else {
    agentRun = withAgentTimeout(
      deps.pi.run(
        plan.containerName,
        buildStepPrompt({ step, ...promptContext, refinedPlan: request.refinedPlan }),
        {
          ...soloStepOptions,
          stepRunId: stepRun.id,
          sessionId: SessionAddress.forStepRun(stepRun.id).toString(),
        },
      ),
      plan.agentTimeoutMs,
      `${step} agent`,
    );
  }

  const result = await withAgentStallGuard(agentRun, {
    stallMs: plan.agentStallMs,
    label: `${step} agent`,
    activity: () => stepActivity,
    recover: stallRecoveries({
      control: deps.control,
      target: iterationTarget(iteration.id),
      graceMs: plan.agentStallMs,
    }),
    onStall: () => {
      void deps.control?.send(iterationTarget(iteration.id), {
        type: 'abort_retry',
      });
      deps.control?.abortByIteration(iteration.id);
    },
  });

  return { result, agentWorkingDir };
}