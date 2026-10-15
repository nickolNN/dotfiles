import { describe, expect, it } from 'vitest';
import type { SSEEvent, SessionEvent } from '@issue-resolver/shared';
import { parseAgentEventPayload, parseBootstrapLogPayload, parseIssueDeletedPayload, parseIssueDeletingPayload, parseStepEventPayload, parseWorkspaceProgressPayload } from './sse';

/** Оборачивает сессионное событие в конверт `step_event` как это делает бэкенд. */
function envelope(event: unknown): string {
  return JSON.stringify({ stepRunId: 'run-1', event });
}

describe('parseStepEventPayload — распознавание SessionEvent', () => {
  it.each<SessionEvent>([
    { type: 'thinking', thinking: 'размышляю' },
    { type: 'thinking_update', contentIndex: 0, partialText: 'частично' },
    {
      type: 'usage',
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: null,
    },
    {
      type: 'stats',
      stats: {
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        cost: null,
        contextUsage: null,
      },
    },
  ])('принимает live-событие $type', (event) => {
    const result = parseStepEventPayload(envelope(event));
    expect(result).not.toBeNull();
    expect(result?.stepRunId).toBe('run-1');
    expect(result?.event).toEqual(event);
  });

  it.each<SessionEvent>([
    { type: 'text', text: 'привет' },
    {
      type: 'question',
      id: 'q-1',
      method: 'select',
      title: 'Какой подход?',
      options: ['a', 'b'],
    },
    {
      type: 'tool_use',
      toolCallId: 't-1',
      toolName: 'bash',
      args: { command: 'ls' },
    },
    {
      type: 'tool_result',
      toolCallId: 't-1',
      toolName: 'bash',
      isError: false,
      durationMs: 5,
      resultText: 'ok',
    },
  ])('по-прежнему принимает $type', (event) => {
    expect(parseStepEventPayload(envelope(event))?.event).toEqual(event);
  });

  it('отбрасывает неизвестный тип события', () => {
    expect(
      parseStepEventPayload(JSON.stringify({ event: { type: 'nope' } })),
    ).toBeNull();
  });

  it('принимает плоский SessionEvent без конверта', () => {
    const result = parseStepEventPayload(
      JSON.stringify({ type: 'thinking', thinking: 'ok' }),
    );
    expect(result?.event).toEqual({ type: 'thinking', thinking: 'ok' });
  });

  it('вытаскивает agentId из конверта step_event', () => {
    const result = parseStepEventPayload(
      JSON.stringify({
        stepRunId: 'run-1',
        agentId: 'run-1/worker/0',
        event: { type: 'text', text: 'воркер' },
      }),
    );
    expect(result?.agentId).toBe('run-1/worker/0');
    expect(result?.event).toEqual({ type: 'text', text: 'воркер' });
  });

  it('больше не теряет служебные типы (question_answered/compaction/notice)', () => {
    expect(
      parseStepEventPayload(
        JSON.stringify({
          event: {
            type: 'question_answered',
            questionId: 'q-1',
            answer: 'вариант-a',
          },
        }),
      )?.event,
    ).toEqual({
      type: 'question_answered',
      questionId: 'q-1',
      answer: 'вариант-a',
    });
    expect(
      parseStepEventPayload(
        JSON.stringify({ event: { type: 'compaction_start', reason: 'manual' } }),
      )?.event,
    ).toEqual({ type: 'compaction_start', reason: 'manual' });
    expect(
      parseStepEventPayload(
        JSON.stringify({
          event: { type: 'notice', level: 'warning', message: 'ок' },
        }),
      )?.event,
    ).toEqual({ type: 'notice', level: 'warning', message: 'ок' });
  });
});

describe('parseWorkspaceProgressPayload — шаг подготовки рабочей папки', () => {
  it('разбирает step/status/opt-поля', () => {
    expect(
      parseWorkspaceProgressPayload(
        JSON.stringify({
          step: 'cloning',
          repo: 'owner/repo',
          status: 'running',
        }),
      ),
    ).toEqual({ step: 'cloning', repo: 'owner/repo', status: 'running' });
    expect(
      parseWorkspaceProgressPayload(
        JSON.stringify({ step: 'installing', status: 'error', message: 'boom' }),
      ),
    ).toEqual({ step: 'installing', status: 'error', message: 'boom' });
  });

  it('прокидывает devPort шага dev_server', () => {
    expect(
      parseWorkspaceProgressPayload(
        JSON.stringify({
          step: 'dev_server',
          repo: 'owner/repo',
          status: 'done',
          message: 'localhost:5173',
          devPort: 5173,
        }),
      ),
    ).toEqual({
      step: 'dev_server',
      repo: 'owner/repo',
      status: 'done',
      message: 'localhost:5173',
      devPort: 5173,
    });
    // Некорректный devPort отбрасывается.
    expect(
      parseWorkspaceProgressPayload(
        JSON.stringify({ step: 'dev_server', status: 'done', devPort: 'x' }),
      ),
    ).toEqual({ step: 'dev_server', status: 'done', devPort: undefined });
  });

  it('отбрасывает битый JSON и payload без step/status', () => {
    expect(parseWorkspaceProgressPayload('не json')).toBeNull();
    expect(parseWorkspaceProgressPayload(JSON.stringify({ status: 'done' }))).toBeNull();
    expect(parseWorkspaceProgressPayload(JSON.stringify({ step: 'ready' }))).toBeNull();
  });
});

