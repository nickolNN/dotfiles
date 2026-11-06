import type { DesiredResult } from '../status';
import type { TaskStatus } from '../status';
import type { PipelineStep, StepModels, StepThinkingLevels } from './pipeline';
import type { ThinkingLevel } from '../status';
import type { MergeRequestEntry } from './pr';

export interface IssueRepository {
  id: string;
  repository_url: string;
  branch_name: string;
  create_mr: boolean;
  bootstrap_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface IssueFile {
  id: string;
  issue_id: string;
  iteration_id: string | null;
  name: string;
  rel_path: string;
  size: number;
  mime_type: string | null;
  created_at: string;
}

export interface WorkspaceFile {
  name: string;
  rel_path: string;
  size: number;
  mime_type: string | null;
}

export interface Issue {
  id: string;
  title: string;
  jira_issue_url: string | null;
  source?: string | null;
  tag_id?: string | null;
  dev_server_port?: number | null;
  description?: string;
  desired_result?: DesiredResult;
  repositories: IssueRepository[];
  pipeline_steps: PipelineStep[];
  step_models?: StepModels;
  thinking_level?: ThinkingLevel | null;
  step_thinking_levels?: StepThinkingLevels;
  devops_model?: string | null;
  devops_thinking_level?: ThinkingLevel | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  workspace_missing?: boolean;
  worker_count?: number;
  merge_requests?: MergeRequestEntry[] | null;
}

export interface RepositoryInput {
  repository_url: string;
  base_branch: string;
  create_mr?: boolean;
  bootstrap_enabled?: boolean;
}

export interface SavedRepositoryInput {
  repo_id: string;
  repository_url?: string;
  base_branch?: string;
  create_mr?: boolean;
  bootstrap_enabled?: boolean;
}

export type CreateIssueRepositoryInput =
  | RepositoryInput
  | SavedRepositoryInput;

export interface CreateIssueRequest {
  title?: string;
  jira_issue_url?: string;
  repositories?: CreateIssueRepositoryInput[];
  tag_id?: string;
  desired_result?: DesiredResult;
  additional_context?: string;
  review_context?: string;
  is_review_need?: boolean;
  pipeline_steps?: PipelineStep[];
  model?: string;
  step_models?: StepModels;
  devops_model?: string;
  devops_thinking_level?: ThinkingLevel;
  thinking_level?: ThinkingLevel;
  step_thinking_levels?: StepThinkingLevels;
  worker_count?: number;
  run_immediately?: boolean;
}

export interface JiraIssueInfo {
  key: string;
  title: string;
  summary: string;
}

export interface JiraValidationResult {
  url: string;
  valid: boolean;
  key?: string;
  issue?: JiraIssueInfo;
  error?: string;
}