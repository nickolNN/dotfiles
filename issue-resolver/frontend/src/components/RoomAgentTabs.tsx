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
   * Период опроса списка, пока есть работающий агент (мс). Статус исполнителя
   * меняется на `finished` в реестре бэкенда без отдельного `step_status`, а
   * resolve-шаг публикует статус только в конце — опрос нужен, чтобы вкладки
   * не висели в `running`. `<= 0` — выключить.
   */
  statusPollMs?: number;
  /** Текст пустого состояния сессии выбранного агента. */
  emptyMessage?: string;
  /**
   * Задержка между ретраями, когда агенты ещё не зарегистрированы (мс).
   * По умолчанию 1000. Тесты выставляют 0 для мгновенного истощения ретраев.
   */
  emptyRetryMs?: number;
  /**
   * Число ретраев при пустом ответе на первый запрос (changedIteration).
   * По умолчанию 5. Тесты выставляют 0, чтобы сразу показать заглушку.
   */
  maxEmptyRetries?: number;
}

type AgentsState =
  | { status: 'loading' }
  | { status: 'ready'; agents: RoomAgent[] }
  | { status: 'error'; message: string };

/** Агрегат по одному этапу staged-режима (сводка над вкладками агентов). */
export interface StageGroup {
  /** 1-based номер этапа. */
  stage: number;
  /** Подпись этапа: `stageName`, иначе «Этап N». */
  name: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Wall-time этапа (от первого старта до последнего конца); null без тайминга. */
  wallMs: number | null;
  /** Уникальные модели агентов этапа (пусто, если телеметрии нет). */
  models: string[];
  /** Максимальный context% среди агентов этапа; null, если данных нет. */
  contextPercent: number | null;
}

/**
 * Группирует агентов staged-режима по `stage` (по возрастанию) и считает
 * агрегаты этапа. Агенты без `stage` (обычная комната, финальный координатор)
 * в сводку не попадают. Чистая функция — экспортируется для точечных тестов.
 */
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

/** Цвет статуса вкладки/подписи (терминальные аварийные — красные). */
const STATUS_COLOR: Record<RoomAgent['status'], string> = {
  running: '#00FF41',
  finished: '#00FF41',
  aborted: '#FF0033',
  failed: '#FF0033',
};

/**
 * Стабильный порядок вкладок.
 *
 * В staged-режиме агенты группируются по этапу: сначала этап 1 (исполнители,
 * затем координатор этапа), потом этап 2, …; в самом конце — финальный
 * координатор и обычная комната (у них `stage` = null → MAX_SAFE_INTEGER).
 * Внутри этапа: исполнители раньше координатора, затем по `index`.
 */
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

/**
 * Подпись вкладки: номер этапа уже приходит в label от бэкенда («Этап N · …»),
 * поэтому staged-агентов не трогаем. « (lead)» добавляем только финальному
 * координатору (stage == null), как и раньше.
 */
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

/** Компактная стоимость: `$0` / `$0.0123` / `$1.5`. */
function formatCost(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '$0';
  return `$${total.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** Старт агента в мс эпохи; null, если тайминга нет/битый ISO. */
function startMillis(agent: RoomAgent): number | null {
  if (!agent.startedAt) return null;
  const parsed = Date.parse(agent.startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Конец агента в мс эпохи; null, если тайминга нет/битый ISO или running. */
function endMillis(agent: RoomAgent): number | null {
  if (agent.status === 'running' || !agent.endedAt) return null;
  const parsed = Date.parse(agent.endedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Длительность агента: у running — живой `now - start`, у терминального —
 * `endedAt - startedAt` (из бэкенда). Если терминальный агент без endedAt —
 * возвращаем null (длительность неизвестна), а НЕ now (это давало live-тик).
 */
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

/**
 * Выбирает агента по умолчанию: сохраняем прежний выбор, если он ещё
 * работает; иначе — первый ещё работающий; иначе — первый в порядке.
 */
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

/**
 * Вкладки живых агентов комнаты resolve: для итерации в room-режиме
 * сосуществуют N исполнителей и координатор. Выбор вкладки переключает живой
 * `SessionView` ИМЕННО этого агента (свой per-agent SSE-поток).
 *
 * Родитель (карточка шага) рендерит компонент при
 * `execution.mode === 'room'` или `'stages'`; для single-режима остаётся
 * обычная сессия.
 */
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
  // Live-события per-agent: переключение вкладки не теряет уже собранное.
  const [liveByAgent, setLiveByAgent] = useState<
    Record<string, SessionEvent[]>
  >({});
  // Тик опроса статусов, пока есть работающий агент.
  const [pollTick, setPollTick] = useState(0);
  // Итерация, для которой уже загружен список: смена итерации — это сброс и
  // «Загрузка…», refreshKey/опрос — фоновое обновление без мигания.
  const loadedIterationRef = useRef<string | null>(null);
  // Счётчик ретраев для случая, когда агенты ещё не зарегистрированы, а
  // resolve-шаг уже стартовал (гонка между рендером RoomAgentTabs и
  // spawn'ом pi-исполнителей). Без ретраев пустой ответ немедленно покажет
  // «Агенты комнаты не найдены» и больше не перечитает (нет hasRunningAgent).
  const retryCountRef = useRef(0);

  // Список агентов: перечитывается при смене итерации и по refreshKey
  // родителя. Best-effort клиент возвращает [] вместо ошибки, но reject
  // тоже обрабатываем — компонент не должен ронять карточку.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const changedIteration = loadedIterationRef.current !== iterationId;
    loadedIterationRef.current = iterationId;

    if (changedIteration) {
      // Новая итерация: прошлый выбор и live-буферы больше не актуальны.
      setSelectedId(null);
      setLiveByAgent({});
      setAgentsState({ status: 'loading' });
      retryCountRef.current = 0;
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
        // Гонка старта: resolve-шаг уже активен, но pi-исполнители ещё не
        // заспавнились и не зарегистрировались в реестре бэкенда. Пустой
        // ответ при первом фетче (changedIteration) ретраим до 5 раз с
        // интервалом 1 с — за это время агенты успевают появиться.
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

  // Пока хоть один агент работает, периодически перечитываем список: реестр
  // бэкенда помечает исполнителя `finished` без SSE, а resolve-шаг публикует
  // `step_status` только по завершении всего шага.
  const hasRunningAgent =
    agentsState.status === 'ready' &&
    agentsState.agents.some((agent) => agent.status === 'running');

  // Один живой тик на компонент, пока работает хоть один агент комнаты.
  const now = useNow(hasRunningAgent);

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
      onStepStatus: () => {
        if (disposed) return;
        // Агент изменил статус (завершился/упал) — немедленно перечитываем
        // список, без ожидания полла. pickDefaultAgentId переключит вкладку.
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

  // Итог по всему шагу: сумма токенов/cost всех агентов и wall-time от первого
  // старта до `now` (тик живёт, пока работает хоть один агент, и замирает,
  // когда все завершились).
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
    // Если все агенты завершены — фактическая длительность шага
    // (lastEnd - firstStart) из бэкендового endedAt.
    // Если хоть один running — elapsed с начала.
    const wallMs =
      Number.isFinite(firstStart) && Number.isFinite(lastEnd)
        ? Math.max(0, anyRunning ? now - firstStart : lastEnd - firstStart)
        : null;
    return { tokens, input, output, cacheRead, cacheWrite, cost, wallMs };
  }, [agents, now]);

  // Сводка по этапам staged-режима (обычная комната и финальный координатор
  // без `stage` в неё не входят).
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