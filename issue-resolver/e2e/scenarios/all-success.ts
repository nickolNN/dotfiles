import type { MockPiScenario } from './types';

export const allSuccessScenario: MockPiScenario = {
  name: 'all-success',
  bootstrap: 'success',
  steps: [
    { type: 'success', reportData: { summary: 'E2E: refine ok' } },
    { type: 'success', reportData: { summary: 'E2E: resolve ok' } },
    { type: 'success', reportData: { summary: 'E2E: review ok' } },
    { type: 'success', reportData: { summary: 'E2E: test ok' } },
    { type: 'success', reportData: { summary: 'E2E: pr ok' } },
  ],
};