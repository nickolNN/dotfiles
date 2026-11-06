import type {
  DesiredResult,
  PipelineStep,
  StepModels,
  StepThinkingLevels,
  ThinkingLevel,
} from '@issue-resolver/shared';
import type { ContainerController } from '../docker/controller';
import type { GitPrepareResult } from '../git/service';
import type { DevopsSettings, WorkflowCore } from './run-deps';

export interface IterationRunDeps extends WorkflowCore, DevopsSettings {
  mrToken?: string;
}

export interface RunIssueIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    description?: string;
    desiredResult?: DesiredResult;
    jiraIssueUrl?: string | null;
  };
  iteration: {
    id: string;
    issueId: string;
    number: number;
    context: string;
    steps: PipelineStep[];
    reviewContext?: string;
    isReviewNeed?: boolean;
    worker_count?: number;
  };
  repositories: {
    repository_url: string;
    base_branch: string;
    create_mr?: boolean;
    bootstrap_enabled?: boolean;
  }[];
  repoWorkspaces: GitPrepareResult['repoWorkspaces'];
  model?: string;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel;
  step_thinking_levels?: StepThinkingLevels;
  mrToken?: string;
}
