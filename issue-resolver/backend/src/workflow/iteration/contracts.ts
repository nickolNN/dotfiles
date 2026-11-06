import type {
  DesiredResult,
  Iteration,
  PipelineStep,
  SessionEvent,
  SessionStats,
  StepModels,
  StepOutput,
  StepRun,
  StepRunStatus,
  StepThinkingLevels,
  TaskStatus,
  ThinkingLevel,
} from '@issue-resolver/shared';
import type { ContainerController } from '../../docker/controller';
import type { GitPrepareResult } from '../../git/service';
import type { WorkflowCore } from '../run-deps';

export interface StepRunStore {
  createStepRun(input: {
    issueId: string;
    iterationId: string | null;
    step: PipelineStep;
    attempt: number;
    context: string;
  }): Promise<StepRun>;
  updateStepRun(
    id: string,
    patch: { status?: StepRunStatus; feedback?: string | null },
  ): Promise<StepRun>;
  appendStepRunEvent(id: string, event: SessionEvent): Promise<void>;
  createStepOutput(input: {
    stepRunId: string;
    report: string;
    screenshotsDir?: string;
    stdout?: string;
    stderr?: string;
    events?: SessionEvent[];
    stats?: SessionStats | null;
  }): Promise<StepOutput>;
}

export type QuestionStatus = Extract<TaskStatus, 'question' | 'running'>;

export interface WorkflowDeps extends WorkflowCore {
  store: StepRunStore;
  onQuestionStatus?: (status: QuestionStatus) => void;
  onIterationTerminal?: (outcome: IterationTerminalOutcome) => void;
}

export interface IterationTerminalOutcome {
  issueId: string;
  iterationId: string;
  issueTitle: string;
  iterationNumber: number;
  iterationStatus: 'completed' | 'failed';
  iterationCount: number;
  workspaceHostDir: string;
  workspaceContainerPath: string;
  containerName: string;
  repoPaths: string[];
  thinkingLevel?: ThinkingLevel;
  pipelineSteps: PipelineStep[];
}

export interface RunIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    desiredResult?: DesiredResult;
  };
  iteration: Iteration;
  repositories: {
    repository_url: string;
    base_branch: string;
    create_mr?: boolean;
    bootstrap_enabled?: boolean;
  }[];
  model?: string;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel;
  step_thinking_levels?: StepThinkingLevels;
  mrToken?: string;
  preparedRepoWorkspaces?: GitPrepareResult['repoWorkspaces'];
  description?: string;
  jiraText?: string | null;
  previousOutcome?: string | null;
  attachmentPaths?: string[];
  devServerPort?: number | null;
  agentTimeoutMs?: number;
  agentStallTimeoutMs?: number;
}

export interface RunIterationResult {
  iterationStatus: TaskStatusValue;
  needsInput: boolean;
}

type TaskStatusValue = Iteration['status'];