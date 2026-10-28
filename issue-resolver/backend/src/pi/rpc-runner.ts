import { spawn } from 'node:child_process';
import {
  parseSessionStats,
  type CompactionReason,
  type ControlResult,
  type PipelineStep,
  type PromptMode,
  type PromptResult,
  type SessionCost,
  type SessionEvent,
  type SessionQuestion,
  type SessionSpeed,
  type SessionStats,
  type SessionUsage,
  type StepExecutionResult,
  type StepReport,
  isValidPiSessionId,
} from '@issue-resolver/shared';
import type { PiRunOptions, PiRunner } from './runner';
import type { RoomAgentStatus, UiResponsePayload } from './session-registry';

/** Событие протокола pi RPC (поля, которые нам нужны для разбора). */
interface RpcAssistantMessageEvent {
  type?: string;
  contentIndex?: number;
  delta?: unknown;
  content?: unknown;
  id?: unknown;
  toolName?: unknown;
  toolCall?: unknown;
}

interface RpcEvent {
  type?: string;
  aborted?: boolean;
  assistantMessageEvent?: RpcAssistantMessageEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
  durationMs?: number;
  willRetry?: boolean;
  /** Кумулятивное usage ответа ассистента (`message_update.usage`). */
  usage?: unknown;
  /** Поля response-записей (`{type:'response', command, id, success, data}`). */
  command?: string;
  id?: string;
  data?: unknown;
  success?: boolean;
  error?: unknown;
  /** Поля `extension_ui_request` (интерактивный диалог расширения). */
  method?: string;
  title?: string;
  /** `extension_ui_request.message` (строка) либо полное сообщение `message_start`/`message_end` (объект). */
  message?: unknown;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: unknown;
  statusKey?: unknown;
  statusText?: unknown;
  widgetKey?: unknown;
  widgetLines?: unknown;
  widgetPlacement?: unknown;
  text?: unknown;
  /** Поля событий компакции, ретраев, очереди и статуса сессии. */
  reason?: unknown;
  errorMessage?: unknown;
  source?: unknown;
  attempt?: unknown;
  maxAttempts?: unknown;
  delayMs?: unknown;
  finalError?: unknown;
  steering?: unknown;
  followUp?: unknown;
  level?: unknown;
  name?: unknown;
  delta?: unknown;
}

/**
 * Методы `extension_ui_request`, которые БЛОКИРУЮТ pi до `extension_ui_response`
 * (настоящий интерактивный вопрос). Остальные (`notify`, `setStatus`,
 * `setWidget`, `setTitle`, `set_editor_text`) — fire-and-forget, ответа не ждут
 * и вопросом не являются.
 */
const DIALOG_METHODS = new Set<SessionQuestion['method']>([
  'select',
  'confirm',
  'input',
  'editor',
]);

/** Колбэки живого разбора: проза шага (stdout) и структурированные события. */
export interface RpcParseHandlers {
  onStdout?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
  /** Ответ `get_session_stats` (разобранный и нормализованный). */
  onStats?: (stats: SessionStats) => void;
}

/** Число из сырого поля usage; всё нечисловое/не-конечное → 0. */
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Нормализация `message_update.usage` в `SessionUsage` (totalTokens → total). */
const normalizeUsage = (raw: Record<string, unknown>): SessionUsage => {
  const input = num(raw.input);
  const output = num(raw.output);
  const cacheRead = num(raw.cacheRead);
  const cacheWrite = num(raw.cacheWrite);
  const total =
    num(raw.totalTokens) || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
};

/** Нормализация `message_update.usage.cost`; не-объект → null. */
const normalizeCost = (raw: unknown): SessionCost | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return {
    input: num(obj.input),
    output: num(obj.output),
    cacheRead: num(obj.cacheRead),
    cacheWrite: num(obj.cacheWrite),
    total: num(obj.total),
  };
};

/** Порог средней скорости, мс: раньше оценка нестабильна и не показывается. */
const SPEED_MIN_ELAPSED_MS = 1000;
/** Минимальный интервал между выборками мгновенной скорости, мс. */
const SPEED_MIN_INTERVAL_MS = 250;
/** Коэффициент экспоненциального сглаживания мгновенной скорости. */
const SPEED_SMOOTHING_ALPHA = 0.3;

/** Число из необязательного поля события; нечисловое/не-конечное → null. */
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Строка из необязательного поля события; не-строка → null. */
const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** Массив строк из необязательного поля события; иное → []. */
const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

/** Объект-запись из unknown; массивы/примитивы → null. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const COMPACTION_REASONS: ReadonlySet<string> = new Set([
  'manual',
  'threshold',
  'overflow',
]);

/** Причина компакции из события; неизвестная/отсутствующая → 'manual'. */
const compactionReason = (value: unknown): CompactionReason =>
  typeof value === 'string' && COMPACTION_REASONS.has(value)
    ? (value as CompactionReason)
    : 'manual';

/**
 * Текст ответа пользователя для события `question_answered`. select/input/
 * editor шлют `value`; confirm — `confirmed` (Да/Нет), закрытие — `Отменено`.
 */
