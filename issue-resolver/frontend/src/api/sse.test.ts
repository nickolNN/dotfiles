import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@issue-resolver/shared';
import { parseStepEventPayload } from './sse';

/** Оборачивает сессионное событие в конверт `step_event` как это делает бэкенд. */
function envelope(event: unknown): string {
  return JSON.stringify({ stepRunId: 'run-1', event });
}

describe('parseStepEventPayload — распознавание SessionEvent', () => {
  it.each<SessionEvent>([
    { type: 'thinking', thinking: 'размышляю' },
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
});