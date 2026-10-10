import type { SessionEvent, StepRunWithLog } from '@issue-resolver/shared';

/**
 * Ре-экспорт общего контракта: `SessionEvent` живёт в
 * `@issue-resolver/shared` (добавлен вместе с `StepRunWithLog.events`).
 */
export type { SessionEvent };

/** `StepRunWithLog` уже несёт `events: SessionEvent[]`; псевдоним для читаемости. */
export type StepRunWithEvents = StepRunWithLog;

/** Безопасно достаёт события шага: отсутствие поля и `null` → пустой массив. */
export function sessionEventsOf(run: {
  events?: SessionEvent[] | null;
}): SessionEvent[] {
  return Array.isArray(run.events) ? run.events : [];
}