const questionAnswerText = (payload: UiResponsePayload): string => {
  if (payload.value !== undefined) return payload.value;
  if (payload.confirmed !== undefined) return payload.confirmed ? 'Да' : 'Нет';
  if (payload.cancelled === true) return 'Отменено';
  return '';
};

/** Финальный статус агента комнаты по результату прогона. */
const agentStatusFor = (result: StepExecutionResult): RoomAgentStatus => {
  if (result.aborted) return 'aborted';
  return result.exitCode !== 0 ? 'failed' : 'finished';
};

/** resultText из tool_execution_end: тексты content[] или structuredContent. */
const toolResultText = (result: unknown): string => {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part && typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
        )
        .join('');
      if (text.length > 0) return text;
    }
    const structured = (result as { structuredContent?: unknown })
      .structuredContent;
    if (structured !== undefined) return JSON.stringify(structured);
  }
  return '';
};

/**
 * Чистый разбор потока событий `pi --mode rpc` по подтипам.
 *
 * В stdout попадает ТОЛЬКО проза агента (`text_delta`, авторитетно
 * фиксируемая `text_end.content`) — аргументы tool-call (`toolcall_delta`)
 * в него не пишутся. Структурированные события (текст-блоки, `tool_use`,
 * `tool_result`) собираются в упорядоченный массив и отдаются в `onEvent`
 * по мере прихода.
 */
export class RpcSessionParser {
  private readonly handler: RpcParseHandlers;
  private readonly textByIndex = new Map<number, string>();
  private readonly textOrder: number[] = [];
  private readonly emittedText = new Set<number>();
  private readonly thinkingByIndex = new Map<number, string>();
  private readonly thinkingOrder: number[] = [];
  private readonly emittedThinking = new Set<number>();
  private readonly collected: SessionEvent[] = [];
  private statsValue: SessionStats | null = null;
  /** Отображаемое имя модели из `get_state` (нет в `get_session_stats`). */
  private modelValue: string | null = null;
  private lastUsageTotal: number | null = null;
  /** Wall-clock старт сессии: первое ассистентское message_start/usage. */
  private sessionStartMs: number | null = null;
  /** Последняя подтверждённая выборка output для мгновенной скорости. */
  private speedSample: { output: number; tsMs: number } | null = null;
  /** Сглаженная мгновенная скорость; null — выборок ещё не было. */
  private smoothedTps: number | null = null;

  constructor(handler: RpcParseHandlers = {}) {
    this.handler = handler;
  }

  /** Проза сессии: авторитетные `text_end.content`, а не сырые дельты. */
  stdout(): string {
    return this.textOrder
      .map((index) => this.textByIndex.get(index) ?? '')
      .join('');
  }

  events(): SessionEvent[] {
    return this.collected;
  }

  /**
   * Фиксирует ответ пользователя на вопрос (`extension_ui_request` →
   * `extension_ui_response`): тем же путём, что и событие `question`, —
   * уходит живым подписчикам (`onEvent`) и попадает в `collected` →
   * персистится в step_outputs.events.
   */
  recordQuestionAnswered(questionId: string, answer: string): void {
    this.push({ type: 'question_answered', questionId, answer });
  }

  /** Последняя разобранная статистика сессии (`get_session_stats`) или null. */
  stats(): SessionStats | null {
    return this.statsValue;
  }

