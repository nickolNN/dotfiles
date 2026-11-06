import type { TaskStatus } from '../status';
import type {
  PipelineStep,
  StepModels,
  StepThinkingLevels,
} from './pipeline';
import type { ThinkingLevel } from '../status';

export interface Iteration {
  id: string;
  issue_id: string;
  number: number;
  context: string;
  review_context: string;
  is_review_need: boolean;
  steps: PipelineStep[];
  status: TaskStatus;
  model?: string | null;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel | null;
  step_thinking_levels?: StepThinkingLevels;
  worker_count?: number;
  created_at: string;
  updated_at: string;
}

export interface CreateIterationRequest {
  context: string;
  review_context?: string;
  is_review_need?: boolean;
  steps?: PipelineStep[];
  model?: string;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel;
  step_thinking_levels?: StepThinkingLevels;
  worker_count?: number;
  pr_repository_ids?: string[];
}