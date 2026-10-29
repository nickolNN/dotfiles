import type {
  SSEEvent,
  SessionEvent,
  SessionStats,
  StepRunStatus,
} from '@issue-resolver/shared';
import { capSessionEvents } from './session-events-cap';
import type { SseHub } from '../sse/hub';
import type {
  RoomAgentInfo,
  StepSessionRegistry,
} from './session-registry';

export interface AgentSessionDeps {
  sse: Pick<SseHub, 'publish'>;
  control?: StepSessionRegistry;
  store?: {
    appendStepRunEvent(stepRunId: string, event: SessionEvent): Promise<void>;
    updateStepRun(
      stepRunId: string,
      patch: { status?: StepRunStatus; feedback?: string | null },
    ): Promise<unknown>;
  };
  onQuestionStatus?: (status: 'question' | 'running') => void;
}

export interface AgentSessionInput {
  issueId: string;
  iterationId?: string;
  sessionId: string;
  persistStepRunId?: string;
  heartbeatMs?: number;
  onEvent?: (event: SessionEvent) => void;
}

export interface SessionSnapshot {
  stdout: string;
  stderr: string;
  events: SessionEvent[];
  stats: SessionStats | null;
}

export interface AgentSession {
  callbacks: {
    onStdout: (chunk: string, agent?: RoomAgentInfo) => void;
    onStderr: (chunk: string, agent?: RoomAgentInfo) => void;
    onEvent: (event: SessionEvent, agent?: RoomAgentInfo) => void;
  };
  activity(): number;
  snapshot(): SessionSnapshot;
  setStats(stats: SessionStats | null): void;
  stop(): void;
}

const nowIso = () => new Date().toISOString();

const STREAM_TAIL_CHARS = 512_000;

const EVENT_BUDGET_BYTES = 4_000_000;
const EVENT_KEEP_BYTES = 2_000_000;
const EVENT_MAX_BYTES = 256_000;

function snapshotKey(event: SessionEvent, agentId?: string): string | null {
  const owner = agentId ?? '';
  if (event.type === 'text_update' || event.type === 'thinking_update') {
    return `${owner}|${event.type}:${event.contentIndex}`;
  }
  if (event.type === 'tool_update') {
    return `${owner}|tool_update:${event.toolCallId}`;
  }
  return null;
}

function appendTail(previous: string, chunk: string): string {
  if (previous.length + chunk.length <= STREAM_TAIL_CHARS) return previous + chunk;
  return (previous + chunk).slice(-STREAM_TAIL_CHARS);
}

export function streamEvent(
  issueId: string,
  iterationId: string | undefined,
  stepRunId: string,
  stream: NonNullable<SSEEvent['stream']>,
  data: string,
  agentId?: string,
): SSEEvent {
  return {
    type: 'log',
    issueId,
    ...(iterationId ? { iterationId } : {}),
    stepRunId,
    ...(agentId ? { agentId } : {}),
    stream,
    data,
    ts: nowIso(),
  };
}

export function stepEvent(
  issueId: string,
  iterationId: string | undefined,
  stepRunId: string,
  event: SessionEvent,
  agentId?: string,
): SSEEvent {
  return {
    type: 'step_event',
    issueId,
    ...(iterationId ? { iterationId } : {}),
    stepRunId,
    ...(agentId ? { agentId } : {}),
    stream: 'system',
    data: JSON.stringify(
      agentId ? { stepRunId, agentId, event } : { stepRunId, event },
    ),
    ts: nowIso(),
  };
}

export function startAgentSession(
  deps: AgentSessionDeps,
  input: AgentSessionInput,
): AgentSession {
  const { issueId, iterationId, sessionId } = input;
  let stdout = '';
  let stderr = '';
  const events: SessionEvent[] = [];
  const snapshots = new Map<string, number>();
  let eventBytes = 0;
  let stats: SessionStats | null = null;
  let activity = 0;

  const append = (event: SessionEvent) => {
    if (!input.persistStepRunId || !deps.store) return;
    void deps.store
      .appendStepRunEvent(input.persistStepRunId, event)
      .catch((error) =>
        console.error('agent session: failed to persist event', error),
      );
  };

  const heartbeat =
    input.persistStepRunId && deps.store && input.heartbeatMs
      ? setInterval(() => {
          void deps.store
            ?.updateStepRun(input.persistStepRunId as string, {
              status: 'running',
            })
            .catch(() => {});
        }, input.heartbeatMs)
      : null;
  heartbeat?.unref?.();

  return {
    callbacks: {
      onStdout(chunk, agent) {
        activity += 1;
        stdout = appendTail(stdout, chunk);
        deps.sse.publish(
          streamEvent(issueId, iterationId, sessionId, 'stdout', chunk, agent?.id),
        );
      },
      onStderr(chunk, agent) {
        activity += 1;
        stderr = appendTail(stderr, chunk);
        deps.sse.publish(
          streamEvent(issueId, iterationId, sessionId, 'stderr', chunk, agent?.id),
        );
      },
      onEvent(event, agent) {
        activity += 1;
        const key = snapshotKey(event, agent?.id);
        const slot = key === null ? undefined : snapshots.get(key);
        if (slot === undefined) {
          if (key !== null) snapshots.set(key, events.length);
          events.push(event);
          eventBytes += JSON.stringify(event).length;
        } else {
          eventBytes -= JSON.stringify(events[slot] as SessionEvent).length;
          events[slot] = event;
          eventBytes += JSON.stringify(event).length;
        }
        if (eventBytes > EVENT_BUDGET_BYTES) {
          const trimmed = capSessionEvents(events, {
            maxBytes: EVENT_KEEP_BYTES,
            maxEventBytes: EVENT_MAX_BYTES,
          });
          events.length = 0;
          events.push(...trimmed);
          snapshots.clear();
          eventBytes = trimmed.reduce(
            (total, item) => total + JSON.stringify(item).length,
            0,
          );
        }
        input.onEvent?.(event);
        deps.sse.publish(
          stepEvent(issueId, iterationId, sessionId, event, agent?.id),
        );
        if (event.type === 'question') {
          deps.onQuestionStatus?.('question');
          append(event);
        } else if (event.type === 'question_answered') {
          deps.onQuestionStatus?.('running');
          append(event);
        }
      },
    },
    activity: () => activity,
    snapshot: () => ({ stdout, stderr, events, stats }),
    setStats: (next) => {
      stats = next;
    },
    stop: () => {
      if (heartbeat) clearInterval(heartbeat);
    },
  };
}