  /** Разбор одного уже распарсенного JSONL-события. */
  handle(event: RpcEvent): void {
    // Интерактивный запрос расширения (`ctx.ui.*`) — ждёт `extension_ui_response`.
    // Невалидные (без строковых id/method) игнорируются.
    if (
      event.type === 'extension_ui_request' &&
      typeof event.id === 'string' &&
      typeof event.method === 'string' &&
      DIALOG_METHODS.has(event.method as SessionQuestion['method'])
    ) {
      this.push({
        type: 'question',
        id: event.id,
        method: event.method as SessionQuestion['method'],
        title: typeof event.title === 'string' ? event.title : '',
        ...(typeof event.message === 'string' ? { message: event.message } : {}),
        ...(Array.isArray(event.options)
          ? {
              options: event.options.filter(
                (option): option is string => typeof option === 'string',
              ),
            }
          : {}),
        ...(typeof event.placeholder === 'string'
          ? { placeholder: event.placeholder }
          : {}),
        ...(typeof event.prefill === 'string' ? { prefill: event.prefill } : {}),
      });
      return;
    }

    // Fire-and-forget методы `ctx.ui.*`: pi ответа не ждёт, это не вопрос.
    // Диалоговые методы перехвачены выше и сюда не доходят.
    if (event.type === 'extension_ui_request' && typeof event.method === 'string') {
      if (event.method === 'notify') {
        this.push({
          type: 'notice',
          level:
            event.notifyType === 'warning' || event.notifyType === 'error'
              ? event.notifyType
              : 'info',
          message: typeof event.message === 'string' ? event.message : '',
        });
        return;
      }
      if (event.method === 'setStatus') {
        this.push({
          type: 'status',
          key: typeof event.statusKey === 'string' ? event.statusKey : '',
          text: stringOrNull(event.statusText),
        });
        return;
      }
      if (event.method === 'setWidget') {
        const lines = event.widgetLines;
        this.push({
          type: 'widget',
          key: typeof event.widgetKey === 'string' ? event.widgetKey : '',
          lines:
            Array.isArray(lines) && lines.every((line) => typeof line === 'string')
              ? (lines as string[])
              : null,
          placement:
            event.widgetPlacement === 'belowEditor'
              ? 'belowEditor'
              : 'aboveEditor',
        });
        return;
      }
      if (event.method === 'setTitle') {
        this.push({
          type: 'title',
          title: typeof event.title === 'string' ? event.title : '',
        });
        return;
      }
      if (event.method === 'set_editor_text') {
        this.push({
          type: 'editor_text',
          text: typeof event.text === 'string' ? event.text : '',
        });
        return;
      }
    }

    if (event.command !== undefined) {
      if (event.command === 'get_state') {
        this.captureModel(event.data);
        return;
      }
      if (event.command === 'get_session_stats') {
        const stats = parseSessionStats(event.data, this.modelValue);
        if (stats) {
          // Живой футер: каждое обновление статистики уходит событием в SSE
          // (`message_update.usage` у части провайдеров нулевое до конца стрима).
          // push до onStats: финальный ответ может сразу финализировать прогон.
          const withSpeed = this.withStatsSpeed(stats, Date.now());
          this.statsValue = withSpeed;
          this.push({ type: 'stats', stats: withSpeed });
          this.handler.onStats?.(withSpeed);
        }
      }
      return;
    }

    // Новое сообщение: `contentIndex` снова начинается с 0, поэтому пер-блочные
    // аккумуляторы надо очистить. Иначе thinking/text 2..N-го сообщения коллизят
    // с index 0 первого и `emitThinking`/`emitText` молчат (`emitted*` уже занят).
    if (event.type === 'message_start') {
      const role = asRecord(event.message)?.role;
      // Не-ассистентское сообщение (user) блоками ассистента не является — пропуск.
      if (typeof role === 'string' && role !== 'assistant') return;
      this.markSessionStart();
      this.flush();
      this.textByIndex.clear();
      this.textOrder.length = 0;
      this.emittedText.clear();
      this.thinkingByIndex.clear();
      this.thinkingOrder.length = 0;
      this.emittedThinking.clear();
      return;
    }

    if (event.type === 'message_update') {
      this.handleUsage(event.usage);
      this.handleAssistantMessage(event.assistantMessageEvent);
      return;
    }

    if (event.type === 'tool_execution_start') {
      this.push({
        type: 'tool_use',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        args: event.args ?? null,
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      this.push({
        type: 'tool_result',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        isError: event.isError === true,
        durationMs:
          typeof event.durationMs === 'number' ? event.durationMs : null,
        resultText: toolResultText(event.result),
      });
      return;
    }

    // Частичный результат инструмента во время исполнения.
    if (event.type === 'tool_execution_update') {
      this.push({
        type: 'tool_update',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        partialText: toolResultText(event.partialResult),
      });
      return;
    }

    if (event.type === 'compaction_start') {
      this.push({
        type: 'compaction_start',
        reason: compactionReason(event.reason),
      });
      return;
    }

    if (event.type === 'compaction_end') {
      const result = asRecord(event.result);
      this.push({
        type: 'compaction_end',
        reason: compactionReason(event.reason),
        summary: stringOrNull(result?.summary),
        aborted: event.aborted === true,
        willRetry: event.willRetry === true,
        errorMessage: stringOrNull(event.errorMessage),
        tokensBefore: numberOrNull(result?.tokensBefore),
        estimatedTokensAfter: numberOrNull(result?.estimatedTokensAfter),
      });
      return;
    }

    if (event.type === 'auto_retry_start') {
      this.push({
        type: 'retry_start',
        kind: 'auto',
        attempt: numberOrNull(event.attempt),
        maxAttempts: numberOrNull(event.maxAttempts),
        delayMs: numberOrNull(event.delayMs),
        errorMessage: stringOrNull(event.errorMessage),
        source: null,
        reason: null,
      });
      return;
    }

    if (event.type === 'auto_retry_end') {
      this.push({
        type: 'retry_end',
        kind: 'auto',
        success: typeof event.success === 'boolean' ? event.success : null,
        attempt: numberOrNull(event.attempt),
        finalError: stringOrNull(event.finalError),
      });
      return;
    }

    if (event.type === 'summarization_retry_scheduled') {
      this.push({
        type: 'retry_start',
        kind: 'summarization',
        attempt: numberOrNull(event.attempt),
        maxAttempts: numberOrNull(event.maxAttempts),
        delayMs: numberOrNull(event.delayMs),
        errorMessage: stringOrNull(event.errorMessage),
        source: null,
        reason: null,
      });
      return;
    }

    if (event.type === 'summarization_retry_finished') {
      this.push({
        type: 'retry_end',
        kind: 'summarization',
        success: null,
        attempt: null,
        finalError: null,
      });
      return;
    }
    // summarization_retry_attempt_start намеренно игнорируется.

    if (event.type === 'queue_update') {
      this.push({
        type: 'queue',
        steering: stringArray(event.steering),
        followUp: stringArray(event.followUp),
      });
      return;
    }

    if (event.type === 'thinking_level_changed') {
      this.push({
        type: 'thinking_level',
        level: typeof event.level === 'string' ? event.level : '',
      });
      return;
    }

    if (event.type === 'session_info_changed') {
      this.push({
        type: 'session_info',
        name: stringOrNull(event.name),
      });
      return;
    }

    if (event.type === 'extension_error') {
      this.push({ type: 'extension_error', message: String(event.error) });
      return;
    }

    // Provider/tool failures arrive as their own event type; without this they
    // only surface as silence, which reads as a stall instead of a cause.
    if (event.type === 'error') {
      this.push({
        type: 'notice',
        level: 'error',
        message: errorEventMessage(event),
      });
      return;
    }

    if (event.type === 'bash_execution_update') {
      this.push({
        type: 'bash',
        delta: typeof event.delta === 'string' ? event.delta : '',
      });
    }
  }

  /**
   * Достаёт имя модели из ответа `get_state` (`data.model`): непустой `name`,
   * иначе непустой `id`. Модель могла быть выбрана/переключена — берём последнее.
   */
  private captureModel(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const model = (data as Record<string, unknown>).model;
    if (!model || typeof model !== 'object' || Array.isArray(model)) return;
    const obj = model as Record<string, unknown>;
    let label: string | null = null;
    if (typeof obj.name === 'string' && obj.name.trim().length > 0) {
      label = obj.name;
    } else if (typeof obj.id === 'string' && obj.id.trim().length > 0) {
      label = obj.id;
    }
    if (label !== null) this.modelValue = label;
  }

  /**
   * Финализация: если `text_end`/`thinking_end` не пришёл (abort/обрыв),
   * накопленный текст/размышление всё равно отдаётся событиями `text` /
   * `thinking` и не теряется.
   */
  flush(): void {
    for (const index of this.textOrder) {
      if (!this.emittedText.has(index)) {
        this.emitText(index);
      }
    }
    for (const index of this.thinkingOrder) {
      if (!this.emittedThinking.has(index)) {
        this.emitThinking(index);
      }
    }
  }

  private handleAssistantMessage(message?: RpcAssistantMessageEvent): void {
    if (!message) return;

    if (message.type === 'text_delta') {
      if (typeof message.delta !== 'string' || message.delta.length === 0) {
        return;
      }
      const index = this.index(message);
      if (!this.textByIndex.has(index)) {
        this.textByIndex.set(index, '');
        this.textOrder.push(index);
      }
      this.textByIndex.set(
        index,
        `${this.textByIndex.get(index) ?? ''}${message.delta}`,
      );
      this.handler.onStdout?.(message.delta);
      return;
    }

    if (message.type === 'text_end') {
      const index = this.index(message);
      if (typeof message.content === 'string') {
        if (!this.textByIndex.has(index)) this.textOrder.push(index);
        this.textByIndex.set(index, message.content);
      }
      this.emitText(index);
      return;
    }

    if (message.type === 'thinking_delta') {
      if (typeof message.delta !== 'string' || message.delta.length === 0) {
        return;
      }
      const index = this.index(message);
      if (!this.thinkingByIndex.has(index)) {
        this.thinkingByIndex.set(index, '');
        this.thinkingOrder.push(index);
      }
      const partialText = `${this.thinkingByIndex.get(index) ?? ''}${message.delta}`;
      this.thinkingByIndex.set(index, partialText);
      // Живое обновление thinking уходит подписчикам (SSE) сразу, но НЕ
      // персистится в collected: финальный авторитетный {type:'thinking'}
      // эмитит thinking_end/flush, как text_end фиксирует {type:'text'}.
      this.handler.onEvent?.({
        type: 'thinking_update',
        contentIndex: index,
        partialText,
      });
      return;
    }

    if (message.type === 'thinking_end') {
      const index = this.index(message);
      const text = this.thinkingText(message.content);
      if (text !== null) {
        if (!this.thinkingByIndex.has(index)) this.thinkingOrder.push(index);
        this.thinkingByIndex.set(index, text);
      }
      this.emitThinking(index);
    }
    // text_start / toolcall_* намеренно игнорируются: JSON аргументов
    // инструментов не должен попадать в stdout (прозу).
  }

  /** Фиксирует старт сессии для wall-clock (первое ассистентское событие). */
  private markSessionStart(now: number = Date.now()): void {
    if (this.sessionStartMs === null) this.sessionStartMs = now;
  }

  /** Нормализует и эмитит `usage` из `message_update` с дедупом по total. */
  private handleUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    const usage = normalizeUsage(obj);
    // Первое usage-событие могло прийти без message_start — засекаем старт.
    const now = Date.now();
    this.markSessionStart(now);
    // Кумулятивное usage почти не меняется между дельтами — не дублируем,
    // пока total не вырос (в т.ч. первый нулевой снапшот пропускаем один раз).
    if (this.lastUsageTotal === usage.total) return;
    this.lastUsageTotal = usage.total;
    const speed = this.computeSpeed(usage, now);
    this.push({
      type: 'usage',
      usage,
      cost: normalizeCost(obj.cost),
      ...(speed ? { speed } : {}),
    });
  }

  /**
   * Скорость генерации по текущему usage: мгновенная (Δ output / Δt, сглажена
   * экспоненциально) и средняя (output / wall-clock сессии). null, пока средняя
   * недостоверна (elapsed < 1s или output = 0) — тогда `speed` не прикладываем.
   */
  private computeSpeed(usage: SessionUsage, now: number): SessionSpeed | null {
    if (this.sessionStartMs === null) return null;

    // Якорь/пересчёт мгновенной: только на выросшем output и не чаще 250мс,
    // иначе держим прошлую оценку (без скачка к 0 на коротких ступеньках).
    const sample = this.speedSample;
    if (sample === null) {
      this.speedSample = { output: usage.output, tsMs: now };
    } else if (
      usage.output > sample.output &&
      now - sample.tsMs >= SPEED_MIN_INTERVAL_MS
    ) {
      const deltaSec = (now - sample.tsMs) / 1000;
      const tps = (usage.output - sample.output) / deltaSec;
      this.smoothedTps =
        this.smoothedTps === null
          ? tps
          : this.smoothedTps +
            SPEED_SMOOTHING_ALPHA * (tps - this.smoothedTps);
      this.speedSample = { output: usage.output, tsMs: now };
    }

    const elapsedMs = now - this.sessionStartMs;
    if (elapsedMs < SPEED_MIN_ELAPSED_MS || usage.output <= 0) return null;
    const avg = usage.output / (elapsedMs / 1000);
    return { tokensPerSecond: this.smoothedTps ?? avg, avgTokensPerSecond: avg };
  }

  /** Прикладывает среднюю скорость к stats, когда она достоверна. */
  private withStatsSpeed(stats: SessionStats, now: number): SessionStats {
    if (this.sessionStartMs === null) return stats;
    const elapsedMs = now - this.sessionStartMs;
    if (elapsedMs < SPEED_MIN_ELAPSED_MS || stats.tokens.output <= 0) {
      return stats;
    }
    return {
      ...stats,
      avgTokensPerSecond: stats.tokens.output / (elapsedMs / 1000),
    };
  }

  /** Авторитетный текст `thinking_end`: ThinkingContent {thinking} или строка. */
  private thinkingText(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      const thinking = (content as { thinking?: unknown }).thinking;
      if (typeof thinking === 'string') return thinking;
    }
    return null;
  }

