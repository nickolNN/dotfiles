import type {
  ExecutionPlan,
  SessionEvent,
  WorkerTask,
} from '@issue-resolver/shared';
import type { StepAgentInfo, StepSessionRegistry } from '../../pi/session-registry';
import type { StagePromptInput } from '../prompts';

export interface StagedResolveInput extends StagePromptInput {
  containerName: string;
  execution: ExecutionPlan;
  maxExecutors?: number;
}

export interface StagedResolveOptions {
  hostWorkspaceDir?: string;
  model?: string;
  thinkingLevel?: string;
  cwd?: string;
  stepRunId: string;
  iterationId: string;
  issueId?: string;
  registry?: StepSessionRegistry;
  onStdout?: (chunk: string, agent: StepAgentInfo) => void;
  onStderr?: (chunk: string, agent: StepAgentInfo) => void;
  onEvent?: (event: SessionEvent, agent: StepAgentInfo) => void;
  onWorkerStart?: (
    item: WorkerTask,
    total: number,
    agent: StepAgentInfo,
  ) => void;
  timeoutMs?: number;
}