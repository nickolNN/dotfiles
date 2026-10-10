import type {
  ControlResult,
  PromptMode,
  PromptResult,
  RoomAgent,
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
}

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
   * один. В room-режиме у итерации N воркеров + координатор.
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
   * Промпт в «якорную» (последнюю зарегистрированную) сессию итерации;
   * null — живой сессии нет. Не broadcast: результат — единственный Promise.
   */
  promptByIteration(
    iterationId: string,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null;
  /**
   * RPC-команда в «якорную» сессию итерации; null — живой сессии нет.
   * Не broadcast: результат — единственный ControlResult.
   */
  sendByIteration(
    iterationId: string,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null;
  /**
   * Агенты комнаты итерации в порядке регистрации (Воркер 1..N, Координатор).
   * Включает уже завершённых (со своим финальным статусом); не-комнатные
   * сессии (single-режим) в список не попадают.
   */
  listAgents(iterationId: string): RoomAgent[];
}

interface SessionEntry {
  iterationId: string;
  control: StepSessionControl;
}

/** Потолок числа итераций с сохранёнными агентами (защита от утечки памяти). */
const MAX_TRACKED_AGENT_ITERATIONS = 64;

/**
 * In-memory реестр: прямой Map stepRunId → сессия и обратный
 * iterationId → множество активных stepRunId (Set хранит порядок вставки).
 *
 * У итерации в room-режиме одновременно живут N воркеров (stepRunId
 * `${stepRunId}/worker/<i>`) и позже координатор (stepRunId === шага).
 * steer/abort адресуют ВСЕ активные сессии (broadcast), а prompt/send/
 * respond — «якорную» (последнюю зарегистрированную): её результат —
 * единственный Promise/ControlResult, а вопрос потребляет одна сессия.
 */
export class InMemoryStepSessionRegistry implements StepSessionRegistry {
  private readonly byStepRun = new Map<string, SessionEntry>();
  private readonly activeByIteration = new Map<string, Set<string>>();
  // Агенты комнаты переживают unregister (статус остаётся для вкладок).
  private readonly agentsByIteration = new Map<string, Map<string, RoomAgent>>();
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
          this.agentsByIteration.delete(oldest);
        }
      }
      agents.set(stepRunId, {
        id: stepRunId,
        role: agent.role,
        index: agent.index,
        label: agent.label,
        status: 'running',
      });
    }
  }

  unregister(stepRunId: string, status: RoomAgentStatus = 'finished'): void {
    const entry = this.byStepRun.get(stepRunId);
    if (!entry) return;
    this.byStepRun.delete(stepRunId);
    const agent = this.agentsByIteration.get(entry.iterationId)?.get(stepRunId);
    if (agent) agent.status = status;
    const sessions = this.activeByIteration.get(entry.iterationId);
    if (!sessions) return;
    sessions.delete(stepRunId);
    // Пустой set — итерация без живых сессий. Не сносим чужие сессии.
    if (sessions.size === 0) this.activeByIteration.delete(entry.iterationId);
  }

  listAgents(iterationId: string): RoomAgent[] {
    const agents = this.agentsByIteration.get(iterationId);
    // Копии: вызывающий не должен мутировать внутреннее состояние реестра.
    return agents ? [...agents.values()].map((agent) => ({ ...agent })) : [];
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
    // Broadcast: abort должен накрыть всех воркеров и координатора.
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

  promptByIteration(
    iterationId: string,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null {
    const entry = this.anchorEntry(iterationId);
    if (!entry) return null;
    return entry.control.prompt(message, mode);
  }

  sendByIteration(
    iterationId: string,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null {
    const entry = this.anchorEntry(iterationId);
    if (!entry) return null;
    return entry.control.send(command);
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