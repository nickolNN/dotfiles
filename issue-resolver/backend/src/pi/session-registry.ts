import type {
  ControlResult,
  PromptMode,
  PromptResult,
  RoomAgent,
  SessionEvent,
  SessionStats,
  SessionUsage,
} from '@issue-resolver/shared';

/**
 * Реестр живых pi-сессий шагов конвейера. Позволяет адресовать команды
 * управления (steer/abort/prompt/control) как по stepRunId, так и по
 * iterationId (роуты пользователя знают только итерацию).
 */
export interface StepSessionControl {
  steer(text: string): void;
  abort(): void;
  respond(payload: UiResponsePayload): void;
  /** Отправляет промпт в живую сессию; режим задаёт streamingBehavior. */
  prompt(message: string, mode?: PromptMode): Promise<PromptResult>;
  /** Произвольная RPC-команда pi (модель, компакция, режимы и т.п.). */
  send(command: Record<string, unknown>): Promise<ControlResult>;
}

/** Ответ пользователя на интерактивный вопрос расширения pi. */
export interface UiResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** Терминальные/промежуточный статус агента комнаты. */
export type RoomAgentStatus = RoomAgent['status'];

/**
 * Дескриптор агента комнаты при регистрации сессии. `id` — per-agent
 * stepRunId (адрес сессии в реестре и в SSE `agentId`).
 */
export interface RoomAgentInfo {
  id: string;
  role: RoomAgent['role'];
  index: number | null;
  label: string;
  /** Номер этапа staged-режима (1-based); null/отсутствует у обычной комнаты. */
  stage?: number | null;
  /** Имя этапа staged-режима; null/отсутствует иначе. */
  stageName?: string | null;
}

/**
 * Address of a live session. `run` is one exact address; `iteration` is that
 * run's anchor — the last session registered for it, because a room has N
 * workers plus a coordinator and only one of them speaks for the run.
 */
export type SessionTarget =
  | { by: 'iteration'; id: string }
  | { by: 'run'; id: string };

/** Addresses the anchor session of a run. */
export const iterationTarget = (id: string): SessionTarget => ({
  by: 'iteration',
  id,
});

/** Addresses exactly one session by its own id. */
export const runTarget = (id: string): SessionTarget => ({ by: 'run', id });

