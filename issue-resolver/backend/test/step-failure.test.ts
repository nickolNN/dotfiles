import type { StepReport, StepRunOutcome } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { STEP_FAILURE_TEXT, failureReportOverride } from '../src/workflow/step-failure';
import { StepReportStatus, StepRunStatus } from '@issue-resolver/shared';

const pass: StepReport = { status: StepReportStatus.pass, summary: 'ok' };
const fail: StepReport = { status: StepReportStatus.fail, summary: 'нашёл 3 дефекта' };

const failed = (failure: StepRunOutcome['failure']): StepRunOutcome => ({
  status: StepRunStatus.failed,
  failure,
});

describe('failureReportOverride', () => {
  it('без отчёта синтезирует fail с причиной', () => {
    expect(failureReportOverride(failed('no_report'), null)).toEqual({
      status: 'fail',
      summary: STEP_FAILURE_TEXT.no_report,
    });
    expect(failureReportOverride(failed('agent_exit'), null)).toEqual({
      status: 'fail',
      summary: STEP_FAILURE_TEXT.agent_exit,
    });
  });

  it('не трогает отчёт, который агент написал сам', () => {
    expect(failureReportOverride(failed('agent_exit'), pass)).toBeNull();
    expect(failureReportOverride(failed('report_fail'), fail)).toBeNull();
  });

  it('не трогает успех, aborted и needs_input', () => {
    expect(
      failureReportOverride({ status: StepRunStatus.success, failure: null }, pass),
    ).toBeNull();
    expect(
      failureReportOverride({ status: StepRunStatus.aborted, failure: null }, fail),
    ).toBeNull();
    expect(
      failureReportOverride({ status: StepRunStatus.needs_input, failure: null }, fail),
    ).toBeNull();
  });

  it('перекрывает любой отчёт, если модель не отвечала', () => {
    expect(failureReportOverride(failed('no_model_reply'), pass)).toEqual({
      status: 'fail',
      summary: `${STEP_FAILURE_TEXT.no_model_reply} (отчёт шага: ok)`,
    });
    expect(failureReportOverride(failed('no_model_reply'), fail)).toEqual({
      status: 'fail',
      summary: `${STEP_FAILURE_TEXT.no_model_reply} (отчёт шага: нашёл 3 дефекта)`,
    });
  });

  it('отчёт с пустым summary не оставляет пустых скобок', () => {
    expect(
      failureReportOverride(failed('no_model_reply'), {
        status: StepReportStatus.pass,
        summary: '   ',
      }),
    ).toEqual({ status: 'fail', summary: STEP_FAILURE_TEXT.no_model_reply });
  });
});