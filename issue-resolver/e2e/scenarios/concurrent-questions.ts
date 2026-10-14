import type { MockPiScenario } from './types';

/**
 * Две задачи могут идти параллельно: у каждой итерации свой курсор, поэтому
 * обе одновременно задают вопрос на первом шаге. Курсор раннера ключуется
 * `iterationId`, так что шаги не «съедают» друг друга.
 */
export const concurrentQuestionsScenario: MockPiScenario = {
  name: 'concurrent-questions',
  bootstrap: 'success',
  questionTimeoutMs: 15_000,
  steps: [
    {
      type: 'question',
      delayMs: 500,
      questionEvent: {
        question: 'E2E: одновременный вопрос',
        options: ['да', 'нет'],
      },
      reportData: { summary: 'E2E: параллельный вопрос отвечен' },
    },
  ],
};