import type { PipelineStep } from '@issue-resolver/shared';
import { TaskStatus } from '@issue-resolver/shared';
import type {
  IterationTerminalOutcome,
  RunIterationInput,
  RunIterationResult,
  WorkflowDeps,
} from './contracts';

export type IterationTerminalStatus = Extract<
  TaskStatus,
  'completed' | 'failed' | 'cancelled'
>;

export interface TerminalEnv {
  issue: RunIterationInput['issue'];
  iteration: RunIterationInput['iteration'];
  workspaceHostDir: string;
  workspaceContainerPath: string;
  containerName: string;
  repoPaths: string[];
  thinkingLevel?: RunIterationInput['thinking_level'];
  steps: PipelineStep[];
}

export function terminalOutcome(
  env: TerminalEnv,
  outcomeStatus: IterationTerminalStatus,
): IterationTerminalOutcome {
  return {
    issueId: env.issue.id,
    iterationId: env.iteration.id,
    issueTitle: env.issue.title,
    iterationNumber: env.iteration.number,
    iterationStatus:
      outcomeStatus === TaskStatus.cancelled ? TaskStatus.failed : outcomeStatus,
    iterationCount: env.iteration.number,
    workspaceHostDir: env.workspaceHostDir,
    workspaceContainerPath: env.workspaceContainerPath,
    containerName: env.containerName,
    repoPaths: env.repoPaths,
    thinkingLevel: env.thinkingLevel,
    pipelineSteps: env.steps,
  };
}

export function finishIteration(
  deps: WorkflowDeps,
  env: TerminalEnv,
  outcomeStatus: IterationTerminalStatus,
  result: RunIterationResult,
): RunIterationResult {
  void deps.onIterationTerminal?.(terminalOutcome(env, outcomeStatus));
  return result;
}