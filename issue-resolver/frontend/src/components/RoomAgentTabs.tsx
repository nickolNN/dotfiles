import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomAgent, SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import { getRoomAgents } from '../api/client';
import { subscribeToAgentEvents } from '../api/sse';
import AutoScrollBox from './AutoScrollBox';
import SessionView from './SessionView';

export interface RoomAgentTabsProps {
  /** Итерация, чьих агентов комнаты показываем. */
  iterationId: string;
  /**
   * Персистентные события агента (id → events), например из GET /step-runs.
   * Мержатся с live-потоком выбранного агента.
   */
  eventsByAgent?: Record<string, SessionEvent[]>;
  /** Статистика pi-сессии агента (id → stats). */
  statsByAgent?: Record<string, SessionStats | null>;
  /**
   * Меняйте значение, чтобы перечитать список агентов (обычно — refreshTick
   * родителя, который он бампает на `step_status`).
   */
  refreshKey?: number;
  /**
   * Период опроса списка, пока есть работающий агент (мс). Статус воркера
   * меняется на `finished` в реестре бэкенда без отдельного `step_status`, а
   * resolve-шаг публикует статус только в конце — опрос нужен, чтобы вкладки
   * не висели в `running`. `<= 0` — выключить.
   */
  statusPollMs?: number;
  /** Текст пустого состояния сессии выбранного агента. */
  emptyMessage?: string;
}

type AgentsState =
  | { status: 'loading' }
  | { status: 'ready'; agents: RoomAgent[] }
  | { status: 'error'; message: string };

/** Цвет статуса вкладки/подписи (терминальные аварийные — красные). */
const STATUS_COLOR: Record<RoomAgent['status'], string> = {
  running: '#00FF41',
  finished: '#00FF41',
  aborted: '#FF0033',
  failed: '#FF0033',
};

/** Стабильный порядок вкладок: воркеры по индексу, координатор — последним. */
function sortAgents(agents: RoomAgent[]): RoomAgent[] {
  const roleRank = (agent: RoomAgent) => (agent.role === 'worker' ? 0 : 1);
  return [...agents].sort((a, b) => {
    if (roleRank(a) !== roleRank(b)) return roleRank(a) - roleRank(b);
    return (
      (a.index ?? Number.MAX_SAFE_INTEGER) -
      (b.index ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

/** Подпись вкладки: у координатора явно помечаем роль (lead). */
function tabLabel(agent: RoomAgent): string {
  if (agent.role === 'coordinator' && !/lead/i.test(agent.label)) {
    return `${agent.label} (lead)`;
  }
  return agent.label;
}

/**
 * Выбирает агента по умолчанию: сохраняем прежний выбор, иначе — первый
 * ещё работающий, иначе — первый в стабильном порядке.
 */
function pickDefaultAgentId(
  agents: RoomAgent[],
  current: string | null,
): string | null {
  if (current && agents.some((agent) => agent.id === current)) return current;
  return (
    agents.find((agent) => agent.status === 'running')?.id ?? agents[0]?.id ?? null
  );
}

/**
 * Вкладки живых агентов комнаты resolve: для итерации в room-режиме
 * сосуществуют N воркеров и координатор. Выбор вкладки переключает живой
 * `SessionView` ИМЕННО этого агента (свой per-agent SSE-поток).
 *
 * Родитель (карточка шага) рендерит компонент только при
 * `execution.mode === 'room'`; для single-режима остаётся обычная сессия.
 */
export default function RoomAgentTabs({
  iterationId,
  eventsByAgent,
  statsByAgent,
  refreshKey = 0,
  statusPollMs = 3000,
  emptyMessage,
}: RoomAgentTabsProps) {
  const [agentsState, setAgentsState] = useState<AgentsState>({
    status: 'loading',
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Live-события per-agent: переключение вкладки не теряет уже собранное.
  const [liveByAgent, setLiveByAgent] = useState<
    Record<string, SessionEvent[]>
  >({});
  // Тик опроса статусов, пока есть работающий агент.
  const [pollTick, setPollTick] = useState(0);
  // Итерация, для которой уже загружен список: смена итерации — это сброс и
  // «Загрузка…», refreshKey/опрос — фоновое обновление без мигания.
  const loadedIterationRef = useRef<string | null>(null);

  // Список агентов: перечитывается при смене итерации и по refreshKey
  // родителя. Best-effort клиент возвращает [] вместо ошибки, но reject
  // тоже обрабатываем — компонент не должен ронять карточку.
  useEffect(() => {
    let cancelled = false;
    const changedIteration = loadedIterationRef.current !== iterationId;
    loadedIterationRef.current = iterationId;

    if (changedIteration) {
      // Новая итерация: прошлый выбор и live-буферы больше не актуальны.
      setSelectedId(null);
      setLiveByAgent({});
      setAgentsState({ status: 'loading' });
    } else {
      // Фоновое обновление не должно мигать «Загрузка…» и терять вкладки.
      setAgentsState((current) =>
        current.status === 'ready' ? current : { status: 'loading' },
      );
    }

    getRoomAgents(iterationId)
      .then((agents) => {
        if (cancelled) return;
        const sorted = sortAgents(Array.isArray(agents) ? agents : []);
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
    };
  }, [iterationId, refreshKey, pollTick]);

  // Пока хоть один агент работает, периодически перечитываем список: реестр
  // бэкенда помечает воркера `finished` без SSE, а resolve-шаг публикует
  // `step_status` только по завершении всего шага.
  const hasRunningAgent =
    agentsState.status === 'ready' &&
    agentsState.agents.some((agent) => agent.status === 'running');

  useEffect(() => {
    if (!hasRunningAgent || statusPollMs <= 0) return;
    const id = setInterval(
      () => setPollTick((tick) => tick + 1),
      statusPollMs,
    );
    return () => clearInterval(id);
  }, [hasRunningAgent, statusPollMs]);

  // Подписка на поток выбранного агента. Смена вкладки закрывает прежний
  // EventSource (эффект чистит подписку) и открывает поток нового агента.
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

      <div data-testid="room-agent-session" data-agent-id={selected.id}>
        <AutoScrollBox
          scrollKey={events.length}
          className="mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
        >
          <SessionView
            events={events}
            stats={statsByAgent?.[selected.id] ?? null}
            running={selected.status === 'running'}
            showFooter={false}
            emptyMessage={emptyMessage}
          />
        </AutoScrollBox>
      </div>
    </div>
  );
}