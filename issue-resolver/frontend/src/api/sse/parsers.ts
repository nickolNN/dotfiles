import { IssueDeletingPhase, StepRunStatus } from '@issue-resolver/shared';
import type { SSEEvent } from '@issue-resolver/shared';
import { isNumber, isOneOf, isRecord, isString } from '../guards';
import { isSessionEvent, parseSessionEvent } from './guards';
import type {
  AgentEventPayload,
  ContainerStatsPayload,
  IssueDeletedPayload,
  IssueDeletingPayload,
  StepEventPayload,
  WorkspaceProgressPayload,
} from './types';

const DELETING_PHASES = Object.values(IssueDeletingPhase);
const STEP_RUN_STATUSES = Object.values(StepRunStatus);

function parseJsonObject(data: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

export function parseStepStatusPayload(data: string): StepRunStatus | null {
  const parsed = parseJsonObject(data);
  if (!parsed) return null;
  const { status } = parsed;
  return isOneOf(STEP_RUN_STATUSES, status) ? status : null;
}

export function parseStepEventPayload(data: string): StepEventPayload | null {
  const record = parseJsonObject(data);
  if (!record) return null;

  const stepRunId = isString(record.stepRunId) ? record.stepRunId : undefined;
  const agentId = isString(record.agentId) ? record.agentId : undefined;

  if (isSessionEvent(record.event)) {
    return { stepRunId, agentId, event: record.event };
  }

  if (isSessionEvent(record)) {
    return { stepRunId, agentId, event: record };
  }

  return null;
}

export function parseWorkspaceProgressPayload(
  data: string,
): WorkspaceProgressPayload | null {
  const record = parseJsonObject(data);
  if (!record) return null;
  if (!isString(record.step) || !isString(record.status)) return null;

  return {
    step: record.step,
    status: record.status,
    repo: isString(record.repo) ? record.repo : undefined,
    message: isString(record.message) ? record.message : undefined,
    devPort: isNumber(record.devPort) ? record.devPort : undefined,
  };
}

export function parseIssueDeletingPayload(
  raw: SSEEvent,
): IssueDeletingPayload | null {
  if (!raw.issueId) return null;

  const record = parseJsonObject(raw.data);
  if (!record) return null;

  const { phase } = record;
  if (!isOneOf(DELETING_PHASES, phase)) return null;

  return {
    issueId: raw.issueId,
    phase,
    ...(isString(record.message) ? { message: record.message } : {}),
    ts: raw.ts,
  };
}

export function parseIssueDeletedPayload(
  raw: SSEEvent,
): IssueDeletedPayload | null {
  if (!raw.issueId) return null;
  return { issueId: raw.issueId, ts: raw.ts };
}

export function parseContainerStatsPayload(
  data: unknown,
): ContainerStatsPayload | null {
  if (!isString(data)) return null;
  const record = parseJsonObject(data);
  if (!record) return null;

  return {
    cpuPercent: isNumber(record.cpuPercent) ? record.cpuPercent : null,
    memoryUsageBytes: isNumber(record.memoryUsageBytes)
      ? record.memoryUsageBytes
      : 0,
    memoryLimitBytes: isNumber(record.memoryLimitBytes)
      ? record.memoryLimitBytes
      : 0,
    pids: isNumber(record.pids) ? record.pids : 0,
  };
}

export function parseAgentEventPayload(
  data: string,
): AgentEventPayload | null {
  const record = parseJsonObject(data);
  if (!record) return null;

  const agentId = isString(record.agentId) ? record.agentId : undefined;
  const stepRunId = isString(record.stepRunId) ? record.stepRunId : undefined;

  const event = parseSessionEvent(record.event) ?? parseSessionEvent(record);
  if (event) {
    return { stepRunId, agentId, event };
  }
  return null;
}