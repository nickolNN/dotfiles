import { describe, expect, it } from 'vitest';
import type { ExecutionPlan, PipelineStep, StepExecutionResult } from '@issue-resolver/shared';
import { stepRunOutcome, StepReportStatus } from '@issue-resolver/shared';
import { FakePiRunner } from '../src/pi/runner';
import {
  runStagedResolve,
  type StagedResolveInput,
  type StagedResolveOptions,
} from '../src/workflow/staged-resolve';
import {
  COMPLEX_STAGES_PLAN,
  WAVE_PLAN,
  SEQUENTIAL_STAGES_PLAN,
} from './execution-plans.example';

const STEP: PipelineStep = 'resolve';

const input = (execution: ExecutionPlan): StagedResolveInput => ({
  containerName: 'issue-resolver-issue-1',
  execution,
  issueTitle: 'Fix bug',
  description: 'desc',
  jiraText: null,
  context: 'ctx',
  feedback: null,
  refinedPlan: 'plan',
  repoPaths: ['/workspaces/issue-1/app'],
  desiredResult: 'md',
  previousOutcome: null,
  attachmentPaths: [],
});

const options = (): StagedResolveOptions => ({
  stepRunId: 'run-1',
  iterationId: 'iter-1',
  issueId: 'issue-1',
});

const pass = (summary: string): StepExecutionResult => ({
  step: STEP,
  exitCode: 0,
  report: { status: StepReportStatus.pass, summary },
  stdout: '',
  stderr: '',
});

function expectSuccessfulResolve(result: StepExecutionResult): void {
  expect(result.aborted).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(result, 'aborted')).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.report?.status).toBe('pass');
  expect(stepRunOutcome({ exitCode: result.exitCode, report: result.report }).status).toBe(
    'success',
  );
}

describe('resolve не становится aborted, когда все агенты вернули pass', () => {
  it('волна: все исполнители и финальный lead pass → результат pass/success, не aborted', async () => {
    const pi = new FakePiRunner();
    for (const summary of ['w1', 'w2', 'w3', 'coord']) {
      pi.enqueue(pass(summary));
    }

    const result = await runStagedResolve(pi, input(WAVE_PLAN), options());

    expectSuccessfulResolve(result);
    expect(result.report?.summary).toBe('coord');
    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run.run-1.s1.w0',
      'run.run-1.s1.w1',
      'run.run-1.s1.w2',
      'run-1',
    ]);
  });

  it('stages 3×1: каждый этап pass → финальный lead pass/success, не aborted', async () => {
    const pi = new FakePiRunner();
    for (const summary of ['design', 'impl', 'check', 'final']) {
      pi.enqueue(pass(summary));
    }

    const result = await runStagedResolve(
      pi,
      input(SEQUENTIAL_STAGES_PLAN),
      options(),
    );

    expectSuccessfulResolve(result);
    expect(result.report?.summary).toBe('final');
  });

  it('stages-сложный 2→1→3: все исполнители и координаторы pass → финал pass/success, не aborted', async () => {
    const pi = new FakePiRunner();
    for (const summary of [
      's1-be',
      's1-fe',
      's1-coord',
      's2',
      's3-tests',
      's3-docs',
      's3-review',
      's3-coord',
      'complex-final',
    ]) {
      pi.enqueue(pass(summary));
    }

    const result = await runStagedResolve(
      pi,
      input(COMPLEX_STAGES_PLAN),
      options(),
    );

    expectSuccessfulResolve(result);
    expect(result.report?.summary).toBe('complex-final');
    expect(pi.controlCalls).toEqual([]);
  });

  it('контроль: aborted появляется ТОЛЬКО когда раннер сам отдал aborted:true', async () => {
    const pi = new FakePiRunner();
    pi.enqueue({
      step: STEP,
      exitCode: 1,
      report: { status: StepReportStatus.fail, summary: 'aborted' },
      stdout: '',
      stderr: '',
      aborted: true,
    });

    const result = await runStagedResolve(pi, input(WAVE_PLAN), options());

    expect(result.aborted).toBe(true);
    expect(
      stepRunOutcome({ exitCode: result.exitCode, report: result.report })
        .status,
    ).toBe('failed');
  });
});