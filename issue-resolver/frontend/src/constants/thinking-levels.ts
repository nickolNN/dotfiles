import { ThinkingLevel } from '@issue-resolver/shared';
import type { ModelDescriptor } from '@issue-resolver/shared';

const THINKING_LEVELS = Object.values(ThinkingLevel);

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

export function thinkingLevelsFor(
  model: ModelDescriptor | undefined,
): readonly ThinkingLevel[] {
  const levels = model?.thinkingLevels;
  return levels && levels.length > 0 ? levels : ['off'];
}