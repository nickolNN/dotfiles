import type { SSEEvent } from '@issue-resolver/shared';
import type { SessionEvent } from './session-events';

const API_BASE = '/issue-resolver/api/v1';

/** Полезная нагрузка `step_event`: сам сессионный эмит + id шага/агента. */
export type StepEventPayload = {
  stepRunId?: string;
  /** Адрес агента комнаты (RoomAgent.id), если эмит принадлежит ему. */
  agentId?: string;
  event: SessionEvent;
};

/**
 * Разбирает `data` события `step_event`. Бэкенд кладёт туда
 * `JSON.stringify({ stepRunId, event })`; на всякий случай принимаем и
 * «плоский» SessionEvent (если payload когда-нибудь положат напрямую).
 */
export function parseStepEventPayload(data: string): StepEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const stepRunId =
    typeof record.stepRunId === 'string' ? record.stepRunId : undefined;
  const agentId =
    typeof record.agentId === 'string' ? record.agentId : undefined;

  if (isSessionEvent(record.event)) {
    return { stepRunId, agentId, event: record.event };
  }

  if (isSessionEvent(record)) {
    return { stepRunId, agentId, event: record };
  }

  return null;
}

/** Все типы `SessionEvent` из shared-union (дискриминант `type`). */
const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'usage',
  'stats',
  'question',
  'question_answered',
  'tool_use',
  'tool_result',
  'tool_update',
  'compaction_start',
  'compaction_end',
  'retry_start',
  'retry_end',
  'queue',
  'thinking_level',
  'session_info',
  'notice',
  'status',
  'widget',
  'title',
  'extension_error',
  'bash',
  'editor_text',
]);

/**
 * Проверяет, что значение — валидный `SessionEvent` по дискриминанту.
 * Список типов должен покрывать ВСЮ union из shared: иначе живые события
 * (question_answered/compaction/retry/notice/…) молча теряются на SSE в
 * ожидании следующего GET /step-runs. Неизвестный тип по-прежнему отсекаем.
 */
function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && SESSION_EVENT_TYPES.has(type);
}

export type SseCallbacks = {
  onLog?(e: SSEEvent): void;
  onStepStatus?(e: SSEEvent): void;
  onIterationStatus?(e: SSEEvent): void;
  onStepEvent?(payload: StepEventPayload, raw: SSEEvent): void;
  onError?(err: unknown): void;
};

/** Полезная нагрузка per-agent эмита (`agents/stream?agentId=`). */
export type AgentEventPayload = {
  stepRunId?: string;
  agentId?: string;
  event: SessionEvent;
};

/** Типы SSE-конверта: их нельзя путать с SessionEvent при «плоском» разборе. */
const SSE_ENVELOPE_TYPES = new Set([
  'log',
  'step_status',
  'step_event',
  'iteration_status',
]);

/**
 * Широкий тест SessionEvent: любой объект со строковым `type`, кроме типов
 * SSE-конверта. В отличие от `isSessionEvent` не теряет служебные события
 * (compaction/retry/notice/tool_update/bash/…), которые тоже принадлежат
 * живой сессии агента. Неизвестные типы SessionView игнорирует.
 */
function isLooseSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && !SSE_ENVELOPE_TYPES.has(type);
}

/**
 * Разбирает эмит per-agent потока: конверт `step_event` (`{stepRunId,
 * agentId, event}`) либо «плоский» SessionEvent. Возвращает null, если
 * распарсить нечего.
 */
export function parseAgentEventPayload(
  data: string,
): AgentEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const agentId =
    typeof record.agentId === 'string' ? record.agentId : undefined;
  const stepRunId =
    typeof record.stepRunId === 'string' ? record.stepRunId : undefined;

  if (isLooseSessionEvent(record.event)) {
    return { stepRunId, agentId, event: record.event };
  }
  if (isLooseSessionEvent(record)) {
    return { stepRunId, agentId, event: record };
  }
  return null;
}

export type AgentSseCallbacks = {
  onEvent?(payload: AgentEventPayload, raw?: SSEEvent): void;
  onStepStatus?(e: SSEEvent): void;
  onError?(err: unknown): void;
};

/**
 * Подписка на поток событий задачи (SSE).
 *
 * Возвращает функцию отписки, которая закрывает соединение. Если
 * `EventSource` недоступен (например, SSR/старый браузер) — возвращается
 * no-op, чтобы вызывающий код не падал.
 */
export function subscribeToIssueEvents(
  issueId: string,
  cb: SseCallbacks,
): () => void {
  const EventSourceCtor = globalThis.EventSource;
  if (!EventSourceCtor) {
    return () => {};
  }

  const source = new EventSourceCtor(
    `${API_BASE}/issues/${issueId}/stream`,
  );

  source.onmessage = (event: MessageEvent) => {
    let parsed: SSEEvent;
    try {
      parsed = JSON.parse(event.data) as SSEEvent;
    } catch (error) {
      cb.onError?.(error);
      return;
    }

    switch (parsed.type) {
      case 'log':
        cb.onLog?.(parsed);
        break;
      case 'step_status':
        cb.onStepStatus?.(parsed);
        break;
      case 'iteration_status':
        cb.onIterationStatus?.(parsed);
        break;
      case 'step_event': {
        const payload = parseStepEventPayload(parsed.data);
        if (payload) cb.onStepEvent?.(payload, parsed);
        break;
      }
      default:
        // Неизвестный тип события игнорируем: forward-compat с сервером.
        break;
    }
  };

  source.onerror = (error: Event) => {
    cb.onError?.(error);
  };

  return () => {
    source.close();
  };
}

/**
 * Подписка на поток событий КОНКРЕТНОГО агента комнаты
 * (`GET /iterations/:id/agents/stream?agentId=`). `agentId` воркера содержит
 * `/` (`<stepRunId>/worker/<i>`) — кодируем его через `encodeURIComponent`.
 *
 * Возвращает функцию отписки; без `EventSource` (SSR) — no-op.
 */
export function subscribeToAgentEvents(
  iterationId: string,
  agentId: string,
  cb: AgentSseCallbacks,
): () => void {
  const EventSourceCtor = globalThis.EventSource;
  if (!EventSourceCtor) {
    return () => {};
  }

  const source = new EventSourceCtor(
    `${API_BASE}/iterations/${encodeURIComponent(
      iterationId,
    )}/agents/stream?agentId=${encodeURIComponent(agentId)}`,
  );

  source.onmessage = (event: MessageEvent) => {
    let raw: SSEEvent | undefined;
    try {
      const parsed = JSON.parse(event.data) as SSEEvent;
      if (parsed && typeof parsed === 'object') raw = parsed;
    } catch {
      raw = undefined;
    }

    if (raw?.type === 'step_status') {
      cb.onStepStatus?.(raw);
      return;
    }

    // Конверт step_event несёт сам эмит в `data`; плоский SessionEvent — в
    // `event.data` целиком.
    const body =
      raw?.type === 'step_event' && typeof raw.data === 'string'
        ? raw.data
        : event.data;
    const payload = parseAgentEventPayload(body);
    if (payload) {
      cb.onEvent?.(payload, raw);
      return;
    }
    cb.onError?.(new Error('не удалось разобрать событие агента'));
  };

  source.onerror = (error: Event) => cb.onError?.(error);

  return () => {
    source.close();
  };
}