  private emitThinking(index: number): void {
    if (this.emittedThinking.has(index)) return;
    this.emittedThinking.add(index);
    const thinking = this.thinkingByIndex.get(index) ?? '';
    if (thinking.length === 0) return;
    this.push({ type: 'thinking', thinking });
  }

  private index(message: RpcAssistantMessageEvent): number {
    return typeof message.contentIndex === 'number' ? message.contentIndex : 0;
  }

  private emitText(index: number): void {
    if (this.emittedText.has(index)) return;
    this.emittedText.add(index);
    const text = this.textByIndex.get(index) ?? '';
    if (text.length === 0) return;
    this.push({ type: 'text', text });
  }

  private push(event: SessionEvent): void {
    this.collected.push(event);
    this.handler.onEvent?.(event);
  }
}

const PROMPT_COMMAND_ID = 'step-1';

/** `1`/`true`/`yes` → on; anything else (incl. unset) → off. */
function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

/** Human-readable text of a pi `error` event, whatever shape it arrives in. */
function errorEventMessage(event: RpcEvent): string {
  const record = asRecord(event);
  const candidates = ['message', 'error', 'reason', 'detail'];
  for (const key of candidates) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (value instanceof Error) return value.message;
  }
  return 'pi reported an error';
}

/** Сколько ждать ответ `get_session_stats` после agent_settled, мс. */
const STATS_TIMEOUT_MS = 2000;

