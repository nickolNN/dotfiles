import type { MockPiScenario } from './types';

export const stepFailureScenario: MockPiScenario = {
  name: 'step-failure',
  bootstrap: 'success',
  steps: [
    { type: 'success', reportData: { summary: 'E2E: refine ok' } },
    ...Array.from({ length: 4 }, (_unused, index) => ({
      type: 'failure' as const,
      reportData: {
        summary: `E2E: resolve attempt ${index + 1} failed on purpose`,
      },
    })),
  ],
};