describe('parseBootstrapLogPayload — живой лог бутстрапера', () => {
  it('разбирает repo/text/kind', () => {
    expect(
      parseBootstrapLogPayload(
        JSON.stringify({ repo: 'owner/repo', text: 'npm ci\n', kind: 'stdout' }),
      ),
    ).toEqual({ repo: 'owner/repo', text: 'npm ci\n', kind: 'stdout' });
    expect(
      parseBootstrapLogPayload(
        JSON.stringify({ repo: 'owner/repo', text: 'boom', kind: 'stderr' }),
      ),
    ).toEqual({ repo: 'owner/repo', text: 'boom', kind: 'stderr' });
  });

  it('неизвестный kind → stdout; битый JSON/без repo|text → null', () => {
    expect(
      parseBootstrapLogPayload(
        JSON.stringify({ repo: 'a/b', text: 'x', kind: 'weird' }),
      )?.kind,
    ).toBe('stdout');
    expect(parseBootstrapLogPayload('не json')).toBeNull();
    expect(parseBootstrapLogPayload(JSON.stringify({ repo: 'a/b' }))).toBeNull();
    expect(parseBootstrapLogPayload(JSON.stringify({ text: 'x' }))).toBeNull();
  });
});

describe('parseAgentEventPayload — per-agent поток', () => {
  it('раскрывает конверт step_event и достаёт agentId', () => {
    const result = parseAgentEventPayload(
      JSON.stringify({
        stepRunId: 'run-1/worker/1',
        agentId: 'run-1/worker/1',
        event: { type: 'text', text: 'привет' },
      }),
    );
    expect(result).toEqual({
      stepRunId: 'run-1/worker/1',
      agentId: 'run-1/worker/1',
      event: { type: 'text', text: 'привет' },
    });
  });

  it('не теряет служебные типы (compaction) в отличие от isSessionEvent', () => {
    const result = parseAgentEventPayload(
      JSON.stringify({
        agentId: 'run-1/worker/0',
        event: { type: 'compaction_start', reason: 'manual' },
      }),
    );
    expect(result?.event).toEqual({
      type: 'compaction_start',
      reason: 'manual',
    });
  });

  it('отбрасывает SSE-конверт step_status и мусор', () => {
    expect(
      parseAgentEventPayload(
        JSON.stringify({ type: 'step_status', data: 'running' }),
      ),
    ).toBeNull();
    expect(parseAgentEventPayload('не json')).toBeNull();
    expect(parseAgentEventPayload(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});

describe('parseIssueDeletingPayload / parseIssueDeletedPayload — фоновое удаление', () => {
  const envelope = (overrides: Partial<SSEEvent>): SSEEvent => ({
    type: 'issue_deleting',
    issueId: 'issue-1',
    data: JSON.stringify({ phase: 'stopping_processes' }),
    ts: '2026-10-13T00:00:00.000Z',
    ...overrides,
  });

  it('issue_deleting: issueId/ts из конверта, phase/message из data', () => {
    expect(parseIssueDeletingPayload(envelope({}))).toEqual({
      issueId: 'issue-1',
      phase: 'stopping_processes',
      ts: '2026-10-13T00:00:00.000Z',
    });
    expect(
      parseIssueDeletingPayload(
        envelope({
          data: JSON.stringify({ phase: 'error', message: 'boom' }),
        }),
      ),
    ).toEqual({
      issueId: 'issue-1',
      phase: 'error',
      message: 'boom',
      ts: '2026-10-13T00:00:00.000Z',
    });
  });

  it('issue_deleting: битый JSON или нет phase → null', () => {
    expect(parseIssueDeletingPayload(envelope({ data: 'не json' }))).toBeNull();
    expect(
      parseIssueDeletingPayload(envelope({ data: JSON.stringify({}) })),
    ).toBeNull();
  });

  it('issue_deleted: достаточно issueId из конверта', () => {
    expect(
      parseIssueDeletedPayload(
        envelope({
          type: 'issue_deleted',
          data: JSON.stringify({ issueId: 'issue-1' }),
        }),
      ),
    ).toEqual({ issueId: 'issue-1', ts: '2026-10-13T00:00:00.000Z' });
  });
});