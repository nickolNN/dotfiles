import type { StepReport, StepRunOutcome } from '@issue-resolver/shared';
import { StepFailureReason, StepReportStatus, StepRunStatus } from '@issue-resolver/shared';

export const STEP_FAILURE_TEXT: Record<StepFailureReason, string> = {
  [StepFailureReason.no_model_reply]:
    'модель не ответила ни разу за прогон — шаг не начал работу: нет доступа к pi или к провайдеру модели',
  [StepFailureReason.no_report]:
    'шаг завершился, не записав .issue-step-result.json — результата шага нет, проверять нечего',
  [StepFailureReason.agent_exit]: 'агент шага упал до записи результата',
  [StepFailureReason.report_fail]: 'шаг вернул status: fail',
};

export function failureReportOverride(
  outcome: StepRunOutcome,
  rawReport: StepReport | null,
): StepReport | null {
  if (outcome.status !== StepRunStatus.failed || outcome.failure === null) return null;
  const summary = STEP_FAILURE_TEXT[outcome.failure];
  if (rawReport === null) return { status: StepReportStatus.fail, summary };
  if (outcome.failure !== StepFailureReason.no_model_reply) return null;
  const claimed = rawReport.summary.trim();
  return {
    ...rawReport,
    status: StepReportStatus.fail,
    summary: claimed.length > 0 ? `${summary} (отчёт шага: ${claimed})` : summary,
  };
}