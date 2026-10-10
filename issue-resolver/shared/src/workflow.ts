import type { PipelineStep } from './types';

/**
 * Детерминированное решение о переходе конвейера (план §8).
 * Чистая функция: без I/O и побочных эффектов.
 */
export type StepTransition =
  | { kind: 'advance'; nextStep: PipelineStep | null; iterationCompleted: boolean }
  | { kind: 'retry_resolve'; attempt: number }
  | { kind: 'needs_input'; reason: 'max_attempts' }
  | { kind: 'iteration_failed'; failedStep: PipelineStep };

export interface StepTransitionInput {
  steps: PipelineStep[];
  currentStep: PipelineStep;
  result: 'success' | 'failed';
  /** 1-based номер попытки текущего шага. */
  attempt: number;
  /** По умолчанию 3. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Шаги, провал которых не перезапускает resolve, а сразу валит итерацию.
 * (refine, resolve и pr — по §8; review/test обрабатываются отдельно ниже.)
 */
const TERMINAL_FAILURE_STEPS: readonly PipelineStep[] = ['refine', 'resolve', 'pr'];

/**
 * Переход состояния конвейера.
 *
 * - success → advance на следующий шаг в steps; если следующего нет →
 *   { nextStep: null, iterationCompleted: true } (частный случай — успешный final pr).
 * - failed + currentStep ∈ {review, test} → retry_resolve с attempt + 1;
 *   если attempt + 1 > maxAttempts → needs_input ('max_attempts').
 * - failed + currentStep ∈ {refine, resolve, pr} → iteration_failed.
 *
 * Поведение при отсутствии 'resolve' в steps: перезапускать нечего, поэтому
 * провал review/test деградирует до iteration_failed (failedStep = currentStep).
 * Если currentStep вообще не найден в steps, он считается завершающим и
 * success даёт iterationCompleted: true.
 */
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

  // currentStep ∈ {review, test}: можно перезапустить конвейер с resolve.
  if (!steps.includes('resolve')) {
    return { kind: 'iteration_failed', failedStep: currentStep };
  }

  const nextAttempt = attempt + 1;
  if (nextAttempt > maxAttempts) {
    return { kind: 'needs_input', reason: 'max_attempts' };
  }
  return { kind: 'retry_resolve', attempt: nextAttempt };
}