/** Период опроса `get_session_stats` во время живой сессии, мс. */
const STATS_POLL_MS = 3000;

/**
 * Steerable pi-раннер: одна `pi --mode rpc` сессия на шаг конвейера вместо
 * one-shot `pi --print`. Команды — JSONL в stdin, события — JSONL из stdout.
 *
 * Транспорт: `docker` (по умолчанию) запускает pi внутри контейнера задачи
 * через `docker exec -i`, `local` — процесс pi прямо на хосте (cwd задачи).
 *
 * Живая проза отдаётся в onStdout/onStderr (SSE), структурированные события
 * сессии (текст/thinking/tool_use/tool_result) — в onEvent; финальный результат
 * шага определяется событием `agent_settled`. После settle раннер запрашивает
 * `get_session_stats` и кладёт `SessionStats` в результат (или null по
 * таймауту). Разбор отчёта (`.issue-step-result.json`) остаётся за
 * контроллером.
 */
/**
 * Точка инъекции CLI pi: продакшен зовёт `pi` (или `PI_BIN`), тесты — shim.
 * Инъекция не меняет поведение по умолчанию (`piCommand` по умолчанию 'pi').
 */
const LAUNCHER_ENV_KEYS = [
  'PI_SESSION_FILE',
  'PI_SESSION_ID',
  'PI_SESSION_NAME',
  'PI_MODEL',
  'PI_PROVIDER',
  // The launcher's room is not the step's room: only `room` decides it.
  'PI_AGENT_ROOM',
] as const;

