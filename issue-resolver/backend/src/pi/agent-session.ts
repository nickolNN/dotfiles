import type {
  SSEEvent,
  SessionEvent,
  SessionStats,
  StepRunStatus,
} from '@issue-resolver/shared';
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
        stdout += chunk;
        deps.sse.publish(
          streamEvent(issueId, iterationId, sessionId, 'stdout', chunk, agent?.id),
        );
      },
      onStderr(chunk, agent) {
        activity += 1;
        stderr += chunk;
        deps.sse.publish(
          streamEvent(issueId, iterationId, sessionId, 'stderr', chunk, agent?.id),
        );
      },
      onEvent(event, agent) {
        activity += 1;
        events.push(event);
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