import type { SSEEvent } from '@issue-resolver/shared';
import type { SessionEvent } from './session-events';

const API_BASE = '/issue-resolver/api/v1';

/**
 * Таймаут ожидания финала фонового удаления задачи (SSE `issue_deleted`
 * или `issue_deleting` с `phase: 'error'`). Если за это время финал не
 * пришёл — считаем удаление «зависшим»: показываем предупреждение и
 * возвращаем карточку в обычный вид.
 */
export const DELETE_TIMEOUT_MS = 15_000;

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

/** Полезная нагрузка `workspace_progress`: шаг разовой подготовки рабочей папки. */
export type WorkspaceProgressPayload = {
  /** `creating_dirs` | `cloning` | `checking_instructions` | `installing` | `dev_server` | `ready`. */
  step: string;
  /** Репозиторий шага `cloning` (`owner/repo`). */
  repo?: string;
  status: string;
  message?: string;
  /** Порт поднятого dev-сервера (шаг `dev_server`). */
  devPort?: number;
};

/**
 * Разбирает `data` события `workspace_progress`. Бэкенд кладёт туда
 * `JSON.stringify({ step, repo?, status, message? })`; битый JSON или
 * отсутствие `step`/`status` → null (событие игнорируем).
 */
export function parseWorkspaceProgressPayload(
  data: string,
): WorkspaceProgressPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.step !== 'string' || typeof record.status !== 'string') {
    return null;
  }
  return {
    step: record.step,
    status: record.status,
    repo: typeof record.repo === 'string' ? record.repo : undefined,
    message:
      typeof record.message === 'string' ? record.message : undefined,
    devPort:
      typeof record.devPort === 'number' && Number.isFinite(record.devPort)
        ? record.devPort
        : undefined,
  };
}

/**
 * Полезная нагрузка `issue_deleting`: очередная фаза фонового удаления
 * задачи. `issueId` + `ts` берём из конверта события, `phase`/`message` —
 * из `data` (как их кладёт бэкенд).
 */
export type IssueDeletingPayload = {
  issueId: string;
  /** `stopping_processes` | `removing_db_record` | `removing_container` | `removing_workspace` | `error`. */
  phase: string;
  /** Причина ошибки — только для `phase: 'error'`. */
  message?: string;
  ts: string;
};

/** Полезная нагрузка `issue_deleted`: задача стёрта из БД. */
export type IssueDeletedPayload = {
  issueId: string;
  ts: string;
};

/**
 * Разбирает `issue_deleting`. `data` — JSON `{ phase, message? }`; битый JSON
 * или отсутствие `phase`/`issueId` → null (событие игнорируем).
 */
export function parseIssueDeletingPayload(
  raw: SSEEvent,
): IssueDeletingPayload | null {
  if (!raw.issueId) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.phase !== 'string' || record.phase.length === 0) {
    return null;
  }
  return {
    issueId: raw.issueId,
    phase: record.phase,
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ts: raw.ts,
  };
}

/**
 * Разбирает `issue_deleted`: достаточно `issueId` из конверта (тело может
 * содержать его же, но не обязательно).
 */
export function parseIssueDeletedPayload(
  raw: SSEEvent,
): IssueDeletedPayload | null {
  if (!raw.issueId) return null;
  return { issueId: raw.issueId, ts: raw.ts };
}

/** Все типы `SessionEvent` из shared-union (дискриминант `type`). */
const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'thinking_update',
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

/**
 * Полезная нагрузка `container_stats`: живая стата контейнера задачи из
 * Docker stream (`cpuPercent` может быть null без данных).
 */
export type ContainerStatsPayload = {
  cpuPercent: number | null;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
};

/**
 * Разбирает `data` события `container_stats`. Битый JSON / не-объект → null
 * (событие игнорируем); отсутствующие поля деградируют в null/0.
 */
export function parseContainerStatsPayload(
  data: unknown,
): ContainerStatsPayload | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return {
      cpuPercent:
        typeof record.cpuPercent === 'number' ? record.cpuPercent : null,
      memoryUsageBytes:
        typeof record.memoryUsageBytes === 'number'
          ? record.memoryUsageBytes
          : 0,
      memoryLimitBytes:
        typeof record.memoryLimitBytes === 'number'
          ? record.memoryLimitBytes
          : 0,
      pids: typeof record.pids === 'number' ? record.pids : 0,
    };
  } catch {
    return null;
  }
}

