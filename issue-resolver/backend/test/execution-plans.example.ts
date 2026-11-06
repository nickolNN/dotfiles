import { ExecutionMode } from '@issue-resolver/shared';
import type { ExecutionPlan } from '@issue-resolver/shared';

export const SINGLE_PLAN: ExecutionPlan = {
  mode: ExecutionMode.single,
  rationale: 'простая задача — один агент',
};

export const WAVE_PLAN: ExecutionPlan = {
  mode: ExecutionMode.stages,
  stages: [
    {
      index: 1,
      name: 'Волна',
      task: 'собрать всё сразу',
      executors: 3,
      decomposition: ['собрать бэкенд', 'собрать фронтенд', 'написать тесты'],
    },
  ],
  rationale: 'три независимые части — одна параллельная волна',
};

export const SEQUENTIAL_STAGES_PLAN: ExecutionPlan = {
  mode: ExecutionMode.stages,
  stages: [
    { index: 1, name: 'Дизайн', task: 'спроектировать', executors: 1 },
    { index: 2, name: 'Реализация', task: 'написать код', executors: 1 },
    { index: 3, name: 'Проверка', task: 'проверить', executors: 1 },
  ],
  rationale: 'этапы зависят — последовательно',
};

export const COMPLEX_STAGES_PLAN: ExecutionPlan = {
  mode: ExecutionMode.stages,
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