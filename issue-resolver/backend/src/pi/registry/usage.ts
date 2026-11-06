import { StepAgentStatus } from '@issue-resolver/shared';
import type {
  SessionEvent,
  SessionStats,
  SessionUsage,
  StepAgent,
} from '@issue-resolver/shared';
import { nowIso } from '../../db/rows';

export interface AgentEntry {
  agent: StepAgent;
  usage: SessionUsage;
  pending: SessionUsage | null;
  usageSeen: boolean;
  cost: number | null;
  pendingCost: number | null;
  lastStats: SessionStats | null;
}

export const MAX_TRACKED_AGENT_ITERATIONS = 64;

export const zeroUsage = (): SessionUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

export const addUsage = (target: SessionUsage, source: SessionUsage): void => {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
};

export function emptyAgentEntry(
  stepRunId: string,
  info: {
    role: StepAgent['role'];
    index: number | null;
    label: string;
    stage?: number | null;
    stageName?: string | null;
  },
): AgentEntry {
  return {
    agent: {
      id: stepRunId,
      role: info.role,
      index: info.index,
      label: info.label,
      stage: info.stage ?? null,
      stageName: info.stageName ?? null,
      status: StepAgentStatus.running,
      startedAt: nowIso(),
      endedAt: null,
      stats: null,
    },
    usage: zeroUsage(),
    pending: null,
    usageSeen: false,
    cost: null,
    pendingCost: null,
    lastStats: null,
  };
}

export function aggregateUsage(entry: AgentEntry): SessionUsage {
  const total = { ...entry.usage };
  if (entry.pending) addUsage(total, entry.pending);
  return total;
}

export function aggregateCost(entry: AgentEntry): number | null {
  if (entry.pendingCost === null) return entry.cost;
  return (entry.cost ?? 0) + entry.pendingCost;
}

export function buildAgentStats(entry: AgentEntry): SessionStats | null {
  const base = entry.lastStats;
  if (!entry.usageSeen && !base) return null;
  return {
    ...(base?.sessionId === undefined ? {} : { sessionId: base.sessionId }),
    ...(base?.model === undefined ? {} : { model: base.model }),
    userMessages: base?.userMessages ?? 0,
    assistantMessages: base?.assistantMessages ?? 0,
    toolCalls: base?.toolCalls ?? 0,
    toolResults: base?.toolResults ?? 0,
    totalMessages: base?.totalMessages ?? 0,
    tokens: entry.usageSeen
      ? aggregateUsage(entry)
      : (base?.tokens ?? zeroUsage()),
    cost: entry.usageSeen ? aggregateCost(entry) : (base?.cost ?? null),
    contextUsage: base?.contextUsage ?? null,
  };
}

export function recordUsageEvent(
  entry: AgentEntry,
  event: Extract<SessionEvent, { type: 'usage' }>,
): void {
  if (entry.pending && event.usage.total < entry.pending.total) {
    addUsage(entry.usage, entry.pending);
    if (entry.pendingCost !== null) {
      entry.cost = (entry.cost ?? 0) + entry.pendingCost;
    }
    entry.pending = null;
    entry.pendingCost = null;
  }
  entry.pending = { ...event.usage };
  if (event.cost) entry.pendingCost = event.cost.total;
  entry.usageSeen = true;
}