export type SseCallbacks = {
  onLog?(e: SSEEvent): void;
  onStepStatus?(e: SSEEvent): void;
  onIterationStatus?(e: SSEEvent): void;
  onStepEvent?(payload: StepEventPayload, raw: SSEEvent): void;
  onWorkspaceProgress?(payload: WorkspaceProgressPayload, raw: SSEEvent): void;
  onIssueDeleting?(payload: IssueDeletingPayload, raw: SSEEvent): void;
  onIssueDeleted?(payload: IssueDeletedPayload, raw: SSEEvent): void;
  onContainerStats?(payload: ContainerStatsPayload, raw: SSEEvent): void;
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
  'workspace_progress',
  'issue_deleting',
  'issue_deleted',
  'container_stats',
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

    dispatchSseEvent(parsed, cb);
  };

  source.onerror = (error: Event) => {
    cb.onError?.(error);
  };

  return () => {
    source.close();
  };
}

/** Разбор `event.data` + маршрутизация по колбэкам; общая для обоих потоков. */
function handleSseMessageData(data: string, cb: SseCallbacks): void {
  let parsed: SSEEvent;
  try {
    parsed = JSON.parse(data) as SSEEvent;
  } catch (error) {
    cb.onError?.(error);
    return;
  }
  dispatchSseEvent(parsed, cb);
}

/** Раздаёт распарсенный `SSEEvent` по колбэкам `SseCallbacks`. */
function dispatchSseEvent(parsed: SSEEvent, cb: SseCallbacks): void {
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
    case 'workspace_progress': {
      const payload = parseWorkspaceProgressPayload(parsed.data);
      if (payload) cb.onWorkspaceProgress?.(payload, parsed);
      break;
    }
    case 'issue_deleting': {
      const payload = parseIssueDeletingPayload(parsed);
      if (payload) cb.onIssueDeleting?.(payload, parsed);
      break;
    }
    case 'issue_deleted': {
      const payload = parseIssueDeletedPayload(parsed);
      if (payload) cb.onIssueDeleted?.(payload, parsed);
      break;
    }
    case 'container_stats': {
      const payload = parseContainerStatsPayload(parsed.data);
      if (payload) cb.onContainerStats?.(payload, parsed);
      break;
    }
    default:
      // Неизвестный тип события игнорируем: forward-compat с сервером.
      break;
  }
}

/**
 * Задержка ручного переподключения глобального потока после ошибки. У
 * `EventSource` есть собственный авто-реконнект, но при жёстком обрыве
 * (сервер закрыл поток) его недостаточно — поднимаем соединение сами.
 */
export const SSE_RECONNECT_MS = 3_000;

/**
 * Подписка на ГЛОБАЛЬНЫЙ поток событий (`GET /stream`). В отличие от
 * `subscribeToIssueEvents` канал не фильтруется по `issueId` — приходят все
 * события, поэтому потребитель сам выбирает нужные (напр. живой статус задач
 * для списка).
 *
 * Возвращает функцию отписки; без `EventSource` (SSR) — no-op.
 */
export function subscribeToGlobalStream(cb: SseCallbacks): () => void {
  const EventSourceCtor = globalThis.EventSource;
  if (!EventSourceCtor) {
    return () => {};
  }

  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    const next = new EventSourceCtor(`${API_BASE}/stream`);
    source = next;
    next.onmessage = (event: MessageEvent) => {
      handleSseMessageData(event.data, cb);
    };
    next.onerror = (error: Event) => {
      cb.onError?.(error);
      // Закрываем сокет и переподключаемся сами с задержкой: иначе браузер
      // может держать мёртвое соединение и события перестанут приходить.
      next.close();
      if (disposed || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, SSE_RECONNECT_MS);
    };
  };

  open();

  return () => {
    disposed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    source?.close();
  };
}

/**
 * Stream of ONE room agent (`GET /iterations/:id/agents/stream?agentId=`).
 * Agent ids are session addresses, so they still go through
 * `encodeURIComponent` before hitting the query string.
 *
 * Returns an unsubscribe function; without `EventSource` (SSR) it is a no-op.
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