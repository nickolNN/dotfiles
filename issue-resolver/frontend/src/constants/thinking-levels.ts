import type { ModelDescriptor, ThinkingLevel } from '@issue-resolver/shared';

/**
 * Полный справочный набор уровней размышления pi (reasoning effort).
 * В формах опции строятся из `ModelDescriptor.thinkingLevels` конкретной
 * выбранной модели; эта константа — фолбек/справочник.
 */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * Уровни, доступные для модели. Пустой/отсутствующий список трактуем как
 * `['off']` — backend почти всегда отдаёт минимум `['off']`.
 */
export function thinkingLevelsFor(
  model: ModelDescriptor | undefined,
): readonly ThinkingLevel[] {
  const levels = model?.thinkingLevels;
  return levels && levels.length > 0 ? levels : ['off'];
}