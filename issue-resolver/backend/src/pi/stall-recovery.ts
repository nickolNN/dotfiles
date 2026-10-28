import type { ControlResult, PromptResult } from '@issue-resolver/shared';

import type { SessionTarget, StepSessionRegistry } from './session-registry';

/** One recovery attempt made before a stall guard gives up on a silent agent. */
export interface StallRecovery {
  /** Short name for the error message ("nudge", "compact"). */
  label: string;
  /** Runs the attempt; resolves to the grace window in ms, or 0 to give up. */
  attempt: () => Promise<number> | number;
}

/**
 * What we say to an agent that went quiet without dying.
 *
 * A silent agent is usually stuck in one long tool call or thinking, not gone;
 * asking for a one-line status costs a token and often unsticks it, while an
 * abort throws away everything it did.
 */
export const STALL_NUDGE_TEXT =
  'Status check: you have produced no output for a while. Reply with one line about what you are doing right now, then continue. If you are blocked, name the blocker.';

export interface StallRecoveryInput {
  control?: StepSessionRegistry;
  /** Session to wake up: the run's anchor, or one exact address. */
  target?: SessionTarget;
  /** How long the agent gets to react to each recovery, ms. */
  graceMs: number;
}

/**
 * Escalation ladder for a silent agent: a `follow_up` nudge first, a context
 * compaction second. Empty when there is no live session to talk to — the guard
 * then fails immediately, as it did before recoveries existed.
 */
export function stallRecoveries(input: StallRecoveryInput): StallRecovery[] {
  const { control, target, graceMs } = input;
  if (!control || !target) return [];

  const nudge = (): Promise<PromptResult> | null =>
    control.prompt(target, STALL_NUDGE_TEXT, 'followUp');

  const compact = (): Promise<ControlResult> | null =>
    control.send(target, { type: 'compact' });

  /**
   * A failed delivery (`ok: false`, e.g. the RPC timed out) earns no window: the
   * next rung is more useful than waiting on a message nobody received.
   */
  const graceFor = (
    result: Promise<PromptResult | ControlResult> | null,
  ): number | Promise<number> => {
    if (!result) return 0;
    return result
      .then((value) => (value?.ok === false ? 0 : graceMs))
      .catch(() => 0);
  };

  return [
    { label: 'nudge', attempt: () => graceFor(nudge()) },
    { label: 'compact', attempt: () => graceFor(compact()) },
  ];
}
