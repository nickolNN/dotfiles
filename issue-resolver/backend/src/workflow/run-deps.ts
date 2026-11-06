import type { ThinkingLevel } from '@issue-resolver/shared';
import type { ContainerController } from '../docker/controller';
import type { GitService } from '../git/service';
import type { PiRunner } from '../pi/runner';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { MrClient } from '../pr/mr';
import type { SseHub } from '../sse/hub';
import type { DevOpsFactory } from './prepare-workspace';

export interface WorkflowCore {
  container: ContainerController;
  git: GitService;
  pi: PiRunner;
  sse: SseHub;
  mr: MrClient;
  control: StepSessionRegistry;
  local?: boolean;
  workspaceRoot?: string;
}

export interface DevopsModelSettings {
  devopsModel?: string;
  devopsThinkingLevel?: ThinkingLevel;
  devopsTimeoutMs?: number;
}

export interface DevopsSettings extends DevopsModelSettings {
  devopsFactory?: DevOpsFactory;
}