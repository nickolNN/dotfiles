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

/**
 * One live agent session: what every caller of `pi.run` would otherwise have to
 * re-implement — SSE publication, activity counting, stdout/stderr and event
 * accumulation, question persistence, and the heartbeat that keeps a row from
 * looking alive after its process died.
 *
 * The interface is deliberately small: build the callbacks, spread them into
 * `PiRunOptions`, read the snapshot at the end, `stop()` the heartbeat. Outcome
 * policy (artifact gates, pass/fail rules, warnings) stays with the caller —
 * that is what actually differs between a step and the report.
 */
export interface AgentSessionDeps {
  sse: Pick<SseHub, 'publish'>;
  /** Live registry for steer/abort/respond; passed through to `PiRunOptions`. */
  control?: StepSessionRegistry;
  /** Persistence of the run's own row, when the session has one. */
  store?: {
    appendStepRunEvent(stepRunId: string, event: SessionEvent): Promise<void>;
    updateStepRun(
      stepRunId: string,
      patch: { status?: StepRunStatus; feedback?: string | null },
    ): Promise<unknown>;
  };
  /** Task status while an agent waits for a UI answer (`question`/`running`). */
  onQuestionStatus?: (status: 'question' | 'running') => void;
}

export interface AgentSessionInput {
  issueId: string;
  iterationId?: string;
  /** Address of the live session (SSE `stepRunId`, registry key). */
  sessionId: string;
  /**
   * `step_runs` row that receives questions and heartbeats. A report run has
   * one; a room worker does not (its coordinator's row does).
   */
  persistStepRunId?: string;
  /** Heartbeat period; omit to keep the row quiet (steps are driven by iteration). */
  heartbeatMs?: number;
  /** Tap into the event stream without owning the plumbing (e.g. anchoring). */
  onEvent?: (event: SessionEvent) => void;
}

export interface SessionSnapshot {
  stdout: string;
  stderr: string;
  events: SessionEvent[];
  stats: SessionStats | null;
}

export interface AgentSession {
  /** `PiRunOptions` fields this session owns; spread them into your options. */
  callbacks: {
    onStdout: (chunk: string, agent?: RoomAgentInfo) => void;
    onStderr: (chunk: string, agent?: RoomAgentInfo) => void;
    onEvent: (event: SessionEvent, agent?: RoomAgentInfo) => void;
  };
  /** Proof of life for stall guards: any chunk or event bumps it. */
  activity(): number;
  /** Everything the session saw, as of now. */
  snapshot(): SessionSnapshot;
  setStats(stats: SessionStats | null): void;
  /** Cancels the heartbeat. Idempotent; call it in `finally`. */
  stop(): void;
}

const nowIso = () => new Date().toISOString();

/** Live stdout/stderr chunk of a session (optionally of a room worker). */
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

/** One structured session event (`thinking`/`tool_use`/…) for SessionView. */
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
    // Fire-and-forget: `onEvent` is synchronous and its result is not awaited
    // by the runner, but a lost question must not take the whole run down.
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
        // A question must survive a page reload before the run has finished:
        // the answer arrives through `/control`, potentially minutes later.
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