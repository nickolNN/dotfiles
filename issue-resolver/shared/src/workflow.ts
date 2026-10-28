import type { PipelineStep } from './types';

export type StepTransition =
  | { kind: 'advance'; nextStep: PipelineStep | null; iterationCompleted: boolean }
  | { kind: 'retry_resolve'; attempt: number }
  | { kind: 'needs_input'; reason: 'max_attempts' }
  | { kind: 'iteration_failed'; failedStep: PipelineStep };

export interface StepTransitionInput {
  steps: PipelineStep[];
  currentStep: PipelineStep;
  result: 'success' | 'failed';
  attempt: number;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export const SELF_RETRY_STEPS: ReadonlySet<PipelineStep> = new Set([
  'refine',
  'resolve',
]);

export const MAX_SELF_RETRIES: Readonly<Record<string, number>> = {
  refine: 3,
  resolve: 3,
};

const TERMINAL_FAILURE_STEPS: readonly PipelineStep[] = ['refine', 'resolve', 'pr'];

export function nextStepDecision(input: StepTransitionInput): StepTransition {
  const { steps, currentStep, result, attempt } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (result === 'success') {
    const index = steps.indexOf(currentStep);
    const nextStep = index >= 0 ? steps[index + 1] ?? null : null;
    return { kind: 'advance', nextStep, iterationCompleted: nextStep === null };
  }

  if (TERMINAL_FAILURE_STEPS.includes(currentStep)) {
    return { kind: 'iteration_failed', failedStep: currentStep };
  }

  if (!steps.includes('resolve')) {
    return { kind: 'iteration_failed', failedStep: currentStep };
  }

  const nextAttempt = attempt + 1;
  if (nextAttempt > maxAttempts) {
    return { kind: 'needs_input', reason: 'max_attempts' };
  }
  return { kind: 'retry_resolve', attempt: nextAttempt };
}