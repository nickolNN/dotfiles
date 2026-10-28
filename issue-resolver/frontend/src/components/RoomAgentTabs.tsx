import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomAgent, SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import { getRoomAgents } from '../api/client';
import { subscribeToAgentEvents } from '../api/sse';
import AutoScrollBox from './AutoScrollBox';
import { formatTokens, TokenDownIcon, TokenUpIcon } from './SessionStatsBar';
import { CacheIcon } from './TokenStats';
import SessionView from './SessionView';
import { formatDuration, useNow } from '../lib/time';

export interface RoomAgentTabsProps {
  iterationId: string;
  eventsByAgent?: Record<string, SessionEvent[]>;
  statsByAgent?: Record<string, SessionStats | null>;
  refreshKey?: number;
  statusPollMs?: number;
  emptyMessage?: string;
  emptyRetryMs?: number;
  maxEmptyRetries?: number;
}

type AgentsState =
  | { status: 'loading' }
  | { status: 'ready'; agents: RoomAgent[] }
  | { status: 'error'; message: string };

export interface StageGroup {
  stage: number;
  name: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  wallMs: number | null;
  models: string[];
  contextPercent: number | null;
}

export function groupAgentsByStage(
  agents: RoomAgent[],
  now: number,
): StageGroup[] {
  const byStage = new Map<number, RoomAgent[]>();
  for (const agent of agents) {
    if (agent.stage == null) continue;
    const list = byStage.get(agent.stage);
    if (list) list.push(agent);
    else byStage.set(agent.stage, [agent]);
  }

  return [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, stageAgents]) => {
      let tokens = 0;
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let cost = 0;
      const models: string[] = [];
      let contextPercent: number | null = null;
      let firstStart = Number.POSITIVE_INFINITY;
      let lastEnd = Number.NEGATIVE_INFINITY;

      for (const agent of stageAgents) {
        const t = agent.stats?.tokens;
        tokens += t?.total ?? 0;
        input += t?.input ?? 0;
        output += t?.output ?? 0;
        cacheRead += t?.cacheRead ?? 0;
        cacheWrite += t?.cacheWrite ?? 0;
        cost += agent.stats?.cost ?? 0;

        const model = agent.stats?.model?.trim();
        if (model && !models.includes(model)) models.push(model);

        const percent = agent.stats?.contextUsage?.percent;
        if (typeof percent === 'number' && Number.isFinite(percent)) {
          contextPercent =
            contextPercent === null
              ? percent
              : Math.max(contextPercent, percent);
        }

        const start = startMillis(agent);
        if (start !== null) {
          firstStart = Math.min(firstStart, start);
          const endMs =
            agent.status === 'running'
              ? now
              : endMillis(agent);
          if (endMs !== null) {
            lastEnd = Math.max(lastEnd, Math.max(start, endMs));
          }
        }
      }

      const name =
        stageAgents.find((agent) => agent.stageName?.trim())?.stageName?.trim() ??
        `Этап ${stage}`;
      const wallMs =
        Number.isFinite(firstStart) && Number.isFinite(lastEnd)
          ? Math.max(0, lastEnd - firstStart)
          : null;

      return { stage, name, tokens, input, output, cacheRead, cacheWrite, cost, wallMs, models, contextPercent };
    });
}

const STATUS_COLOR: Record<RoomAgent['status'], string> = {
  running: '#00FF41',
  finished: '#00FF41',
  aborted: '#FF0033',
  failed: '#FF0033',
};

