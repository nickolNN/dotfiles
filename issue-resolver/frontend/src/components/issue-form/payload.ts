import { PipelineStep } from '@issue-resolver/shared';
import type {
  CreateIssueRequest,
  StepModels,
  StepThinkingLevels,
  ThinkingLevel,
} from '@issue-resolver/shared';
import type { RepoRowData } from '../RepoRow';
import { PIPELINE_ORDER } from '../../constants/pipeline';

interface BuildIssuePayloadInput {
  title: string;
  jiraIssueUrl: string;
  repositories: RepoRowData[];
  additionalContext: string;
  chosenSteps: ReadonlySet<PipelineStep>;
  prRepoIds: ReadonlySet<string>;
  stepModels: StepModels;
  stepThinkingLevels: StepThinkingLevels;
  devOpsModel: string;
  devOpsThinkingLevel: ThinkingLevel | '';
  workerCount: number;
  runImmediately: boolean;
}

const STEP_VALUE_KEYS: readonly PipelineStep[] = [
  ...PIPELINE_ORDER,
  PipelineStep.report,
];

function activeStepValues<T>(
  values: Partial<Record<PipelineStep, T>>,
  chosenSteps: ReadonlySet<PipelineStep>,
): Partial<Record<PipelineStep, T>> {
  const active: Partial<Record<PipelineStep, T>> = {};
  for (const step of STEP_VALUE_KEYS) {
    if (step !== PipelineStep.report && !chosenSteps.has(step)) continue;
    const value = values[step];
    if (value !== undefined) active[step] = value;
  }
  return active;
}

export function buildIssuePayload({
  title,
  jiraIssueUrl,
  repositories,
  additionalContext,
  chosenSteps,
  prRepoIds,
  stepModels,
  stepThinkingLevels,
  devOpsModel,
  devOpsThinkingLevel,
  workerCount,
  runImmediately,
}: BuildIssuePayloadInput): CreateIssueRequest {
  const activeRepositories: NonNullable<CreateIssueRequest['repositories']> =
    [];
  for (const repository of repositories) {
    if (repository.repo_id) {
      activeRepositories.push({
        repo_id: repository.repo_id,
        base_branch: repository.base_branch,
        create_mr: chosenSteps.has(PipelineStep.pr) && prRepoIds.has(repository.repo_id),
        bootstrap_enabled: repository.bootstrap_enabled,
      });
    } else if (repository.repository_url) {
      activeRepositories.push({
        repository_url: repository.repository_url,
        base_branch: repository.base_branch,
        create_mr: false,
        bootstrap_enabled: repository.bootstrap_enabled,
      });
    }
  }

  const activeStepModels = activeStepValues(stepModels, chosenSteps);
  const activeStepThinkingLevels = activeStepValues(
    stepThinkingLevels,
    chosenSteps,
  );

  return {
    title,
    jira_issue_url: jiraIssueUrl.trim() || undefined,
    repositories:
      activeRepositories.length > 0 ? activeRepositories : undefined,
    additional_context: additionalContext.trim() || undefined,
    is_review_need: chosenSteps.has(PipelineStep.review),
    review_context: '',
    pipeline_steps: PIPELINE_ORDER.filter((step) => chosenSteps.has(step)),
    step_models:
      Object.keys(activeStepModels).length > 0 ? activeStepModels : undefined,
    devops_model: devOpsModel || undefined,
    devops_thinking_level: devOpsThinkingLevel || undefined,
    step_thinking_levels:
      Object.keys(activeStepThinkingLevels).length > 0
        ? activeStepThinkingLevels
        : undefined,
    run_immediately: runImmediately,
    worker_count: workerCount > 0 ? workerCount : undefined,
  };
}