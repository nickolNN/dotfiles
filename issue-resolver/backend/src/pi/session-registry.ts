import type {
  ControlResult,
  PromptMode,
  PromptResult,
  RoomAgent,
  SessionEvent,
  SessionStats,
  SessionUsage,
} from '@issue-resolver/shared';

export interface StepSessionControl {
  steer(text: string): void;
  abort(): void;
  respond(payload: UiResponsePayload): void;
  prompt(message: string, mode?: PromptMode): Promise<PromptResult>;
  send(command: Record<string, unknown>): Promise<ControlResult>;
}

export interface UiResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export type RoomAgentStatus = RoomAgent['status'];

export interface RoomAgentInfo {
  id: string;
  role: RoomAgent['role'];
  index: number | null;
  label: string;
  stage?: number | null;
  stageName?: string | null;
}

export type SessionTarget =
  | { by: 'iteration'; id: string }
  | { by: 'run'; id: string };

export const iterationTarget = (id: string): SessionTarget => ({
  by: 'iteration',
  id,
});

export const runTarget = (id: string): SessionTarget => ({ by: 'run', id });

export interface StepSessionRegistry {
  register(
    stepRunId: string,
    iterationId: string,
    control: StepSessionControl,
    agent?: RoomAgentInfo,
  ): void;
  unregister(stepRunId: string, status?: RoomAgentStatus): void;
  steer(stepRunId: string, text: string): boolean;
  abort(stepRunId: string): boolean;
  steerByIteration(iterationId: string, text: string): boolean;
  abortByIteration(iterationId: string): boolean;
  hasByIteration(iterationId: string): boolean;
  respond(stepRunId: string, payload: UiResponsePayload): boolean;
  respondByIteration(
    iterationId: string,
    payload: UiResponsePayload,
  ): boolean;
  prompt(
    target: SessionTarget,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null;
  send(
    target: SessionTarget,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null;
  listAgents(iterationId: string): RoomAgent[];
  recordEvent(stepRunId: string, event: SessionEvent): void;
}

interface SessionEntry {
  iterationId: string;
  control: StepSessionControl;
}

interface AgentEntry {
  agent: RoomAgent;
  usage: SessionUsage;
  pending: SessionUsage | null;
  usageSeen: boolean;
  cost: number | null;
  pendingCost: number | null;
  lastStats: SessionStats | null;
}

const zeroUsage = (): SessionUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

const addUsage = (target: SessionUsage, source: SessionUsage): void => {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
};

function aggregateUsage(entry: AgentEntry): SessionUsage {
  const total = { ...entry.usage };
  if (entry.pending) addUsage(total, entry.pending);
  return total;
}

function aggregateCost(entry: AgentEntry): number | null {
  if (entry.pendingCost === null) return entry.cost;
  return (entry.cost ?? 0) + entry.pendingCost;
}

function buildAgentStats(entry: AgentEntry): SessionStats | null {
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
    tokens: entry.usageSeen ? aggregateUsage(entry) : (base?.tokens ?? zeroUsage()),
    cost: entry.usageSeen ? aggregateCost(entry) : (base?.cost ?? null),
    contextUsage: base?.contextUsage ?? null,
  };
}

const MAX_TRACKED_AGENT_ITERATIONS = 64;

export class InMemoryStepSessionRegistry implements StepSessionRegistry {
  private readonly byStepRun = new Map<string, SessionEntry>();
  private readonly activeByIteration = new Map<string, Set<string>>();
  private readonly agentsByIteration = new Map<
    string,
    Map<string, AgentEntry>
  >();
  private readonly agentEntryByStepRun = new Map<string, AgentEntry>();
  register(
    stepRunId: string,
    iterationId: string,
    control: StepSessionControl,
    agent?: RoomAgentInfo,
  ): void {
    this.byStepRun.set(stepRunId, { iterationId, control });
    let sessions = this.activeByIteration.get(iterationId);
    if (!sessions) {
      sessions = new Set();
      this.activeByIteration.set(iterationId, sessions);
    }
    sessions.add(stepRunId);
    if (agent) {
      let agents = this.agentsByIteration.get(iterationId);
      if (!agents) {
        agents = new Map();
        this.agentsByIteration.set(iterationId, agents);
        while (this.agentsByIteration.size > MAX_TRACKED_AGENT_ITERATIONS) {
          const oldest = this.agentsByIteration.keys().next().value;
          if (oldest === undefined) break;
          const evicted = this.agentsByIteration.get(oldest);
          this.agentsByIteration.delete(oldest);
          if (evicted) {
            for (const evictedStepRunId of evicted.keys()) {
              this.agentEntryByStepRun.delete(evictedStepRunId);
            }
          }
        }
      }
      const entry: AgentEntry = {
        agent: {
          id: stepRunId,
          role: agent.role,
          index: agent.index,
          label: agent.label,
          stage: agent.stage ?? null,
          stageName: agent.stageName ?? null,
          status: 'running',
          startedAt: new Date().toISOString(),
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
      agents.set(stepRunId, entry);
      this.agentEntryByStepRun.set(stepRunId, entry);
    }
  }

  unregister(stepRunId: string, status: RoomAgentStatus = 'finished'): void {
    const entry = this.byStepRun.get(stepRunId);
    if (!entry) return;
    this.byStepRun.delete(stepRunId);
    const agent = this.agentsByIteration.get(entry.iterationId)?.get(stepRunId);
    if (agent) {
      agent.agent.status = status;
      agent.agent.endedAt = new Date().toISOString();
    }
    const sessions = this.activeByIteration.get(entry.iterationId);
    if (!sessions) return;
    sessions.delete(stepRunId);
    if (sessions.size === 0) this.activeByIteration.delete(entry.iterationId);
  }

  listAgents(iterationId: string): RoomAgent[] {
    const agents = this.agentsByIteration.get(iterationId);
    if (!agents) return [];
    return [...agents.values()].map((entry) => ({
      ...entry.agent,
      stats: buildAgentStats(entry),
    }));
  }

  recordEvent(stepRunId: string, event: SessionEvent): void {
    const entry = this.agentEntryByStepRun.get(stepRunId);
    if (!entry) return;
    if (event.type === 'usage') {
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
      return;
    }
    if (event.type === 'stats') entry.lastStats = event.stats;
  }

  steer(stepRunId: string, text: string): boolean {
    const entry = this.byStepRun.get(stepRunId);
    if (!entry) return false;
    entry.control.steer(text);
    return true;
  }

  abort(stepRunId: string): boolean {
    const entry = this.byStepRun.get(stepRunId);
    if (!entry) return false;
    entry.control.abort();
    return true;
  }

  steerByIteration(iterationId: string, text: string): boolean {
    let hit = false;
    for (const stepRunId of this.activeStepRunIds(iterationId)) {
      if (this.steer(stepRunId, text)) hit = true;
    }
    return hit;
  }

  abortByIteration(iterationId: string): boolean {
    let hit = false;
    for (const stepRunId of this.activeStepRunIds(iterationId)) {
      if (this.abort(stepRunId)) hit = true;
    }
    return hit;
  }

  hasByIteration(iterationId: string): boolean {
    const sessions = this.activeByIteration.get(iterationId);
    return sessions !== undefined && sessions.size > 0;
  }

  respond(stepRunId: string, payload: UiResponsePayload): boolean {
    const entry = this.byStepRun.get(stepRunId);
    if (!entry) return false;
    entry.control.respond(payload);
    return true;
  }

  respondByIteration(
    iterationId: string,
    payload: UiResponsePayload,
  ): boolean {
    const stepRunId = this.anchorStepRunId(iterationId);
    if (!stepRunId) return false;
    return this.respond(stepRunId, payload);
  }

  prompt(
    target: SessionTarget,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null {
    const entry = this.entryFor(target);
    if (!entry) return null;
    return entry.control.prompt(message, mode);
  }

  send(
    target: SessionTarget,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null {
    const entry = this.entryFor(target);
    if (!entry) return null;
    return entry.control.send(command);
  }

  private entryFor(target: SessionTarget): SessionEntry | undefined {
    if (target.by === 'run') return this.byStepRun.get(target.id);
    return this.anchorEntry(target.id) ?? undefined;
  }

  private activeStepRunIds(iterationId: string): string[] {
    const sessions = this.activeByIteration.get(iterationId);
    return sessions ? [...sessions] : [];
  }

  private anchorStepRunId(iterationId: string): string | null {
    return this.activeStepRunIds(iterationId).at(-1) ?? null;
  }

  private anchorEntry(iterationId: string): SessionEntry | null {
    const stepRunId = this.anchorStepRunId(iterationId);
    if (!stepRunId) return null;
    return this.byStepRun.get(stepRunId) ?? null;
  }
}