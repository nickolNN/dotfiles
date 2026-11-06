import { StepRunStatus } from './status';
import { blockingFindings } from './step-result';
import type { StepReport } from './types/step';
import { PipelineStep } from './types/pipeline';

export const StepTransitionKind = Object.freeze({
  advance: 'advance',
  retry_resolve: 'retry_resolve',
  needs_input: 'needs_input',
  iteration_failed: 'iteration_failed',
} as const);
export type StepTransitionKind =
  (typeof StepTransitionKind)[keyof typeof StepTransitionKind];

export type StepTransition =
  | {
      kind: typeof StepTransitionKind.advance;
      nextStep: PipelineStep | null;
      iterationCompleted: boolean;
    }
  | { kind: typeof StepTransitionKind.retry_resolve; attempt: number }
  | { kind: typeof StepTransitionKind.needs_input; reason: 'max_attempts' }
  | {
      kind: typeof StepTransitionKind.iteration_failed;
      failedStep: PipelineStep;
    };

export interface StepTransitionInput {
  steps: PipelineStep[];
  currentStep: PipelineStep;
  result: 'success' | 'failed';
  attempt: number;
  maxAttempts?: number;
  report?: StepReport | null;
}

export const MAX_PIPELINE_ATTEMPTS = 5;

export const REFINED_PLAN_CHAR_LIMIT = 12_000;

export const SELF_RETRY_STEPS: ReadonlySet<PipelineStep> = new Set([
  PipelineStep.refine,
  PipelineStep.resolve,
]);

export const MAX_SELF_RETRIES: Readonly<Partial<Record<PipelineStep, number>>> = {
  [PipelineStep.refine]: 3,
  [PipelineStep.resolve]: 3,
};

const TERMINAL_FAILURE_STEPS: readonly PipelineStep[] = [
  PipelineStep.refine,
  PipelineStep.resolve,
  PipelineStep.pr,
];

function advanceFrom(
  steps: PipelineStep[],
  currentStep: PipelineStep,
): StepTransition {
  const index = steps.indexOf(currentStep);
  const nextStep = index >= 0 ? steps[index + 1] ?? null : null;
  return {
    kind: StepTransitionKind.advance,
    nextStep,
    iterationCompleted: nextStep === null,
  };
}

export function nextStepDecision(input: StepTransitionInput): StepTransition {
  const { steps, currentStep, result, attempt, report } = input;
  const maxAttempts = input.maxAttempts ?? MAX_PIPELINE_ATTEMPTS;

  if (result === StepRunStatus.success) {
    return advanceFrom(steps, currentStep);
  }

  if (TERMINAL_FAILURE_STEPS.includes(currentStep)) {
    return {
      kind: StepTransitionKind.iteration_failed,
      failedStep: currentStep,
    };
  }

  if (!steps.includes(PipelineStep.resolve)) {
    return {
      kind: StepTransitionKind.iteration_failed,
      failedStep: currentStep,
    };
  }

  if (blockingFindings(report).length === 0) {
    return advanceFrom(steps, currentStep);
  }

  const nextAttempt = attempt + 1;
  if (nextAttempt > maxAttempts) {
    return { kind: StepTransitionKind.needs_input, reason: 'max_attempts' };
  }
  return { kind: StepTransitionKind.retry_resolve, attempt: nextAttempt };
}