import { describe, expect, it } from 'vitest';
import { startAgentSession } from '../src/pi/agent-session';

const deps = { sse: { publish: () => {} } };

function session() {
  return startAgentSession(deps, { issueId: 'i', sessionId: 's' });
}

describe('agent-session — память длинного прогона', () => {
  it('кумулятивный text_update держит один слот, а не копию на каждый дельта-чанк', () => {
    const s = session();
    let text = '';
    for (let i = 0; i < 2000; i += 1) {
      text += 'слово ';
      s.callbacks.onEvent({ type: 'text_update', contentIndex: 0, partialText: text });
    }
    const events = s.snapshot().events;
    expect(events).toHaveLength(1);
    const only = events[0] as { type: string; partialText: string };
    expect(only.type).toBe('text_update');
    expect(only.partialText).toBe(text);
  });

  it('два потока с разными contentIndex не перетирают друг друга', () => {
    const s = session();
    s.callbacks.onEvent({ type: 'text_update', contentIndex: 0, partialText: 'A1' });
    s.callbacks.onEvent({ type: 'thinking_update', contentIndex: 0, partialText: 'T1' });
    s.callbacks.onEvent({ type: 'text_update', contentIndex: 0, partialText: 'A1A2' });
    s.callbacks.onEvent({ type: 'text_update', contentIndex: 1, partialText: 'B1' });
    expect(s.snapshot().events).toEqual([
      { type: 'text_update', contentIndex: 0, partialText: 'A1A2' },
      { type: 'thinking_update', contentIndex: 0, partialText: 'T1' },
      { type: 'text_update', contentIndex: 1, partialText: 'B1' },
    ]);
  });

  it('tool_update схлопывается по toolCallId', () => {
    const s = session();
    for (let i = 0; i < 100; i += 1) {
      s.callbacks.onEvent({
        type: 'tool_update',
        toolCallId: 'call-1',
        toolName: 'bash',
        partialText: 'x'.repeat(i * 10),
      });
    }
    const events = s.snapshot().events;
    expect(events).toHaveLength(1);
    expect((events[0] as { partialText: string }).partialText).toHaveLength(990);
  });

  it('некумулятивные события не теряются', () => {
    const s = session();
    s.callbacks.onEvent({ type: 'text', text: 'первый' });
    s.callbacks.onEvent({ type: 'text', text: 'второй' });
    s.callbacks.onEvent({ type: 'tool_use', toolCallId: 'c', toolName: 'bash', args: {} });
    expect(s.snapshot().events).toHaveLength(3);
  });

  it('stdout/stderr держат хвост, а не весь вывод прогона', () => {
    const s = session();
    const chunk = 'z'.repeat(64_000);
    for (let i = 0; i < 64; i += 1) s.callbacks.onStdout(chunk);
    for (let i = 0; i < 64; i += 1) s.callbacks.onStderr(chunk);
    const snap = s.snapshot();
    expect(snap.stdout.length).toBeLessThanOrEqual(512_000);
    expect(snap.stdout.endsWith('z')).toBe(true);
    expect(snap.stderr.length).toBeLessThanOrEqual(512_000);
  });
});

describe('agent-session — бюджет событий во время прогона', () => {
  it('крупные tool_result не копятся без предела: массив обрезается по ходу', () => {
    const s = session();
    const blob = 'y'.repeat(50_000);
    for (let i = 0; i < 200; i += 1) {
      s.callbacks.onEvent({
        type: 'tool_result',
        toolCallId: `c${i}`,
        toolName: 'read',
        isError: false,
        durationMs: 1,
        resultText: blob,
      });
    }
    const events = s.snapshot().events;
    const bytes = events.reduce((total, e) => total + JSON.stringify(e).length, 0);
    expect(bytes).toBeLessThan(4_100_000);
    expect(events.length).toBeGreaterThan(0);
    const first = events[0] as { type: string; text?: string };
    if (first.type === 'text' && typeof first.text === 'string') {
      expect(first.text).toContain('session log truncated');
    }
  });
});