/**
 * Environment for an agent spawned locally (`transport: 'local'`).
 *
 * The backend is often started from a pi session (`bin/service.sh` from an
 * agent shell), so `process.env` carries THAT session's identity. An inherited
 * `PI_SESSION_FILE` makes the step agent resume a foreign session instead of
 * starting its own: the foreign history lands in the step log wholesale (a
 * report run produced 175 MB of events in `step_outputs`), and the launcher's
 * model overrides `--model`. Session identity and model are therefore not
 * inherited — only config (`PI_CODING_AGENT_DIR`) and the agent's own room.
 */
export function stepAgentEnv(
  base: NodeJS.ProcessEnv,
  room?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of LAUNCHER_ENV_KEYS) delete env[key];
  if (room) env.PI_AGENT_ROOM = room;
  // A step agent has nothing to fetch from pi.dev: the catalog refresh and the
  // version check are pure latency inside a container, and the run is pinned to
  // a model we passed explicitly.
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  return env;
}

export interface RpcPiRunnerConfig {
  /** Исполняемый файл pi; по умолчанию env `PI_BIN`, иначе 'pi'. */
  piCommand?: string;
  /** Доп. аргументы перед `--mode rpc` (напр. путь к node-shim в тестах). */
  piArgs?: string[];
}

export class RpcPiRunner implements PiRunner {
  private readonly piCommand: string;
  private readonly piArgs: string[];

  constructor(
    private readonly step: PipelineStep = 'resolve',
    private readonly transport: 'docker' | 'local' = 'docker',
    config: RpcPiRunnerConfig = {},
  ) {
    this.piCommand = config.piCommand ?? process.env.PI_BIN ?? 'pi';
    this.piArgs = config.piArgs ?? [];
  }

