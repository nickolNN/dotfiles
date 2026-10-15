/**
 * Замороженные примеры планов исполнения resolve — 4 топологии.
 *
 * Это документация-в-коде: refine возвращает `ExecutionPlan`, движок через
 * `planExecutionMode` решает топологию (single|room|stages), а `room.ts`
 * исполняет room/stages. `execution-topology-demo.test.ts` прогоняет эти
 * планы и печатает читаемый трейс порядка запуска агентов.
 *
 * Константы намеренно литеральны и стабильны — не «оптимизируй» их.
 */
import type { ExecutionPlan } from '@issue-resolver/shared';

/** 1. single — один агент, самая простая задача. */
export const SINGLE_PLAN: ExecutionPlan = {
  mode: 'single',
  rationale: 'простая задача — один агент',
};

/** 2. room — N воркеров параллельно + один координатор. */
export const ROOM_PLAN: ExecutionPlan = {
  mode: 'room',
  executors: 3,
  decomposition: ['собрать бэкенд', 'собрать фронтенд', 'написать тесты'],
  rationale: 'три независимые части — параллельно',
};

/** 3. stages — 3 последовательных этапа по одному исполнителю (3×1). */
export const SEQUENTIAL_STAGES_PLAN: ExecutionPlan = {
  mode: 'stages',
  stages: [
    { index: 1, name: 'Дизайн', task: 'спроектировать', executors: 1 },
    { index: 2, name: 'Реализация', task: 'написать код', executors: 1 },
    { index: 3, name: 'Проверка', task: 'проверить', executors: 1 },
  ],
  rationale: 'этапы зависят — последовательно',
};

/** 4. stages-сложный — параллель (2) → последовательность (1) → параллель (3). */
export const COMPLEX_STAGES_PLAN: ExecutionPlan = {
  mode: 'stages',
  stages: [
    {
      index: 1,
      name: 'Фундамент',
      executors: 2,
      decomposition: ['бэкенд', 'фронтенд'],
    },
    { index: 2, name: 'Интеграция', executors: 1, task: 'связать части' },
    {
      index: 3,
      name: 'Полировка',
      executors: 3,
      decomposition: ['тесты', 'документация', 'ревью'],
    },
  ],
  rationale: 'параллельные фазы чередуются с последовательными',
};