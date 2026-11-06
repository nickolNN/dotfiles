import type { PipelineStep } from '@issue-resolver/shared';
import type { StepExecutionResult } from '@issue-resolver/shared';
import type { StepReport } from '@issue-resolver/shared';

interface SelfRetry {
  attempt: number;
  max: number;
}

export function crashFeedback(
  step: PipelineStep,
  message: string,
  retry: SelfRetry,
): string {
  return [
    `Previous ${step} attempt CRASHED: ${message}`,
    `(self-retry ${retry.attempt}/${retry.max})`,
    'Fix the crash and continue — do not redo work from scratch if partial results exist.',
  ].join('\n');
}

export function failedStepFeedback(
  step: PipelineStep,
  report: StepReport | null,
  result: StepExecutionResult,
  retry: SelfRetry,
): string {
  const parts = [`Previous ${step} attempt FAILED.`];
  if (report?.summary) parts.push(`Report: ${report.summary}`);
  if (result.stderr) {
    parts.push(`Stderr (last 2000 chars): ${result.stderr.slice(-2000)}`);
  }
  parts.push(
    `(self-retry ${retry.attempt}/${retry.max})`,
    'Fix the issues and continue — use any partial results from the previous attempt.',
  );
  return parts.join('\n');
}

export function refineRejectedFeedback(planProblem: string): string {
  return [
    'Previous refine plan was REJECTED by the engine.',
    `Engine check: ${planProblem}.`,
    'Re-plan so that the engine check passes, then return the corrected',
    'execution object.',
  ].join('\n');
}