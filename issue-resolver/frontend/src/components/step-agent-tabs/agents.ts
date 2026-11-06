import {
  StepAgentRole,
  StepAgentStatus,
  type StepAgent,
} from '@issue-resolver/shared';
import type { StepTotals } from './types';

export function sortAgents(agents: StepAgent[]): StepAgent[] {
  const roleRank = (agent: StepAgent) =>
    agent.role === StepAgentRole.worker ? 0 : 1;
  const stageRank = (agent: StepAgent) =>
    agent.stage ?? Number.MAX_SAFE_INTEGER;
  return [...agents].sort((a, b) => {
    if (stageRank(a) !== stageRank(b)) return stageRank(a) - stageRank(b);
    if (roleRank(a) !== roleRank(b)) return roleRank(a) - roleRank(b);
    return (
      (a.index ?? Number.MAX_SAFE_INTEGER) -
      (b.index ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

export function tabLabel(agent: StepAgent): string {
  if (
    agent.role === StepAgentRole.coordinator &&
    (agent.stage === null || agent.stage === undefined) &&
    !/lead/i.test(agent.label)
  ) {
    return `${agent.label} (lead)`;
  }
  return agent.label;
}

export function startMillis(agent: StepAgent): number | null {
  if (!agent.startedAt) return null;
  const parsed = Date.parse(agent.startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function endMillis(agent: StepAgent): number | null {
  if (agent.status === StepAgentStatus.running || !agent.endedAt) return null;
  const parsed = Date.parse(agent.endedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function agentDurationMs(
  agent: StepAgent,
  now: number,
): number | null {
  const start = startMillis(agent);
  if (start === null) return null;
  if (agent.status === StepAgentStatus.running) return Math.max(0, now - start);
  const end = endMillis(agent);
  if (end === null) return null;
  return Math.max(0, end - start);
}

export function pickDefaultAgentId(
  agents: StepAgent[],
  current: string | null,
): string | null {
  if (current) {
    const currentAgent = agents.find((agent) => agent.id === current);
    if (currentAgent && currentAgent.status === StepAgentStatus.running) {
      return current;
    }
  }
  return (
    agents.find((agent) => agent.status === StepAgentStatus.running)?.id ??
    agents[0]?.id ??
    null
  );
}

export function computeStepTotals(
  agents: StepAgent[],
  now: number,
): StepTotals {
  let tokens = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let costEstimate = false;
  let firstStart = Number.POSITIVE_INFINITY;
  let lastEnd = Number.NEGATIVE_INFINITY;
  let anyRunning = false;
  for (const agent of agents) {
    const t = agent.stats?.tokens;
    tokens += t?.total ?? 0;
    input += t?.input ?? 0;
    output += t?.output ?? 0;
    cacheRead += t?.cacheRead ?? 0;
    cacheWrite += t?.cacheWrite ?? 0;
    cost += agent.stats?.cost ?? 0;
    if (agent.stats && agent.stats.costFromProvider !== true) costEstimate = true;
    const start = startMillis(agent);
    if (start !== null) {
      firstStart = Math.min(firstStart, start);
      const endMs =
        agent.status === StepAgentStatus.running ? now : endMillis(agent);
      if (endMs !== null) {
        lastEnd = Math.max(lastEnd, Math.max(start, endMs));
        if (agent.status === StepAgentStatus.running) anyRunning = true;
      } else if (agent.status === StepAgentStatus.running) {
        anyRunning = true;
      }
    }
  }
  const wallMs =
    Number.isFinite(firstStart) && Number.isFinite(lastEnd)
      ? Math.max(0, anyRunning ? now - firstStart : lastEnd - firstStart)
      : null;
  return {
    tokens,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    costEstimate,
    wallMs,
  };
}