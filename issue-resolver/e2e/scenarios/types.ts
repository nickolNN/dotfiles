/**
 * Мок-сценарии агента для e2e-прогонов без Docker/pi/сети.
 *
 * Сценарий — это заранее заданная последовательность ответов pi-раннера:
 * движок вызывает `pi.run()` по одному разу на шаг конвейера, раннер сдвигает
 * курсор и отдаёт следующий ответ. Пустая/короткая последовательность
 * деградирует до `success`.
 *
 * Типы намеренно не зависят от `@issue-resolver/shared` и `@playwright/test`,
 * чтобы один и тот же модуль импортировался и backend-сервером
 * (`backend/test/e2e-scenarios.ts`), и Playwright-спеками
 * (`frontend/e2e/scenarios/*`).
 */

/** Шаг конвейера — подмножество `PipelineStep` из shared. */
export type ScenarioPipelineStep =
  | 'refine'
  | 'resolve'
  | 'review'
  | 'test'
  | 'pr';

/** Тип ответа мок-агента на один шаг. */
export type MockPiStepType = 'success' | 'failure' | 'question' | 'timeout';

/** Интерактивный вопрос агента (для `type: 'question'`). */
export interface MockPiQuestion {
  /** Текст вопроса (заголовок/сообщение модалки). */
  question: string;
  /** Варианты ответа; пусто/отсутствует — свободный ввод. */
  options?: string[];
}

/** Ответ мок-агента на один шаг конвейера. */
export interface MockPiStep {
  type: MockPiStepType;
  /**
   * Явный шаг конвейера. Если не задан — выводится из промпта
   * (`Pipeline step: <step>.`), иначе `resolve`.
   */
  step?: ScenarioPipelineStep;
  /** Данные отчёта поверх дефолтных (`{ status, summary }`). */
  reportData?: Record<string, unknown>;
  /** Вопрос для `type: 'question'`. */
  questionEvent?: MockPiQuestion;
  /**
   * Задержка перед ответом/вопросом в мс (эмуляция «думанья» агента).
   * Для `question` задержка идёт ДО эмита вопроса — клиенту нужно успеть
   * открыть SSE-стрим.
   */
  delayMs?: number;
}

/** Поведение подготовки рабочей папки (bootstrap/install). */
export type ScenarioBootstrapMode = 'success' | 'failure';

/** Сценарий целиком: ответы шагов + режим подготовки. */
export interface MockPiScenario {
  /** Имя встроенного сценария (для логов/ассертов); у inline может отсутствовать. */
  name?: string;
  steps: MockPiStep[];
  /** `failure` → подготовка рабочей папки падает (задача → failed). */
  bootstrap?: ScenarioBootstrapMode;
  /**
   * Сколько ждать ответа на вопрос, прежде чем продолжить автоответом, мс.
   * По умолчанию 15 000.
   */
  questionTimeoutMs?: number;
}