import type { SessionEvent } from '@issue-resolver/shared';

/**
 * Budget for the session log that gets persisted.
 *
 * One live report run wrote 175 MB into `step_outputs.events`: the agent puts
 * screenshots and whole files into its session, and the log grew unbounded.
 * It is served as a single JSON response (`GET /issues/:id/report/run`), and
 * the browser dies on such a payload — that is exactly how "view the result"
 * froze the tab.
 *
 * The tail matters more than the head (the outcome is at the end), so the
 * head is what gets dropped.
 */
export interface SessionEventsLimits {
  /** Budget for the whole log, in JSON bytes. */
  maxBytes: number;
  /** Per-event ceiling: a single `tool_use` carrying a screenshot exceeds 1 MB. */
  maxEventBytes: number;
}

export const DEFAULT_SESSION_EVENTS_LIMITS: SessionEventsLimits = {
  maxBytes: 2_000_000,
  maxEventBytes: 256_000,
};

const KEEP_STRING_CHARS = 1_000;

/**
 * A single event above the ceiling: long strings are cut with an explicit
 * marker, nested objects (tool arguments) are replaced by their size. The
 * event type survives, so SessionView still renders a row instead of falling
 * into the unknown-type branch.
 */
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

/**
 * Keeps the tail of the log within budget. When anything is dropped, a marker
 * line goes first: a truncated log must never look complete.
 */
export function capSessionEvents(
  events: SessionEvent[],
  limits: SessionEventsLimits = DEFAULT_SESSION_EVENTS_LIMITS,
): SessionEvent[] {
  if (events.length === 0) return events;

  // Shrink once, then walk backwards accumulating sizes: no in-place mutation
  // of the caller's array and no post-hoc reversal.
  const shrunk = events.map((event) =>
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
      text: `… session log truncated: ${dropped} events dropped, last ${kept.length} shown (budget ${Math.round(limits.maxBytes / 1000)} KB)`,
    },
    ...kept,
  ];
}