import {
  IssueRunKind,
  RunState,
  type RunStatusPayload,
  type StepRunWithLog,
} from '@issue-resolver/shared';
import { isRecord } from '../guards';
import {
  API_BASE,
  readErrorDetails,
  requestJson,
  send,
  statusErrorMessage,
  withQuery,
} from './http';
import { readStepRun, RUN_STATES } from './run-state';

interface ReportArtifactInfo {
  present: boolean;
  bytes: number;
  mtime: string | null;
}

export interface ReportStatus extends RunStatusPayload {
  status: RunState;
  artifacts?: { md: ReportArtifactInfo; html: ReportArtifactInfo };
  lastRunAt?: string;
  observedModel?: string;
  warnings?: string[];
}

function reportUrl(issueId: string): string {
  return `${API_BASE}/issues/${encodeURIComponent(issueId)}/report`;
}

export function runReportAgent(
  issueId: string,
  model?: string,
  thinkingLevel?: string,
): Promise<{ ok: boolean; reportRunId: string }> {
  return requestJson<{ ok: boolean; reportRunId: string }>(
    withQuery(reportUrl(issueId), { model, thinking: thinkingLevel }),
    { method: 'POST' },
  );
}

const INVALID_STATUS_RESPONSE = 'некорректный ответ статуса отчёта';

function isArtifactInfo(value: unknown): boolean {
  return isRecord(value) && typeof value.present === 'boolean';
}

function isArtifactPair(value: unknown): boolean {
  return isRecord(value) && isArtifactInfo(value.md) && isArtifactInfo(value.html);
}

export async function getReportStatus(issueId: string): Promise<ReportStatus> {
  const payload = await requestJson<Partial<ReportStatus> | null>(
    `${reportUrl(issueId)}/status`,
  );
  const status = payload?.status;
  if (typeof status !== 'string' || !RUN_STATES.has(status)) {
    throw new Error(INVALID_STATUS_RESPONSE);
  }
  const artifacts = payload?.artifacts;
  if (!isArtifactPair(artifacts)) {
    throw new Error(INVALID_STATUS_RESPONSE);
  }
  return { ...payload, status, artifacts };
}

export async function reembedReport(issueId: string): Promise<{
  warnings: string[];
  embed: string;
}> {
  const response = await send(`${reportUrl(issueId)}/reembed`, {
    method: 'POST',
  });
  if (!response.ok) {
    const { error, warnings = [] } = await readErrorDetails(response);
    const reason = error ?? statusErrorMessage(response);
    throw new Error(
      warnings.length > 0 ? `${reason}: ${warnings.join('; ')}` : reason,
    );
  }
  return (await response.json()) as { warnings: string[]; embed: string };
}

export function getReportRun(issueId: string): Promise<StepRunWithLog> {
  return readStepRun(`${reportUrl(issueId)}/run`, IssueRunKind.report, 'отчёта');
}