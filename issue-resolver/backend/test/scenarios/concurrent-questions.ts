import type { MockPiScenario } from './types';

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