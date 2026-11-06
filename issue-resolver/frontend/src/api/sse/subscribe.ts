import { SSEEventType, SSEStream } from '@issue-resolver/shared';
import type { SSEEvent } from '@issue-resolver/shared';
import { API_BASE } from '../endpoints/http';
import { isOneOf, isOptionalOf, isRecord, isString } from '../guards';
import { SSE_RECONNECT_MS } from './constants';
import {
  parseAgentEventPayload,
  parseContainerStatsPayload,
  parseIssueDeletedPayload,
  parseIssueDeletingPayload,
  parseStepEventPayload,
  parseWorkspaceProgressPayload,
} from './parsers';
import type { AgentSseCallbacks, SseCallbacks } from './types';

const ENVELOPE_TYPES = Object.values(SSEEventType);
const ENVELOPE_STREAMS = Object.values(SSEStream);

function isSseEvent(value: unknown): value is SSEEvent {
  return (
    isRecord(value) &&
    isOneOf(ENVELOPE_TYPES, value.type) &&
    isString(value.issueId) &&
    isOptionalOf(value.iterationId, isString) &&
    isOptionalOf(value.stepRunId, isString) &&
    isOptionalOf(value.agentId, isString) &&
    isOptionalOf(value.stream, (item) => isOneOf(ENVELOPE_STREAMS, item)) &&
    isString(value.data) &&
    isString(value.ts)
  );
}

export function subscribeToIssueEvents(
  issueId: string,
  cb: SseCallbacks,
): () => void {
  const EventSourceCtor = globalThis.EventSource;
  if (!EventSourceCtor) {
    return () => {};
  }

  const source = new EventSourceCtor(`${API_BASE}/issues/${issueId}/stream`);

  source.onmessage = (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch (error) {
      cb.onError?.(error);
      return;
    }

    if (isSseEvent(parsed)) dispatchSseEvent(parsed, cb);
  };

  source.onerror = (error: Event) => {
    cb.onError?.(error);
  };

  return () => {
    source.close();
  };
}

function handleSseMessageData(data: string, cb: SseCallbacks): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    cb.onError?.(error);
    return;
  }
  if (isSseEvent(parsed)) dispatchSseEvent(parsed, cb);
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
      const parsed: unknown = JSON.parse(event.data);
      raw = isSseEvent(parsed) ? parsed : undefined;
    } catch {
      raw = undefined;
    }

    if (raw?.type === SSEEventType.step_status) {
      cb.onStepStatus?.(raw);
      return;
    }

    const body =
      raw?.type === SSEEventType.step_event && typeof raw.data === 'string'
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

export function openContainerStatsStream(): () => void {
  const EventSourceCtor = globalThis.EventSource;
  if (!EventSourceCtor) return () => {};
  const source = new EventSourceCtor(`${API_BASE}/container-stats-stream`);
  source.onerror = () => source.close();
  return () => source.close();
}
