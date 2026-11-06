import { describe, expect, it } from 'vitest';

import {
  MAX_PIPELINE_ATTEMPTS,
  nextStepDecision,
  type StepTransitionInput,
} from '../src/workflow';
import type { PipelineStep, StepReport, StepReportFinding } from '../src/types';

function decide(
  steps: PipelineStep[],
  currentStep: PipelineStep,
  result: 'success' | 'failed',
  attempt = 1,
  maxAttempts?: number,
) {
  return nextStepDecision({ steps, currentStep, result, attempt, maxAttempts });
}

const failReport = (findings?: StepReportFinding[]): StepReport => ({
  status: 'fail',
  summary: 'review found defects',
  ...(findings === undefined ? {} : { findings }),
});

function decideReport(
  report: StepReport | null | undefined,
  overrides: Partial<StepTransitionInput> = {},
) {
  return nextStepDecision({
    steps: ['resolve', 'review', 'pr'],
    currentStep: 'review',
    result: 'failed',
    attempt: 1,
    report,
    ...overrides,
  });
}

describe('nextStepDecision — advance on success', () => {
  it('completes the iteration when the only step (resolve) succeeds', () => {
    expect(decide(['resolve'], 'resolve', 'success')).toEqual({
      kind: 'advance',
      nextStep: null,
      iterationCompleted: true,
    });
  });

  it('advances resolve -> review', () => {
    expect(decide(['resolve', 'review', 'pr'], 'resolve', 'success')).toEqual({
      kind: 'advance',
      nextStep: 'review',
      iterationCompleted: false,
    });
  });

  it('advances review -> pr', () => {
    expect(decide(['resolve', 'review', 'pr'], 'review', 'success')).toEqual({
      kind: 'advance',
      nextStep: 'pr',
      iterationCompleted: false,
    });
  });

  it('treats a successful final pr as a completed iteration', () => {
    expect(decide(['resolve', 'pr'], 'pr', 'success')).toEqual({
      kind: 'advance',
      nextStep: null,
      iterationCompleted: true,
    });
  });
});

describe('nextStepDecision — retry_resolve on failed review/test', () => {
  it('retries resolve after a failed review at attempt 1', () => {
    expect(decide(['resolve', 'review', 'pr'], 'review', 'failed', 1)).toEqual({
      kind: 'retry_resolve',
      attempt: 2,
    });
  });

  it('retries resolve after a failed test at attempt 2', () => {
    expect(decide(['resolve', 'test'], 'test', 'failed', 2)).toEqual({
      kind: 'retry_resolve',
      attempt: 3,
    });
  });

  it('retries resolve when maxAttempts is raised to 5', () => {
    expect(
      decide(['resolve', 'review'], 'review', 'failed', 1, 5),
    ).toEqual({
      kind: 'retry_resolve',
      attempt: 2,
    });
  });

  it('raises needs_input once attempt + 1 exceeds maxAttempts', () => {
    expect(decide(['resolve', 'test'], 'test', 'failed', 3, 3)).toEqual({
      kind: 'needs_input',
      reason: 'max_attempts',
    });
  });

  it('the default budget is MAX_PIPELINE_ATTEMPTS', () => {
    expect(
      decide(['resolve', 'test'], 'test', 'failed', MAX_PIPELINE_ATTEMPTS - 1),
    ).toEqual({ kind: 'retry_resolve', attempt: MAX_PIPELINE_ATTEMPTS });
    expect(
      decide(['resolve', 'test'], 'test', 'failed', MAX_PIPELINE_ATTEMPTS),
    ).toEqual({ kind: 'needs_input', reason: 'max_attempts' });
  });
});

describe('nextStepDecision — severity decides the return', () => {
  it('advances a fail with only minor findings, as if it had passed', () => {
    expect(
      decideReport(
        failReport([
          { severity: 'minor', title: 'typo' },
          { severity: 'low', title: 'stale comment' },
        ]),
      ),
    ).toEqual({ kind: 'advance', nextStep: 'pr', iterationCompleted: false });
  });

  it('retries resolve on a fail with one major finding', () => {
    expect(decideReport(failReport([{ severity: 'major', title: 'wrong focus' }]))).toEqual({
      kind: 'retry_resolve',
      attempt: 2,
    });
  });

  it('retries resolve on a fail without any finding — silent fail is blocking', () => {
    expect(decideReport(failReport())).toEqual({
      kind: 'retry_resolve',
      attempt: 2,
    });
  });

  it('retries resolve on a fail without a report at all', () => {
    expect(decideReport(null)).toEqual({ kind: 'retry_resolve', attempt: 2 });
  });

  it('retries resolve when a severity outside the set is unreadable', () => {
    const report = {
      status: 'fail',
      summary: 'review found defects',
      findings: [{ severity: 'high', title: 'unknown grade' }],
    } as unknown as StepReport;

    expect(decideReport(report)).toEqual({ kind: 'retry_resolve', attempt: 2 });
  });

  it('asks the human when blocking findings outlive the attempt budget', () => {
    expect(
      decideReport(failReport([{ severity: 'critical', title: 'crash' }]), {
        attempt: 3,
        maxAttempts: 3,
      }),
    ).toEqual({ kind: 'needs_input', reason: 'max_attempts' });
  });

  it('advances a pass even when it carries a major finding', () => {
    expect(
      decideReport(
        {
          status: 'pass',
          summary: 'shipped, with one remark',
          findings: [{ severity: 'major', title: 'remark' }],
        },
        { result: 'success' },
      ),
    ).toEqual({ kind: 'advance', nextStep: 'pr', iterationCompleted: false });
  });
});

describe('nextStepDecision — iteration_failed on failed refine/resolve/pr', () => {
  it('fails the iteration when resolve fails', () => {
    expect(decide(['resolve', 'pr'], 'resolve', 'failed')).toEqual({
      kind: 'iteration_failed',
      failedStep: 'resolve',
    });
  });

  it('fails the iteration when refine fails', () => {
    expect(decide(['refine', 'resolve', 'pr'], 'refine', 'failed')).toEqual({
      kind: 'iteration_failed',
      failedStep: 'refine',
    });
  });

  it('fails the iteration when the final pr fails', () => {
    expect(decide(['resolve', 'pr'], 'pr', 'failed')).toEqual({
      kind: 'iteration_failed',
      failedStep: 'pr',
    });
  });
});

describe('nextStepDecision — resolve missing from steps', () => {
  it('cannot retry_resolve without a resolve step, so the iteration fails', () => {
    expect(decide(['review', 'test'], 'review', 'failed', 1)).toEqual({
      kind: 'iteration_failed',
      failedStep: 'review',
    });
  });
});