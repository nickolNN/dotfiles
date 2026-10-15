import type { MockPiScenario } from './types';

/**
 * Первый (resolve) шаг задаёт вопрос, ждёт ответ пользователя и продолжает
 * успехом. Задержка 900 мс перед вопросом даёт браузеру время открыть
 * SSE-стрим задачи (живой `question`-event не буферизуется).
 */
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