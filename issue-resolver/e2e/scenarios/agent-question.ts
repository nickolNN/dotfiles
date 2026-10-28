import type { MockPiScenario } from './types';

export const agentQuestionScenario: MockPiScenario = {
  name: 'agent-question',
  bootstrap: 'success',
  questionTimeoutMs: 15_000,
  steps: [
    {
      type: 'question',
      delayMs: 900,
      questionEvent: {
        question: 'E2E: уточните ожидаемое поведение',
        options: ['продолжить', 'остановиться'],
      },
      reportData: { summary: 'E2E: вопрос отвечен' },
    },
    { type: 'success', reportData: { summary: 'E2E: resolve after answer' } },
  ],
};