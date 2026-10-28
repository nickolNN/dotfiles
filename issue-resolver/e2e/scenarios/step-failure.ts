import type { MockPiScenario } from './types';

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