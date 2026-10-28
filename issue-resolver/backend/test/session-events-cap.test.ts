import type { SessionEvent } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import {
  capSessionEvents,
  DEFAULT_SESSION_EVENTS_LIMITS,
  isTruncationMarker,
} from '../src/pi/session-events-cap';

const text = (value: string): SessionEvent => ({ type: 'text', text: value });

describe('capSessionEvents', () => {
  it('лог в пределах бюджета возвращается без пометки об обрезке', () => {
    const events = [text('a'), text('b')];

    expect(capSessionEvents(events)).toEqual(events);
  });

  it('сверх бюджета остаётся хвост, первым идёт маркер обрезки', () => {
    const events = Array.from({ length: 50 }, (_, index) =>
      text(`${index}:`.padEnd(100_000, 'x')),
    );

    const capped = capSessionEvents(events);

    expect(capped[0]).toMatchObject({ type: 'text' });
    expect((capped[0] as { text: string }).text).toContain('truncated');
    expect(capped.at(-1)).toEqual(events.at(-1));
    expect(capped).not.toContainEqual(events[0]);
    const bytes = capped.reduce(
      (sum, event) => sum + JSON.stringify(event).length + 1,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(
      DEFAULT_SESSION_EVENTS_LIMITS.maxBytes + 10_000,
    );
  });

  it('одно гигантское событие сжимается, а не выбрасывается', () => {
    const huge: SessionEvent = {
      type: 'tool_use',
      toolCallId: 'call-1',
      toolName: 'write',
      args: { content: 'A'.repeat(900_000) },
    };

    const capped = capSessionEvents([huge]);

    expect(capped).toHaveLength(1);
    const [event] = capped as [SessionEvent];
    expect(event.type).toBe('tool_use');
    expect(JSON.stringify(event).length).toBeLessThanOrEqual(
      DEFAULT_SESSION_EVENTS_LIMITS.maxEventBytes + 1_000,
    );
    expect(JSON.stringify(event)).toContain('truncated');
  });

  it('повторная обрезка не накапливает маркеры', () => {
    let log: SessionEvent[] = Array.from({ length: 40 }, (_, index) =>
      text(`${index}:`.padEnd(100_000, 'y')),
    );

    for (let round = 0; round < 5; round += 1) {
      log = capSessionEvents([...log, text(`${round}:tail`.padEnd(100_000, 'z'))]);
    }

    const markers = log.filter(isTruncationMarker);
    expect(markers).toHaveLength(1);
    expect(isTruncationMarker(log[0] as SessionEvent)).toBe(true);
  });
});
