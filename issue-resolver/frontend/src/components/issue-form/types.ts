import type {
  CreateIssueRequest,
  PipelineStep,
  StepModels,
  StepThinkingLevels,
  ThinkingLevel,
} from '@issue-resolver/shared';

export interface InitialRepository {
  repo_id: string;
  repository_url?: string;
  base_branch: string;
  bootstrap_enabled?: boolean;
  create_mr?: boolean;
}

export interface IssueFormProps {
  initialData?: {
    title?: string;
    description?: string;
    jiraIssueUrl?: string;
    repositories?: InitialRepository[];
    pipelineSteps?: PipelineStep[];
    stepModels?: StepModels;
    stepThinkingLevels?: StepThinkingLevels;
    devopsModel?: string;
    devopsThinkingLevel?: ThinkingLevel | null;
    workerCount?: number | null;
  };
  onSubmit: (payload: CreateIssueRequest, files: File[]) => Promise<void>;
  submitLabel?: string;
  showSaveButton?: boolean;
  showRunButton?: boolean;
  showFiles?: boolean;
  error?: string | null;
  submitting?: boolean;
  onBack?: () => void;
  headerless?: boolean;
}
