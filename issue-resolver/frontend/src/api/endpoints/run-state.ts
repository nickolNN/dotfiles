import {
  IssueRunKind,
  RunState,
  StepRunStatus,
  type StepRunWithLog,
} from '@issue-resolver/shared';
import { isNullableString } from '../guards';
import { isSessionEvent, isSessionStats } from '../sse/guards';
import { requestJson } from './http';

export const RUN_STATES: ReadonlySet<string> = new Set(Object.values(RunState));

const STEP_RUN_STATUSES: ReadonlySet<string> = new Set(
  Object.values(StepRunStatus),
);

function isStepRunWithLog(
  value: Partial<StepRunWithLog> | null,
  step: IssueRunKind,
): value is StepRunWithLog {
  if (!value) return false;
  return (
    typeof value.id === 'string' &&
    value.step === step &&
    typeof value.status === 'string' &&
    STEP_RUN_STATUSES.has(value.status) &&
    typeof value.issue_id === 'string' &&
    typeof value.attempt === 'number' &&
    typeof value.context === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    Array.isArray(value.events) &&
    (value.stats === undefined ||
      value.stats === null ||
      isSessionStats(value.stats)) &&
    isNullableString(value.iteration_id ?? null) &&
    isNullableString(value.feedback ?? null) &&
    isNullableString(value.report ?? null) &&
    isNullableString(value.screenshots_dir ?? null)
  );
}

export async function readStepRun(
  url: string,
  step: IssueRunKind,
  label: string,
): Promise<StepRunWithLog> {
  const payload = await requestJson<Partial<StepRunWithLog> | null>(url);
  if (!isStepRunWithLog(payload, step)) {
    throw new Error(`некорректный ответ прогона ${label}`);
  }
  return {
    ...payload,
    stats: payload.stats ?? null,
    iteration_id: payload.iteration_id ?? null,
    feedback: payload.feedback ?? null,
    report: payload.report ?? null,
    screenshots_dir: payload.screenshots_dir ?? null,
    events: payload.events.filter(isSessionEvent),
  };
}