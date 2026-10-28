
export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'running'
  | 'preparing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'question';

export type PipelineStep = 'refine' | 'resolve' | 'review' | 'test' | 'pr' | 'report';

export type DesiredResult = 'md' | 'html';

export type StepModels = Partial<Record<PipelineStep, string>>;

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type StepThinkingLevels = Partial<Record<PipelineStep, ThinkingLevel>>;

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'needs_input'
  | 'skipped'
  | 'aborted';

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

export interface MergeRequestEntry {
  repository_url: string;
  url: string;
  title?: string;
  message?: string;
}

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

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionSpeed {
  tokensPerSecond: number;
  avgTokensPerSecond: number;
}

export interface SessionQuestion {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export type CompactionReason = 'manual' | 'threshold' | 'overflow';

export type SessionEvent =
  | { type: 'text'; text: string }
  | { type: 'text_update'; contentIndex: number; partialText: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'thinking_update'; contentIndex: number; partialText: string }
  | {
      type: 'usage';
      usage: SessionUsage;
      cost: SessionCost | null;
      speed?: SessionSpeed;
    }
  | { type: 'stats'; stats: SessionStats }
  | ({ type: 'question' } & SessionQuestion)
  | { type: 'question_answered'; questionId: string; answer: string }
  | { type: 'tool_use'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_result';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      durationMs: number | null;
      resultText: string;
    }
  | { type: 'tool_update'; toolCallId: string; toolName: string; partialText: string }
  | { type: 'compaction_start'; reason: CompactionReason }
  | {
      type: 'compaction_end';
      reason: CompactionReason;
      summary: string | null;
      aborted: boolean;
      willRetry: boolean;
      errorMessage: string | null;
      tokensBefore: number | null;
      estimatedTokensAfter: number | null;
    }
  | {
      type: 'retry_start';
      kind: 'auto' | 'summarization';
      attempt: number | null;
      maxAttempts: number | null;
      delayMs: number | null;
      errorMessage: string | null;
      source: string | null;
      reason: string | null;
    }
  | {
      type: 'retry_end';
      kind: 'auto' | 'summarization';
      success: boolean | null;
      attempt: number | null;
      finalError: string | null;
    }
  | { type: 'queue'; steering: string[]; followUp: string[] }
  | { type: 'thinking_level'; level: string }
  | { type: 'session_info'; name: string | null }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'status'; key: string; text: string | null }
  | {
      type: 'widget';
      key: string;
      lines: string[] | null;
      placement: 'aboveEditor' | 'belowEditor';
    }
  | { type: 'title'; title: string }
  | { type: 'extension_error'; message: string }
  | { type: 'bash'; delta: string }
  | { type: 'editor_text'; text: string };

