import { StepAgentStatus } from '@issue-resolver/shared';
import type {
  ControlResult,
  PromptMode,
  PromptResult,
  SessionEvent,
  StepAgent,
} from '@issue-resolver/shared';
import type {
  SessionTarget,
  StepAgentInfo,
  StepSessionControl,
  StepSessionRegistry,
  UiResponsePayload,
} from './contracts';
import {
  MAX_TRACKED_AGENT_ITERATIONS,
  buildAgentStats,
  emptyAgentEntry,
  recordUsageEvent,
  type AgentEntry,
} from './usage';
import { nowIso } from '../../db/rows';

interface SessionEntry {
  iterationId: string;
  control: StepSessionControl;
}

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
    agent?: StepAgentInfo,
  ): void {
    this.byStepRun.set(stepRunId, { iterationId, control });
    let sessions = this.activeByIteration.get(iterationId);
    if (!sessions) {
      sessions = new Set();
      this.activeByIteration.set(iterationId, sessions);
    }
    sessions.add(stepRunId);
    if (agent) {
      const agents = this.agentsFor(iterationId);
      agents.set(stepRunId, emptyAgentEntry(stepRunId, agent));
      this.agentEntryByStepRun.set(stepRunId, agents.get(stepRunId)!);
    }
  }

  unregister(
    stepRunId: string,
    status: StepAgentStatus = StepAgentStatus.finished,
  ): void {
    const entry = this.byStepRun.get(stepRunId);
    if (!entry) return;
    this.byStepRun.delete(stepRunId);
    const agent = this.agentsByIteration.get(entry.iterationId)?.get(stepRunId);
    if (agent) {
      agent.agent.status = status;
      agent.agent.endedAt = nowIso();
    }
    const sessions = this.activeByIteration.get(entry.iterationId);
    if (!sessions) return;
    sessions.delete(stepRunId);
    if (sessions.size === 0) this.activeByIteration.delete(entry.iterationId);
  }

  listAgents(iterationId: string): StepAgent[] {
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
      recordUsageEvent(entry, event);
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

  private agentsFor(iterationId: string): Map<string, AgentEntry> {
    const existing = this.agentsByIteration.get(iterationId);
    if (existing) return existing;

    const agents = new Map<string, AgentEntry>();
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
    return agents;
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