import type {
  ControlResult,
  PromptMode,
  PromptResult,
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

export interface StepSessionRegistry {
  /** Регистрирует control активной сессии шага. */
  register(
    stepRunId: string,
    iterationId: string,
    control: StepSessionControl,
  ): void;
  /** Снимает регистрацию сессии (по завершении шага). */
  unregister(stepRunId: string): void;
  /** Steer по stepRunId; true — сессия найдена и команда вызвана. */
  steer(stepRunId: string, text: string): boolean;
  /** Abort по stepRunId; true — сессия найдена и команда вызвана. */
  abort(stepRunId: string): boolean;
  /** Steer по активной сессии итерации; true — сессия найдена. */
  steerByIteration(iterationId: string, text: string): boolean;
  /** Abort по активной сессии итерации; true — сессия найдена. */
  abortByIteration(iterationId: string): boolean;
  /** Есть ли живая сессия у итерации. */
  hasByIteration(iterationId: string): boolean;
  /** Ответ на UI-вопрос по stepRunId; true — сессия найдена. */
  respond(stepRunId: string, payload: UiResponsePayload): boolean;
  /** Ответ на UI-вопрос по активной сессии итерации; true — сессия найдена. */
  respondByIteration(
    iterationId: string,
    payload: UiResponsePayload,
  ): boolean;
  /** Промпт в живую сессию итерации; null — живой сессии нет. */
  promptByIteration(
    iterationId: string,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null;
  /** RPC-команда в живую сессию итерации; null — живой сессии нет. */
  sendByIteration(
    iterationId: string,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null;
}

interface SessionEntry {
  iterationId: string;
  control: StepSessionControl;
}

/**
 * In-memory реестр: прямой Map stepRunId → сессия и обратный
 * iterationId → активный stepRunId для адресации по итерации.
 */
export class InMemoryStepSessionRegistry implements StepSessionRegistry {
  private readonly byStepRun = new Map<string, SessionEntry>();
  private readonly activeByIteration = new Map<string, string>();

  register(
    stepRunId: string,
    iterationId: string,
    control: StepSessionControl,
  ): void {
    this.byStepRun.set(stepRunId, { iterationId, control });
    // Новый шаг итерации вытесняет предыдущий как активный.
    this.activeByIteration.set(iterationId, stepRunId);
  }

  unregister(stepRunId: string): void {
    const entry = this.byStepRun.get(stepRunId);
    if (!entry) return;
    this.byStepRun.delete(stepRunId);
    // Не сносим обратную ссылку, если она уже указывает на другой шаг.
    if (this.activeByIteration.get(entry.iterationId) === stepRunId) {
      this.activeByIteration.delete(entry.iterationId);
    }
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
    const stepRunId = this.activeByIteration.get(iterationId);
    if (!stepRunId) return false;
    return this.steer(stepRunId, text);
  }

  abortByIteration(iterationId: string): boolean {
    const stepRunId = this.activeByIteration.get(iterationId);
    if (!stepRunId) return false;
    return this.abort(stepRunId);
  }

  hasByIteration(iterationId: string): boolean {
    return this.activeEntry(iterationId) !== null;
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
    const stepRunId = this.activeByIteration.get(iterationId);
    if (!stepRunId) return false;
    return this.respond(stepRunId, payload);
  }

  promptByIteration(
    iterationId: string,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null {
    const entry = this.activeEntry(iterationId);
    if (!entry) return null;
    return entry.control.prompt(message, mode);
  }

  sendByIteration(
    iterationId: string,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null {
    const entry = this.activeEntry(iterationId);
    if (!entry) return null;
    return entry.control.send(command);
  }

  /** Активная сессия итерации или null. */
  private activeEntry(iterationId: string): SessionEntry | null {
    const stepRunId = this.activeByIteration.get(iterationId);
    if (!stepRunId) return null;
    return this.byStepRun.get(stepRunId) ?? null;
  }
}