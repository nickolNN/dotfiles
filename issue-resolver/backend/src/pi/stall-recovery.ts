import type { ControlResult, PromptResult } from '@issue-resolver/shared';

import type { SessionTarget, StepSessionRegistry } from './session-registry';

export interface StallRecovery {
  label: string;
  attempt: () => Promise<number> | number;
}

export const STALL_NUDGE_TEXT =
  'Status check: you have produced no output for a while. Reply with one line about what you are doing right now, then continue. If you are blocked, name the blocker.';

export interface StallRecoveryInput {
  control?: StepSessionRegistry;
  target?: SessionTarget;
  graceMs: number;
}

export function stallRecoveries(input: StallRecoveryInput): StallRecovery[] {
  const { control, target, graceMs } = input;
  if (!control || !target) return [];

  const nudge = (): Promise<PromptResult> | null =>
    control.prompt(target, STALL_NUDGE_TEXT, 'followUp');

  const compact = (): Promise<ControlResult> | null =>
    control.send(target, { type: 'compact' });

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
