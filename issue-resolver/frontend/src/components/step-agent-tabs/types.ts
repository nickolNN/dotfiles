import type { SessionStats, StepAgent } from '@issue-resolver/shared';
import type { SessionEvent } from '../../api/session-events';
import type { AsyncState } from '../../lib/async-state';

export interface StepAgentTabsProps {
  iterationId: string;
  eventsByAgent?: Record<string, SessionEvent[]>;
  statsByAgent?: Record<string, SessionStats | null>;
  refreshKey?: number;
  statusPollMs?: number;
  emptyMessage?: string;
  emptyRetryMs?: number;
  maxEmptyRetries?: number;
}

export type AgentsState = AsyncState<StepAgent[]>;

export interface StageGroup extends StepTotals {
  stage: number;
  name: string;
  models: string[];
  contextPercent: number | null;
}

export interface StepTotals {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costEstimate: boolean;
  wallMs: number | null;
}