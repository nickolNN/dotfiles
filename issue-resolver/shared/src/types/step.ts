import type {
  FindingSeverity,
  ScenarioStatus,
  StepAgentRole,
  StepAgentStatus,
  StepReportStatus,
  StepRunStatus,
} from '../status';
import type { ExecutionMode } from '../status';
import type { PipelineStep } from './pipeline';
import type { StepReportMrEntry } from './pr';
import type { SessionEvent, SessionStats } from './session';

export interface StepRun {
  id: string;
  issue_id: string;
  iteration_id: string | null;
  step: PipelineStep;
  attempt: number;
  status: StepRunStatus;
  context: string;
  feedback: string | null;
  created_at: string;
  updated_at: string;
}

export interface StepOutput {
  id: string;
  step_run_id: string;
  report: string;
  screenshots_dir: string | null;
  stdout: string;
  stderr: string;
  events?: SessionEvent[];
  stats?: SessionStats | null;
  created_at: string;
  updated_at: string;
}

export interface StepRunWithLog extends StepRun {
  stdout: string;
  stderr: string;
  events: SessionEvent[];
  stats: SessionStats | null;
  report: string | null;
  screenshots_dir: string | null;
}

export interface ExecutionStage {
  index: number;
  name?: string;
  task?: string;
  executors?: number;
  decomposition?: string[];
  /** Declared, but not a list — kept so the gate can reject the stage by position. */
  decompositionMalformed?: boolean;
}

export interface ExecutionPlan {
  mode: ExecutionMode;
  executors?: number;
  decomposition?: string[];
  /** Declared, but not a list — kept so the gate can name the field. */
  decompositionMalformed?: boolean;
  stages?: ExecutionStage[];
  rationale?: string;
}

export interface StepAgent {
  id: string;
  role: StepAgentRole;
  index: number | null;
  label: string;
  stage?: number | null;
  stageName?: string | null;
  status: StepAgentStatus;
  startedAt: string | null;
  endedAt?: string | null;
  stats: SessionStats | null;
}

export interface StepReportScenario {
  name: string;
  status?: ScenarioStatus;
  details?: string;
  expected?: string;
  actual?: string;
}

export interface StepReportFinding {
  severity: FindingSeverity;
  description?: string;
  title?: string;
  detail?: string;
}

export interface StepReport {
  status: StepReportStatus;
  summary: string;
  scenarios?: StepReportScenario[];
  findings?: StepReportFinding[];
  /** At least one finding carried a severity outside `FindingSeverity`. */
  findingsMalformed?: boolean;
  execution?: ExecutionPlan;
  executionMalformed?: boolean;
  title?: string;
  description?: string;
  pr_error?: string;
  merge_requests?: StepReportMrEntry[];
}

export interface StepExecutionResult {
  step: PipelineStep;
  exitCode: number;
  report: StepReport | null;
  stdout: string;
  stderr: string;
  events?: SessionEvent[];
  stats?: SessionStats | null;
  modelReplied?: boolean;
  aborted?: boolean;
}