  run(
    containerName: string,
    prompt: string,
    options: PiRunOptions = {},
  ): Promise<StepExecutionResult> {
    const modelArgs = options.model ? ['--model', options.model] : [];
    const thinkingArgs = options.thinkingLevel
      ? ['--thinking', options.thinkingLevel]
      : [];
    const sessionId = options.sessionId ?? options.stepRunId;
    // Our address IS the id of the file Pi will write (see SessionAddress).
    // Fail here, not inside a log line from Pi, when the address is malformed.
    if (sessionId !== undefined && !isValidPiSessionId(sessionId)) {
      throw new Error(`invalid Pi session id: ${JSON.stringify(sessionId)}`);
    }
    const sessionArgs = sessionId ? ['--session-id', sessionId] : [];
    const sessionDirArgs = options.sessionDir
      ? ['--session-dir', options.sessionDir]
      : [];
    const sessionNameArgs = options.sessionName
      ? ['--name', options.sessionName]
      : [];
    const systemAppendArgs = options.systemAppend
      ? ['--append-system-prompt', options.systemAppend]
      : [];
    const verboseFlags = isTruthy(process.env.ISSUE_RESOLVER_AGENT_VERBOSE)
      ? ['--verbose']
      : [];
    const toolFlags = [
      ...(options.tools?.length ? ['--tools', options.tools.join(',')] : []),
      ...(options.excludeTools?.length
        ? ['--exclude-tools', options.excludeTools.join(',')]
        : []),
    ];
    const sessionFlags = [
      ...sessionArgs,
      ...sessionDirArgs,
      ...sessionNameArgs,
      ...systemAppendArgs,
      ...toolFlags,
      ...verboseFlags,
    ];
    // Комната агента per-task: `issue-<issueId>`; иначе штатный defaultRoom.
    const room = options.issueId ? `issue-${options.issueId}` : undefined;

    return new Promise<StepExecutionResult>((resolve, reject) => {
      // stdin-пайп держим открытым до финализации: закрытие stdin обрывает pi
      // до agent_settled.
      const child =
        this.transport === 'local'
          ? spawn(
              this.piCommand,
              [
                ...this.piArgs,
                '--mode',
                'rpc',
                ...sessionFlags,
                ...modelArgs,
                ...thinkingArgs,
              ],
              {
                cwd: options.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: stepAgentEnv(process.env, room),
              },
            )
          : spawn(
              'docker',
              [
                'exec',
                '-i',
                ...(options.cwd ? ['-w', options.cwd] : []),
                ...(room ? ['-e', `PI_AGENT_ROOM=${room}`] : []),
                containerName,
                this.piCommand,
                ...this.piArgs,
                '--mode',
                'rpc',
                ...sessionFlags,
                ...modelArgs,
                ...thinkingArgs,
              ],
              { stdio: ['pipe', 'pipe', 'pipe'] },
            );

      const { registry, stepRunId, iterationId } = options;
      let statsHandler: (() => void) | undefined;
      const parser = new RpcSessionParser({
        onStdout: options.onStdout,
        onEvent: (event) => {
          options.onEvent?.(event);
          // Телеметрия агента комнаты: usage/stats для `listAgents().stats`.
          if (registry && stepRunId) registry.recordEvent(stepRunId, event);
        },
        onStats: () => statsHandler?.(),
      });
      let stderr = '';
      let buffer = '';
      let settled = false;
      let committedAbort = false;
      let timer: NodeJS.Timeout | undefined;
      let statsTimer: NodeJS.Timeout | undefined;
      let statsPollTimer: NodeJS.Timeout | undefined;
      let pendingResult: StepExecutionResult | null = null;
      let statsRequested = false;
      // id-коррелированные команды: id → resolver, ждущий `{type:'response', id}`.
      const pending = new Map<
        string,
        { resolve: (result: ControlResult) => void; timer: NodeJS.Timeout }
      >();
      let requestSeq = 0;

      const cleanup = (status: RoomAgentStatus = 'finished') => {
        if (timer) clearTimeout(timer);
        if (statsTimer) clearTimeout(statsTimer);
        if (statsPollTimer) clearInterval(statsPollTimer);
        // Незавершённые команды не должны висеть: отдаём им закрытие сессии.
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.resolve({ ok: false, error: 'session closed' });
        }
        pending.clear();
        if (registry && stepRunId) registry.unregister(stepRunId, status);
      };

      /** Финализация: не более одного resolve; мягко гасим сессию. */
      const finish = (result: StepExecutionResult) => {
        if (settled) return;
        settled = true;
        parser.flush();
        const finalResult: StepExecutionResult = {
          ...result,
          stdout: parser.stdout(),
          events: parser.events(),
        };
        cleanup(agentStatusFor(result));
        try {
          if (child.stdin?.writable) {
            child.stdin.write(`${JSON.stringify({ type: 'exit' })}\n`);
          }
        } catch {
          // Сессия уже мертва — не мешаем финализации.
        }
        if (!child.killed) child.kill('SIGTERM');
        resolve(finalResult);
      };

      const writeCommand = (command: Record<string, unknown>): boolean => {
        if (!child.stdin?.writable) return false;
        try {
          child.stdin.write(`${JSON.stringify(command)}\n`);
          return true;
        } catch {
          return false;
        }
      };

      /**
       * Шлёт команду с уникальным `id` и ждёт ответ `{type:'response', id}`
       * (перехватывается в `handleLine` до парсера). Таймаут → `ok:false`.
       */
      const sendCommand = (
        command: Record<string, unknown>,
        timeoutMs = 10000,
      ): Promise<ControlResult> => {
        const id = `ctl-${++requestSeq}`;
        return new Promise<ControlResult>((resolveCommand) => {
          if (!child.stdin?.writable) {
            resolveCommand({ ok: false, error: 'session closed' });
            return;
          }
          const entryTimer = setTimeout(() => {
            pending.delete(id);
            resolveCommand({ ok: false, error: 'timeout' });
          }, timeoutMs);
          pending.set(id, { resolve: resolveCommand, timer: entryTimer });
          try {
            child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
          } catch {
            clearTimeout(entryTimer);
            pending.delete(id);
            resolveCommand({ ok: false, error: 'write failed' });
          }
        });
      };

      /** Финализация с уже полученной (или таймаутной) статистикой. */
      const finalizeWithStats = () => {
        if (settled || pendingResult === null) return;
        const result = pendingResult;
        pendingResult = null;
        if (statsTimer) {
          clearTimeout(statsTimer);
          statsTimer = undefined;
        }
        finish({ ...result, stats: parser.stats() ?? null });
      };

      /**
       * Не финализируем сразу: запрашиваем `get_session_stats` и ждём ответ
       * (`onStats`) либо таймаут — только потом отдаём результат со stats.
       */
      const requestStatsThenFinish = (result: StepExecutionResult) => {
        if (statsRequested || settled) return;
        statsRequested = true;
        pendingResult = result;
        statsHandler = finalizeWithStats;
        // Модель — только в `get_state`; запрашиваем перед stats, чтобы
        // финальный/персистентный `SessionStats` нёс её имя.
        writeCommand({ type: 'get_state' });
        if (!writeCommand({ type: 'get_session_stats' })) {
          finalizeWithStats();
          return;
        }
        statsTimer = setTimeout(finalizeWithStats, STATS_TIMEOUT_MS);
      };

      // Абонент управления: реестр адресует steer/abort в живую сессию.
      // iterationId опционален: issue-уровневые прогоны (отчёт) не привязаны
      // к итерации — реестр группирует их под их же stepRunId, и control-роут
      // `/iterations/:id/...` находит сессию по этому адресу.
      if (registry && stepRunId) {
        registry.register(stepRunId, iterationId ?? stepRunId, {
          steer: (text) => writeCommand({ type: 'steer', message: text }),
          abort: () => {
            committedAbort = true;
            writeCommand({ type: 'abort' });
            // pi может быть заблокирован на интерактивном диалоге (ctx.ui.*)
            // и проигнорировать RPC abort. Форс-килл гарантирует, что процесс
            // завершится (close → committedAbort → aborted-результат), иначе
            // pi.run() зависнет навсегда.
            child.kill('SIGKILL');
          },
          respond: (payload) => {
            parser.recordQuestionAnswered(
              payload.id,
              questionAnswerText(payload),
            );
            return writeCommand({ type: 'extension_ui_response', ...payload });
          },
          prompt: (message, mode) =>
            sendCommand({
              type: 'prompt',
              message,
              ...(mode ? { streamingBehavior: mode } : {}),
            }).then((result): PromptResult => {
              const disposition = asRecord(result.data)?.disposition;
              const normalized =
                disposition === 'started' ||
                disposition === 'queued' ||
                disposition === 'handled'
                  ? disposition
                  : 'started';
              return { ok: result.ok, disposition: normalized };
            }),
          send: (command) => sendCommand(command),
        }, options.agent);
      }

      // Пока сессия жива, периодически опрашиваем статистику: провайдер может
      // отдавать нулевое `message_update.usage` до самого конца стрима, а
      // `get_session_stats` даёт реальные токены/стоимость/контекст по ходу.
      statsPollTimer = setInterval(() => {
        if (settled) return;
        writeCommand({ type: 'get_session_stats' });
      }, STATS_POLL_MS);

      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup('failed');
          child.kill('SIGKILL');
          reject(
            new Error(
              `pi run timed out after ${options.timeoutMs}ms in ${containerName}`,
            ),
          );
        }, options.timeoutMs);
      }

      const handleLine = (raw: string) => {
        const line = raw.replace(/\r$/, '');
        if (line.trim().length === 0) return;

        let event: RpcEvent;
        try {
          event = JSON.parse(line) as RpcEvent;
        } catch {
          // Битые/неполные JSON-строки протокола пропускаем.
          return;
        }

        if (event.type === 'agent_settled') {
          requestStatsThenFinish(this.resultFor(event.aborted === true, stderr));
          return;
        }

        // `handled`: an extension command or input handler consumed the prompt,
        // so no run starts and `agent_settled` never arrives. Waiting for it
        // would hang the step until its timeout.
        if (
          event.type === 'response' &&
          event.command === 'prompt' &&
          asRecord(event.data)?.disposition === 'handled'
        ) {
          requestStatsThenFinish(this.resultFor(false, stderr));
          return;
        }

        // Ответ на нашу id-коррелированную команду: резолвим pending и не
        // отдаём парсеру. Запросы без id (get_state/get_session_stats) идут
        // дальше как есть.
        if (event.type === 'response' && typeof event.id === 'string') {
          const pendingEntry = pending.get(event.id);
          if (pendingEntry) {
            pending.delete(event.id);
            clearTimeout(pendingEntry.timer);
            const { data } = event;
            pendingEntry.resolve(
              event.success === false
                ? {
                    ok: false,
                    error:
                      typeof event.error === 'string'
                        ? event.error
                        : 'command failed',
                    ...(data !== undefined ? { data } : {}),
                  }
                : { ok: true, ...(data !== undefined ? { data } : {}) },
            );
            return;
          }
        }

        parser.handle(event);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        options.onStderr?.(text);
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup('failed');
        reject(error);
      });

      child.on('close', (code) => {
        // Процесс закрылся без agent_settled: отдаём как есть.
        // Если пользователь успел запросить abort — это явный провал.
        if (settled) return;
        if (committedAbort) {
          requestStatsThenFinish(this.resultFor(true, stderr));
          return;
        }
        requestStatsThenFinish({
          step: this.step,
          exitCode: code ?? 1,
          report: null,
          stdout: '',
          stderr,
        });
      });

      // Заключительный перевод строки не приходит — обработаем остаток.
      child.on('end', () => {
        if (buffer.length > 0) {
          handleLine(buffer);
          buffer = '';
        }
      });

      writeCommand({
        id: PROMPT_COMMAND_ID,
        type: 'prompt',
        message: prompt,
      });
      // Имя модели доступно только через `get_state` — спрашиваем сразу после
      // промпта (до первого опроса stats), далее stats несёт его с собой.
      writeCommand({ type: 'get_state' });
    });
  }

  private resultFor(aborted: boolean, stderr: string): StepExecutionResult {
    const report: StepReport | null = aborted
      ? { status: 'fail', summary: 'aborted' }
      : null;
    return {
      step: this.step,
      exitCode: aborted ? 1 : 0,
      report,
      stdout: '',
      stderr,
      ...(aborted ? { aborted: true } : {}),
    };
  }
}