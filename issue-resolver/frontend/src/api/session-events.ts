import type { SessionEvent, StepRunWithLog } from '@issue-resolver/shared';

export type { SessionEvent };

export type StepRunWithEvents = StepRunWithLog;

export function sessionEventsOf(run: {
  events?: SessionEvent[] | null;
}): SessionEvent[] {
  return Array.isArray(run.events) ? run.events : [];
}