import type {
  ContainerSpec,
  RunInstructionsStatus,
  SessionEvent,
  ThinkingLevel,
} from '@issue-resolver/shared';
import type { ContainerController } from '../../docker/controller';
import type { GitService } from '../../git/service';
import type { DevOpsAgent } from '../devops';
import type { DevopsModelSettings } from '../run-deps';
import type { StepSessionRegistry } from '../../pi/session-registry';

export interface RunInstructionsPort {
  getStatus(repoUrl: string): RunInstructionsStatus | undefined;
  getInstructions(repoUrl: string): string | null;
  saveGenerated(repoUrl: string, instructions: string): void;
  saveFailed(repoUrl: string): void;
}

export type DevOpsFactory = (params: {
  containerName: string;
  hostWorkspaceDir: string;
  containerWorkspaceDir: string;
  issueId: string;
  iterationId?: string;
  stepRunId?: string;
  registry?: StepSessionRegistry;
  tagInstructions?: string | null;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
  reposNames?: string | null;
  reposRequireDevServer?: string | null;
  reposInstructions?: string | null;
}) => DevOpsAgent;

export interface PrepareWorkspaceDeps extends DevopsModelSettings {
  container: ContainerController;
  git: GitService;
  workspaceRoot?: string;
  local?: boolean;
  devops?: DevOpsFactory;
  runInstructions?: RunInstructionsPort;
  devServerPort?: number;
  onDevOpsStdout?: (repo: string, chunk: string) => void;
  onDevOpsStderr?: (repo: string, chunk: string) => void;
  onDevOpsEvent?: (repo: string, event: SessionEvent) => void;
  issueId?: string;
  iterationId?: string;
  control?: StepSessionRegistry;
  tagInstructions?: string | null;
  reposNames?: string | null;
  reposRequireDevServer?: string | null;
  reposInstructions?: string | null;
}

export interface PrepareContext {
  deps: PrepareWorkspaceDeps;
  issueId: string;
  workspaceHostDir: string;
  containerName: string;
  spec: ContainerSpec;
}

export type { WorkspaceProgress, WorkspaceProgressReporter, WorkspaceProgressStep } from '@issue-resolver/shared';