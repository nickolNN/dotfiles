import type { SessionEvent } from '@issue-resolver/shared';

export type { SessionEvent };

export function sessionEventsOf(run: {
  events?: SessionEvent[] | null;
}): SessionEvent[] {
  return Array.isArray(run.events) ? run.events : [];
}