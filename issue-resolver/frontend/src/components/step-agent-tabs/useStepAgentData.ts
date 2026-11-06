import { useEffect, useMemo, useRef, useState } from 'react';
import { StepAgentStatus, type StepAgent } from '@issue-resolver/shared';
import type { SessionEvent } from '../../api/session-events';
import { getStepAgents } from '../../api/client';
import { subscribeToAgentEvents } from '../../api/sse';
import { AsyncStateStatus, errorState } from '../../lib/async-state';
import { formatDuration, useNow } from '../../lib/time';
import {
  agentDurationMs,
  computeStepTotals,
  pickDefaultAgentId,
  sortAgents,
} from './agents';
import { groupAgentsByStage } from './stage-groups';
import type { AgentsState, StepAgentTabsProps } from './types';

interface UseStepAgentDataOptions {
  iterationId: string;
  eventsByAgent?: Record<string, SessionEvent[]>;
  refreshKey: number;
  statusPollMs: number;
  emptyRetryMs: number;
  maxEmptyRetries: number;
}

export function useStepAgentData({
  iterationId,
  eventsByAgent,
  refreshKey,
  statusPollMs,
  emptyRetryMs,
  maxEmptyRetries,
}: UseStepAgentDataOptions) {
  const [agentsState, setAgentsState] = useState<AgentsState>({
    status: AsyncStateStatus.loading,
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
      setAgentsState({ status: AsyncStateStatus.loading });
      retryCountRef.current = 0;
    } else {
      setAgentsState((current) =>
        current.status === AsyncStateStatus.ready || current.status === AsyncStateStatus.empty
          ? current
          : { status: AsyncStateStatus.loading },
      );
    }

    getStepAgents(iterationId)
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
        setAgentsState(
          sorted.length === 0
            ? { status: AsyncStateStatus.empty }
            : { status: AsyncStateStatus.ready, data: sorted },
        );
        setSelectedId((current) => pickDefaultAgentId(sorted, current));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAgentsState(errorState(error));
      });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [iterationId, refreshKey, pollTick, emptyRetryMs, maxEmptyRetries]);

  const agents = agentsState.status === AsyncStateStatus.ready ? agentsState.data : [];
  const hasRunningAgent = agents.some(
    (agent) => agent.status === StepAgentStatus.running,
  );

  const now = useNow(hasRunningAgent);

  useEffect(() => {
    if (!hasRunningAgent || statusPollMs <= 0) return;
    const id = setInterval(() => setPollTick((tick) => tick + 1), statusPollMs);
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

  const selected: StepAgent | null =
    agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null;

  const events = useMemo(() => {
    if (!selected) return [];
    return [
      ...(eventsByAgent?.[selected.id] ?? []),
      ...(liveByAgent[selected.id] ?? []),
    ];
  }, [eventsByAgent, liveByAgent, selected]);

  const stepTotals = useMemo(
    () => computeStepTotals(agents, now),
    [agents, now],
  );

  const stageGroups = useMemo(
    () => groupAgentsByStage(agents, now),
    [agents, now],
  );

  const selectedDuration = selected
    ? formatDuration(agentDurationMs(selected, now))
    : '';

  return {
    agentsState,
    agents,
    selected,
    selectedId,
    selectAgent: setSelectedId,
    selectedDuration,
    events,
    stepTotals,
    stageGroups,
  };
}
export type { StepAgentTabsProps };