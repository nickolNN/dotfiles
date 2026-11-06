import type {
  SSEEventType,
  SSEStream,
  WorkspaceProgressStatus,
  WorkspaceProgressStep,
} from '../status';

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

export interface WorkspaceProgress {
  step: WorkspaceProgressStep;
  repo?: string;
  status: WorkspaceProgressStatus;
  message?: string;
  devPort?: number;
}

export type WorkspaceProgressReporter = (progress: WorkspaceProgress) => void;

export interface SSEEvent {
  type: SSEEventType;
  issueId: string;
  iterationId?: string;
  stepRunId?: string;
  agentId?: string;
  stream?: SSEStream;
  data: string;
  ts: string;
}