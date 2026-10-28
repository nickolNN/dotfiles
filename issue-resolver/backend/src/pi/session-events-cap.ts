import type { SessionEvent } from '@issue-resolver/shared';

export interface SessionEventsLimits {
  maxBytes: number;
  maxEventBytes: number;
}

export const DEFAULT_SESSION_EVENTS_LIMITS: SessionEventsLimits = {
  maxBytes: 2_000_000,
  maxEventBytes: 256_000,
};

const KEEP_STRING_CHARS = 1_000;

export const TRUNCATION_MARKER_PREFIX = '… session log truncated:';

export function isTruncationMarker(event: SessionEvent): boolean {
  return (
    event.type === 'text' &&
    typeof (event as { text?: unknown }).text === 'string' &&
    (event as { text: string }).text.startsWith(TRUNCATION_MARKER_PREFIX)
  );
}

function shrinkEvent(event: SessionEvent, maxEventBytes: number): SessionEvent {
  if (JSON.stringify(event).length <= maxEventBytes) return event;

  const copy: Record<string, unknown> = { ...event };
  const note = (dropped: number) =>
    `… [truncated ${dropped} chars: log capped at ${maxEventBytes} B per event]`;

  for (const [key, value] of Object.entries(copy)) {
    if (typeof value !== 'string' || value.length <= KEEP_STRING_CHARS) continue;
    copy[key] = `${value.slice(0, KEEP_STRING_CHARS)}\n${note(value.length - KEEP_STRING_CHARS)}`;
  }
  if (JSON.stringify(copy).length > maxEventBytes) {
    for (const [key, value] of Object.entries(copy)) {
      if (value === null || typeof value !== 'object') continue;
      copy[key] = `[truncated: ${JSON.stringify(value).length} chars]`;
    }
  }
  return copy as SessionEvent;
}

export function capSessionEvents(
  events: SessionEvent[],
  limits: SessionEventsLimits = DEFAULT_SESSION_EVENTS_LIMITS,
): SessionEvent[] {
  if (events.length === 0) return events;

  const source = isTruncationMarker(events[0] as SessionEvent)
    ? events.slice(1)
    : events;
  if (source.length === 0) return events;

  const shrunk = source.map((event) =>
    shrinkEvent(event, limits.maxEventBytes),
  );
  const sizes = shrunk.map((event) => JSON.stringify(event).length + 1);
  let start = shrunk.length;
  let bytes = 0;
  for (let index = shrunk.length - 1; index >= 0; index -= 1) {
    const size = sizes[index] ?? 0;
    if (bytes + size > limits.maxBytes && start < shrunk.length) break;
    bytes += size;
    start = index;
  }

  const kept = shrunk.slice(start);
  const dropped = start;
  if (dropped === 0) return kept;
  return [
    {
      type: 'text',
      text: `${TRUNCATION_MARKER_PREFIX} ${dropped} events dropped, last ${kept.length} shown (budget ${Math.round(limits.maxBytes / 1000)} KB)`,
    },
    ...kept,
  ];
}