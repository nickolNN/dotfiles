import type { ModelDescriptor, ThinkingLevel } from '@issue-resolver/shared';

export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function thinkingLevelsFor(
  model: ModelDescriptor | undefined,
): readonly ThinkingLevel[] {
  const levels = model?.thinkingLevels;
  return levels && levels.length > 0 ? levels : ['off'];
}