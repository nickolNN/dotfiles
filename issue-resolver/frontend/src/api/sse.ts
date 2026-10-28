import type { SSEEvent } from '@issue-resolver/shared';
import type { SessionEvent } from './session-events';

const API_BASE = '/issue-resolver/api/v1';

export const DELETE_TIMEOUT_MS = 15_000;

export type StepEventPayload = {
  stepRunId?: string;
  agentId?: string;
  event: SessionEvent;
};

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

export type WorkspaceProgressPayload = {
  step: string;
  repo?: string;
  status: string;
  message?: string;
  devPort?: number;
};

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

export type IssueDeletingPayload = {
  issueId: string;
  phase: string;
  message?: string;
  ts: string;
};

export type IssueDeletedPayload = {
  issueId: string;
  ts: string;
};

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

export function parseIssueDeletedPayload(
  raw: SSEEvent,
): IssueDeletedPayload | null {
  if (!raw.issueId) return null;
  return { issueId: raw.issueId, ts: raw.ts };
}

const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'text_update',
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

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && SESSION_EVENT_TYPES.has(type);
}

export type ContainerStatsPayload = {
  cpuPercent: number | null;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
};

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

export type AgentEventPayload = {
  stepRunId?: string;
  agentId?: string;
  event: SessionEvent;
};

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

function isLooseSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && !SSE_ENVELOPE_TYPES.has(type);
}

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
      break;
  }
}

export const SSE_RECONNECT_MS = 3_000;

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