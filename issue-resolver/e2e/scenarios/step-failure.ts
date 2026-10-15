import type { MockPiScenario } from './types';

/**
 * Первый шаг проходит, второй падает (`resolve` — терминальный: итерация и
 * задача переходят в `failed`, без retry).
 */
export const stepFailureScenario: MockPiScenario = {
  name: 'step-failure',
  bootstrap: 'success',
  steps: [
    { type: 'success', reportData: { summary: 'E2E: refine ok' } },
    {
      type: 'failure',
      reportData: { summary: 'E2E: resolve failed on purpose' },
    },
  ],
};