export interface SessionStats {
  sessionId?: string;
  model?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number | null;
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  avgTokensPerSecond?: number;
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

export type StepReportStatus = 'pass' | 'fail' | 'blocked';

export type ExecutionMode = 'single' | 'room' | 'stages';

export interface ExecutionStage {
  index: number;
  name?: string;
  task?: string;
  executors?: number;
  decomposition?: string[];
}

export interface ExecutionPlan {
  mode: ExecutionMode;
  executors?: number;
  decomposition?: string[];
  stages?: ExecutionStage[];
  rationale?: string;
}

export interface RoomAgent {
  id: string;
  role: 'worker' | 'coordinator';
  index: number | null;
  label: string;
  stage?: number | null;
  stageName?: string | null;
  status: 'running' | 'finished' | 'aborted' | 'failed';
  startedAt: string | null;
  endedAt?: string | null;
  stats: SessionStats | null;
}

export interface StepReportScenario {
  name: string;
  status?: 'pass' | 'fail';
  details?: string;
  expected?: string;
  actual?: string;
}

export interface StepReportFinding {
  severity: 'info' | 'low' | 'minor' | 'major' | 'critical' | (string & {});
  description?: string;
  title?: string;
  detail?: string;
}

export interface StepReport {
  status: StepReportStatus;
  summary: string;
  scenarios?: StepReportScenario[];
  findings?: StepReportFinding[];
  execution?: ExecutionPlan;
  title?: string;
  description?: string;
  pr_error?: string;
  merge_requests?: StepReportMrEntry[];
}

export interface StepReportMrEntry {
  repository_url: string;
  title: string;
  description: string;
}

export interface StepExecutionResult {
  step: PipelineStep;
  exitCode: number;
  report: StepReport | null;
  stdout: string;
  stderr: string;
  events?: SessionEvent[];
  stats?: SessionStats | null;
  aborted?: boolean;
}

export interface ContainerSpec {
  issueId: string;
  containerName: string;
  image: string;
  workspaceHostPath: string;
  repoUrls: string[];
  memoryVolumeName?: string;
  memoryMountPath?: string;
}

export interface SpawnContainerResult {
  containerId: string;
  containerName: string;
  workspacePath: string;
}

export interface ContainerStats {
  containerName: string;
  cpuPercent: number | null;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
}

export interface ContainerStatsPayload {
  cpuPercent: number | null;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
}

export type WorkspaceProgressStep =
  | 'creating_dirs'
  | 'cloning'
  | 'checking_instructions'
  | 'devops'
  | 'installing'
  | 'dev_server'
  | 'ready';

export interface WorkspaceProgress {
  step: WorkspaceProgressStep;
  repo?: string;
  status: 'running' | 'done' | 'warning' | 'error';
  message?: string;
  devPort?: number;
}

export type WorkspaceProgressReporter = (progress: WorkspaceProgress) => void;

export type IssueDeletingPhase =
  | 'stopping_processes'
  | 'removing_db_record'
  | 'removing_workspace'
  | 'removing_container'
  | 'error';

export type SSEEventType =
  | 'log'
  | 'step_status'
  | 'step_event'
  | 'iteration_status'
  | 'workspace_progress'
  | 'issue_deleting'
  | 'issue_deleted'
  | 'container_stats';

export interface SSEEvent {
  type: SSEEventType;
  issueId: string;
  iterationId?: string;
  stepRunId?: string;
  agentId?: string;
  stream?: 'stdout' | 'stderr' | 'rpc' | 'mr' | 'system';
  data: string;
  ts: string;
}

export interface ModelDescriptor {
  id: string;
  provider?: string;
  name?: string;
  contextWindow?: number;
  thinkingLevels?: ThinkingLevel[];
}

export type RepoPlatform = 'github' | 'gitlab' | 'bitbucket' | 'unknown';

export interface RepoInfo {
  platform: RepoPlatform;
  fullName: string;
  defaultBranch: string;
  branches: string[];
  language: string | null;
  description: string | null;
  stars: number;
  isPrivate: boolean;
  cloneUrl: string;
  writeAccess: boolean;
}

export interface RepoValidationResult {
  url: string;
  valid: boolean;
  platform: RepoPlatform;
  info?: RepoInfo;
  error?: string;
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

export interface ValidateReposRequest {
  urls: string[];
}

export interface ValidateReposResponse {
  results: RepoValidationResult[];
}

export type RepoConnectionStatus = 'ok' | 'error' | 'unknown';

export type RunInstructionsStatus = 'unknown' | 'generated' | 'failed';

export interface SavedRepo {
  id: string;
  url: string;
  platform: RepoPlatform | null;
  fullName: string | null;
  defaultBranch: string | null;
  cloneUrl: string | null;
  language: string | null;
  description: string | null;
  isPrivate: boolean | null;
  connectionStatus: RepoConnectionStatus;
  lastValidatedAt: string | null;
  writeAccess: boolean;
  runInstructions: string | null;
  runInstructionsStatus: RunInstructionsStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepoRequest {
  url: string;
}

export interface UpdateRepoRequest {
  url: string;
}

export interface RepoBranchesResponse {
  branches: string[];
}

export interface TagRepository {
  id: string;
  tag_id: string;
  repository_id: string;
  bootstrap_enabled: boolean;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  description: string | null;
  run_instructions: string | null;
  run_instructions_status: RunInstructionsStatus;
  repositories: TagRepositoryWithRepo[];
  created_at: string;
  updated_at: string;
}

export interface TagRepositoryWithRepo extends TagRepository {
  repository: SavedRepo;
}

export interface CreateTagRequest {
  name: string;
  description?: string;
  run_instructions?: string | null;
  repositories: { repository_id: string; bootstrap_enabled?: boolean }[];
}

export interface UpdateTagRequest {
  name?: string;
  description?: string;
  run_instructions?: string | null;
  repositories?: { repository_id: string; bootstrap_enabled?: boolean }[];
}