export interface StepSessionRegistry {
  /** Регистрирует control активной сессии шага; `agent` — если это агент комнаты. */
  register(
    stepRunId: string,
    iterationId: string,
    control: StepSessionControl,
    agent?: RoomAgentInfo,
  ): void;
  /**
   * Снимает регистрацию сессии (по завершении шага). Для агента комнаты
   * проставляет финальный `status` (по умолчанию 'finished') и оставляет его в
   * списке `listAgents`, чтобы вкладка осталась доступной.
   */
  unregister(stepRunId: string, status?: RoomAgentStatus): void;
  /** Steer по stepRunId; true — сессия найдена и команда вызвана. */
  steer(stepRunId: string, text: string): boolean;
  /** Abort по stepRunId; true — сессия найдена и команда вызвана. */
  abort(stepRunId: string): boolean;
  /**
   * Steer ВО ВСЕ активные сессии итерации (broadcast); true — задет хотя бы
   * один. В room-режиме у итерации N исполнителей + координатор.
   */
  steerByIteration(iterationId: string, text: string): boolean;
  /**
   * Abort ВСЕХ активных сессий итерации (broadcast); true — задет хотя бы
   * один.
   */
  abortByIteration(iterationId: string): boolean;
  /** Есть ли живая сессия у итерации. */
  hasByIteration(iterationId: string): boolean;
  /** Ответ на UI-вопрос по stepRunId; true — сессия найдена. */
  respond(stepRunId: string, payload: UiResponsePayload): boolean;
  /**
   * Ответ на UI-вопрос по «якорной» сессии итерации; true — сессия найдена.
   * Вопрос задаёт и потребляет ровно одна сессия, поэтому не broadcast.
   */
  respondByIteration(
    iterationId: string,
    payload: UiResponsePayload,
  ): boolean;
  /**
   * Prompt to the addressed session; null when it is not live. Never broadcast:
   * a prompt produces exactly one result.
   */
  prompt(
    target: SessionTarget,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null;
  /** RPC command to the addressed session; null when it is not live. */
  send(
    target: SessionTarget,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null;
  /**
   * Агенты комнаты итерации в порядке регистрации (Исполнитель 1..N, Координатор).
   * Включает уже завершённых (со своим финальным статусом); не-комнатные
   * сессии (single-режим) в список не попадают.
   */
  listAgents(iterationId: string): RoomAgent[];
  /**
   * Записывает событие сессии агента комнаты для телеметрии `listAgents().stats`.
   * Не-агентские сессии (single-режим) молча игнорируются; прочие типы событий
   * не интересуют — учитываются только `usage` и `stats`.
   */
  recordEvent(stepRunId: string, event: SessionEvent): void;
}

interface SessionEntry {
  iterationId: string;
  control: StepSessionControl;
}

/**
 * Телеметрия агента комнаты: агрегат `usage`-событий (токены/cost) и
 * последнее `stats`-событие (`get_session_stats`) для контекста и счётчиков.
 * Держим агрегат, а не весь буфер событий — реестр не должен расти с длиной
 * сессии.
 */
interface AgentEntry {
  /** Публичный дескриптор без `stats` (считается в `listAgents`). */
  agent: RoomAgent;
  /** Сумма токенов ЗАВЕРШЁННЫХ ответов (`usage` кумулятивен внутри ответа). */
  usage: SessionUsage;
  /** Снапшот текущего (последнего) ответа; null — ответов ещё не было. */
  pending: SessionUsage | null;
  /** Было ли хотя бы одно `usage`-событие (иначе токены берём из stats). */
  usageSeen: boolean;
  /** Сумма cost завершённых ответов; null — ни один не нёс cost. */
  cost: number | null;
  /** cost текущего ответа; null — неизвестен. */
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

/** Токены агента: завершённые ответы + текущий снапшот. */
function aggregateUsage(entry: AgentEntry): SessionUsage {
  const total = { ...entry.usage };
  if (entry.pending) addUsage(total, entry.pending);
  return total;
}

/** Стоимость агента: завершённые ответы + текущий снапшот; null без cost. */
function aggregateCost(entry: AgentEntry): number | null {
  if (entry.pendingCost === null) return entry.cost;
  return (entry.cost ?? 0) + entry.pendingCost;
}

/**
 * Собирает `SessionStats` агента: токены/cost — из агрегата `usage`-событий,
 * контекст/счётчики/model — из последнего `stats`-события. null, пока
 * телеметрии нет вовсе.
 */
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

/** Потолок числа итераций с сохранёнными агентами (защита от утечки памяти). */
const MAX_TRACKED_AGENT_ITERATIONS = 64;

/**
 * In-memory реестр: прямой Map stepRunId → сессия и обратный
 * iterationId → множество активных stepRunId (Set хранит порядок вставки).
 *
 * У итерации в room-режиме одновременно живут N исполнителей (stepRunId
 * `${stepRunId}/worker/<i>`) и позже координатор (stepRunId === шага).
 * steer/abort адресуют ВСЕ активные сессии (broadcast), а prompt/send/
 * respond — «якорную» (последнюю зарегистрированную): её результат —
 * единственный Promise/ControlResult, а вопрос потребляет одна сессия.
 */
export class InMemoryStepSessionRegistry implements StepSessionRegistry {
  private readonly byStepRun = new Map<string, SessionEntry>();
  private readonly activeByIteration = new Map<string, Set<string>>();
  // Агенты комнаты переживают unregister (статус остаётся для вкладок).
  private readonly agentsByIteration = new Map<
    string,
    Map<string, AgentEntry>
  >();
  // Быстрый доступ к телеметрии агента по его адресу (per-agent stepRunId).
  private readonly agentEntryByStepRun = new Map<string, AgentEntry>();
  register(
    stepRunId: string,
    iterationId: string,
    control: StepSessionControl,
    agent?: RoomAgentInfo,
  ): void {
    this.byStepRun.set(stepRunId, { iterationId, control });
    // Добавляем в set итерации; порядок вставки = порядок регистрации.
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
        // Завершённые агенты остаются в памяти бессрочно — ограничиваем
        // число итераций FIFO-эвикцией (активные всегда в хвосте).
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
    // Пустой set — итерация без живых сессий. Не сносим чужие сессии.
    if (sessions.size === 0) this.activeByIteration.delete(entry.iterationId);
  }

  listAgents(iterationId: string): RoomAgent[] {
    const agents = this.agentsByIteration.get(iterationId);
    if (!agents) return [];
    // Копии: вызывающий не должен мутировать внутреннее состояние реестра.
    return [...agents.values()].map((entry) => ({
      ...entry.agent,
      stats: buildAgentStats(entry),
    }));
  }

  recordEvent(stepRunId: string, event: SessionEvent): void {
    const entry = this.agentEntryByStepRun.get(stepRunId);
    if (!entry) return;
    if (event.type === 'usage') {
      // `usage` кумулятивен ВНУТРИ ответа и сбрасывается на новом: падение
      // total — граница ответа, фиксируем предыдущий снапшот и начинаем новый.
      // Иначе берём последний (максимальный) снапшот того же ответа.
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
    // Broadcast: room-итерация имеет несколько живых сессий.
    let hit = false;
    for (const stepRunId of this.activeStepRunIds(iterationId)) {
      if (this.steer(stepRunId, text)) hit = true;
    }
    return hit;
  }

  abortByIteration(iterationId: string): boolean {
    // Broadcast: abort должен накрыть всех исполнителей и координатора.
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

  /** One lookup for both operations; the union keeps the surface small. */
  private entryFor(target: SessionTarget): SessionEntry | undefined {
    if (target.by === 'run') return this.byStepRun.get(target.id);
    return this.anchorEntry(target.id) ?? undefined;
  }

  /** Снимок активных stepRunId итерации в порядке регистрации. */
  private activeStepRunIds(iterationId: string): string[] {
    const sessions = this.activeByIteration.get(iterationId);
    return sessions ? [...sessions] : [];
  }

  /** stepRunId «якорной» (последней зарегистрированной) сессии итерации. */
  private anchorStepRunId(iterationId: string): string | null {
    return this.activeStepRunIds(iterationId).at(-1) ?? null;
  }

  /** «Якорная» сессия итерации или null. */
  private anchorEntry(iterationId: string): SessionEntry | null {
    const stepRunId = this.anchorStepRunId(iterationId);
    if (!stepRunId) return null;
    return this.byStepRun.get(stepRunId) ?? null;
  }
}