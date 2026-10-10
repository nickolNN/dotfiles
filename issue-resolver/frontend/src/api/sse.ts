import type { SSEEvent } from '@issue-resolver/shared';
import type { SessionEvent } from './session-events';

const API_BASE = '/issue-resolver/api/v1';

/** Полезная нагрузка `step_event`: сам сессионный эмит + id шага. */
export type StepEventPayload = {
  stepRunId?: string;
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

  if (isSessionEvent(record.event)) {
    return { stepRunId, event: record.event };
  }

  if (isSessionEvent(record)) {
    return { stepRunId, event: record };
  }

  return null;
}

/** Проверяет, что значение — валидный `SessionEvent` по дискриминанту. */
function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'text' ||
    type === 'thinking' ||
    type === 'usage' ||
    type === 'stats' ||
    type === 'question' ||
    type === 'tool_use' ||
    type === 'tool_result'
  );
}

export type SseCallbacks = {
  onLog?(e: SSEEvent): void;
  onStepStatus?(e: SSEEvent): void;
  onIterationStatus?(e: SSEEvent): void;
  onStepEvent?(payload: StepEventPayload, raw: SSEEvent): void;
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