function sortAgents(agents: RoomAgent[]): RoomAgent[] {
  const roleRank = (agent: RoomAgent) => (agent.role === 'worker' ? 0 : 1);
  const stageRank = (agent: RoomAgent) =>
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

function tabLabel(agent: RoomAgent): string {
  if (
    agent.role === 'coordinator' &&
    (agent.stage === null || agent.stage === undefined) &&
    !/lead/i.test(agent.label)
  ) {
    return `${agent.label} (lead)`;
  }
  return agent.label;
}

function formatCost(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '$0';
  return `$${total.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function startMillis(agent: RoomAgent): number | null {
  if (!agent.startedAt) return null;
  const parsed = Date.parse(agent.startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function endMillis(agent: RoomAgent): number | null {
  if (agent.status === 'running' || !agent.endedAt) return null;
  const parsed = Date.parse(agent.endedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function agentDurationMs(
  agent: RoomAgent,
  now: number,
): number | null {
  const start = startMillis(agent);
  if (start === null) return null;
  if (agent.status === 'running') return Math.max(0, now - start);
  const end = endMillis(agent);
  if (end === null) return null;
  return Math.max(0, end - start);
}

function pickDefaultAgentId(
  agents: RoomAgent[],
  current: string | null,
): string | null {
  if (current) {
    const currentAgent = agents.find((agent) => agent.id === current);
    if (currentAgent && currentAgent.status === 'running') return current;
  }
  return (
    agents.find((agent) => agent.status === 'running')?.id ?? agents[0]?.id ?? null
  );
}

export default function RoomAgentTabs({
  iterationId,
  eventsByAgent,
  statsByAgent,
  refreshKey = 0,
  statusPollMs = 3000,
  emptyMessage,
  emptyRetryMs = 1000,
  maxEmptyRetries = 5,
}: RoomAgentTabsProps) {
  const [agentsState, setAgentsState] = useState<AgentsState>({
    status: 'loading',
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveByAgent, setLiveByAgent] = useState<
    Record<string, SessionEvent[]>
  >({});
  const [pollTick, setPollTick] = useState(0);
  const loadedIterationRef = useRef<string | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const changedIteration = loadedIterationRef.current !== iterationId;
    loadedIterationRef.current = iterationId;

    if (changedIteration) {
      setSelectedId(null);
      setLiveByAgent({});
      setAgentsState({ status: 'loading' });
      retryCountRef.current = 0;
    } else {
      setAgentsState((current) =>
        current.status === 'ready' ? current : { status: 'loading' },
      );
    }

    getRoomAgents(iterationId)
      .then((agents) => {
        if (cancelled) return;
        const sorted = sortAgents(Array.isArray(agents) ? agents : []);
        if (
          sorted.length === 0 &&
          changedIteration &&
          retryCountRef.current < maxEmptyRetries
        ) {
          retryCountRef.current += 1;
          retryTimer = setTimeout(
            () => setPollTick((tick) => tick + 1),
            emptyRetryMs,
          );
          return;
        }
        retryCountRef.current = 0;
        setAgentsState({ status: 'ready', agents: sorted });
        setSelectedId((current) => pickDefaultAgentId(sorted, current));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAgentsState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [iterationId, refreshKey, pollTick]);

  const hasRunningAgent =
    agentsState.status === 'ready' &&
    agentsState.agents.some((agent) => agent.status === 'running');

  const now = useNow(hasRunningAgent);

  useEffect(() => {
    if (!hasRunningAgent || statusPollMs <= 0) return;
    const id = setInterval(
      () => setPollTick((tick) => tick + 1),
      statusPollMs,
    );
    return () => clearInterval(id);
  }, [hasRunningAgent, statusPollMs]);

  useEffect(() => {
    if (!selectedId) return;

    let disposed = false;
    const unsubscribe = subscribeToAgentEvents(iterationId, selectedId, {
      onEvent: (payload) => {
        if (disposed) return;
        const key = payload.agentId ?? selectedId;
        setLiveByAgent((current) => ({
          ...current,
          [key]: [...(current[key] ?? []), payload.event].slice(-500),
        }));
      },
      onStepStatus: () => {
        if (disposed) return;
        setPollTick((tick) => tick + 1);
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [iterationId, selectedId]);

  const agents = agentsState.status === 'ready' ? agentsState.agents : [];
  const selected =
    agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null;

  const events = useMemo(() => {
    if (!selected) return [];
    return [
      ...(eventsByAgent?.[selected.id] ?? []),
      ...(liveByAgent[selected.id] ?? []),
    ];
  }, [eventsByAgent, liveByAgent, selected]);

  const stepTotals = useMemo(() => {
    let tokens = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
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
      const start = startMillis(agent);
      if (start !== null) {
        firstStart = Math.min(firstStart, start);
        const endMs =
          agent.status === 'running'
            ? now
            : endMillis(agent);
        if (endMs !== null) {
          lastEnd = Math.max(lastEnd, Math.max(start, endMs));
          if (agent.status === 'running') anyRunning = true;
        } else if (agent.status === 'running') {
          anyRunning = true;
        }
      }
    }
    const wallMs =
      Number.isFinite(firstStart) && Number.isFinite(lastEnd)
        ? Math.max(0, anyRunning ? now - firstStart : lastEnd - firstStart)
        : null;
    return { tokens, input, output, cacheRead, cacheWrite, cost, wallMs };
  }, [agents, now]);

  const stageGroups = useMemo(
    () => groupAgentsByStage(agents, now),
    [agents, now],
  );

  const selectedDuration = selected
    ? formatDuration(agentDurationMs(selected, now))
    : '';

  if (agentsState.status === 'loading') {
    return (
      <p
        data-testid="room-agents-loading"
        className="mt-2 text-xs text-[#00FF41]/60"
      >
        Загрузка агентов…
      </p>
    );
  }

  if (agentsState.status === 'error') {
    return (
      <p
        data-testid="room-agents-error"
        role="alert"
        className="mt-2 text-xs font-medium text-[#FF0033]"
      >
        Не удалось загрузить агентов: {agentsState.message}
      </p>
    );
  }

  if (agents.length === 0 || !selected) {
    return (
      <p
        data-testid="room-agents-empty"
        className="mt-2 text-xs text-[#00FF41]/60"
      >
        Агенты комнаты не найдены.
      </p>
    );
  }

  return (
    <div data-testid="room-agents" className="mt-2">
      <p
        data-testid="room-step-summary"
        className="mb-1 text-[10px] tracking-wider text-[#00FF41]/60"
      >
        Всего:{' '}
        <span className="inline-flex items-baseline gap-0.5">
          <TokenUpIcon />
          {formatTokens(stepTotals.input)}
        </span>{' '}
        <span className="inline-flex items-baseline gap-0.5">
          <TokenDownIcon />
          {formatTokens(stepTotals.output)}
        </span>{' '}
        <span className="inline-flex items-baseline gap-0.5">
          <CacheIcon />
          {formatTokens(stepTotals.cacheRead + stepTotals.cacheWrite)}
        </span>{' '}
        · {formatCost(stepTotals.cost)}{' '}
        ·{' '}
        {stepTotals.wallMs === null
          ? '—'
          : formatDuration(stepTotals.wallMs)}
      </p>
      {stageGroups.length > 0 && (
        <div data-testid="room-stage-summary" className="mb-1 space-y-0.5">
          {stageGroups.map((group) => (
            <p
              key={group.stage}
              data-testid="room-stage-group"
              data-stage={group.stage}
              data-stage-name={group.name}
              className="text-[10px] tracking-wider text-[#00FF41]/60"
            >
              <span
                data-testid="room-stage-name"
                className="text-[#00FF41]/80"
              >
                {group.name}
              </span>{' '}
              ·{' '}
              <span
                data-testid="room-stage-tokens"
                className="inline-flex items-baseline gap-0.5"
              >
                <TokenUpIcon />
                {formatTokens(group.input)}
              </span>{' '}
              <span className="inline-flex items-baseline gap-0.5">
                <TokenDownIcon />
                {formatTokens(group.output)}
              </span>{' '}
              <span className="inline-flex items-baseline gap-0.5">
                <CacheIcon />
                {formatTokens(group.cacheRead + group.cacheWrite)}
              </span>{' '}
              ·{' '}
              <span data-testid="room-stage-cost">
                {formatCost(group.cost)}
              </span>{' '}
              ·{' '}
              <span data-testid="room-stage-duration">
                {group.wallMs === null ? '—' : formatDuration(group.wallMs)}
              </span>{' '}
              ·{' '}
              <span data-testid="room-stage-models">
                {group.models.length > 0 ? group.models.join(', ') : '—'}
              </span>
              {group.contextPercent !== null && (
                <>
                  {' '}
                  ·{' '}
                  <span data-testid="room-stage-context">
                    CTX {Math.round(group.contextPercent)}%
                  </span>
                </>
              )}
            </p>
          ))}
        </div>
      )}
      <div
        role="tablist"
        aria-label="Агенты комнаты"
        className="flex flex-wrap gap-1 border-b border-[#008F11]/40 pb-1"
      >
        {agents.map((agent) => {
          const isSelected = agent.id === selected.id;
          return (
            <button
              key={agent.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              data-testid="room-agent-tab"
              data-agent-id={agent.id}
              data-role={agent.role}
              data-selected={isSelected ? 'true' : 'false'}
              data-status={agent.status}
              onClick={() => setSelectedId(agent.id)}
              className={`flex items-center gap-1 border px-2 py-0.5 text-[10px] uppercase tracking-wider${
                isSelected
                  ? ' border-[#00FF41] bg-[#003B00] text-[#00FF41]'
                  : ' border-[#008F11] text-[#00FF41]/70 hover:border-[#00FF41] hover:text-[#00FF41]'
              }`}
            >
              <span>{tabLabel(agent)}</span>
              <span
                data-testid="room-agent-status"
                style={{ color: STATUS_COLOR[agent.status] }}
              >
                {agent.status}
              </span>
            </button>
          );
        })}
      </div>

      {selectedDuration !== '' && (
        <p
          data-testid="room-agent-duration"
          className="mt-1 text-[10px] tracking-wider text-[#00FF41]/60"
        >
          ⏱ {tabLabel(selected)} · {selectedDuration}
        </p>
      )}

      <div data-testid="room-agent-session" data-agent-id={selected.id}>
        <AutoScrollBox
          scrollKey={events.length}
          className="mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
        >
          <SessionView
            events={events}
            stats={selected.stats ?? statsByAgent?.[selected.id] ?? null}
            running={selected.status === 'running'}
            showFooter
            emptyMessage={emptyMessage}
          />
        </AutoScrollBox>
      </div>
    </div>
  );
}