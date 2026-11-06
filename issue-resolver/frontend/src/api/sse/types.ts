import type { IssueDeletingPhase, SSEEvent } from '@issue-resolver/shared';
import type { SessionEvent } from '../session-events';

export type StepEventPayload = {
  stepRunId?: string;
  agentId?: string;
  event: SessionEvent;
};

export type WorkspaceProgressPayload = {
  step: string;
  repo?: string;
  status: string;
  message?: string;
  devPort?: number;
};

export type IssueDeletingPayload = {
  issueId: string;
  phase: IssueDeletingPhase;
  message?: string;
  ts: string;
};

export type IssueDeletedPayload = {
  issueId: string;
  ts: string;
};

export type ContainerStatsPayload = {
  cpuPercent: number | null;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
};

export type SseCallbacks = {
  onLog?(e: SSEEvent): void;
  onStepStatus?(e: SSEEvent): void;
  onIterationStatus?(e: SSEEvent): void;
  onStepEvent?(payload: StepEventPayload, raw: SSEEvent): void;
  onWorkspaceProgress?(payload: WorkspaceProgressPayload, raw: SSEEvent): void;
  onIssueDeleting?(payload: IssueDeletingPayload, raw: SSEEvent): void;
  onIssueDeleted?(payload: IssueDeletedPayload, raw: SSEEvent): void;
  onContainerStats?(payload: ContainerStatsPayload, raw: SSEEvent): void;
  onError?(err: unknown): void;
};

export type AgentEventPayload = {
  stepRunId?: string;
  agentId?: string;
  event: SessionEvent;
};

export type AgentSseCallbacks = {
  onEvent?(payload: AgentEventPayload, raw?: SSEEvent): void;
  onStepStatus?(e: SSEEvent): void;
  onError?(err: unknown): void;
};