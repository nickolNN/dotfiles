export const queryKeys = {
  issues: ['issues'],
  issue: (issueId: string | null | undefined) => ['issue', issueId],
  iterations: (issueId: string | null | undefined) => ['iterations', issueId],
  stepRuns: (iterationId: string | null | undefined) => [
    'step-runs',
    iterationId,
  ],
  iterationControl: (iterationId: string | null | undefined) => [
    'iteration-control',
    iterationId,
  ],
  models: ['models'],
  repositories: ['repositories'],
  tags: ['tags'],
} as const;