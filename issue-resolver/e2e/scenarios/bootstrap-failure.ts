import type { MockPiScenario } from './types';

/**
 * Подготовка рабочей папки падает: анализатор не выдаёт инструкции, а
 * установка зависимостей бросает ошибку. Задача уходит из `preparing` в
 * терминальный `failed`, конвейер не запускается.
 */
export const bootstrapFailureScenario: MockPiScenario = {
  name: 'bootstrap-failure',
  bootstrap: 'failure',
  steps: [],
};