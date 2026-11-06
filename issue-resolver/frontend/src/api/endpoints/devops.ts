import {
  IssueRunKind,
  RunState,
  type RunStatusPayload,
  type StepRunWithLog,
} from '@issue-resolver/shared';
import { API_BASE, requestJson } from './http';
import { readStepRun } from './run-state';

export interface DevopsStatus extends RunStatusPayload {
  status: RunState;
}

function devopsUrl(issueId: string): string {
  return `${API_BASE}/issues/${encodeURIComponent(issueId)}/devops`;
}

export function runDevopsAgent(issueId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(devopsUrl(issueId), { method: 'POST' });
}

export function getDevopsStatus(issueId: string): Promise<DevopsStatus> {
  return requestJson<DevopsStatus>(`${devopsUrl(issueId)}/status`);
}

export function getDevopsRun(issueId: string): Promise<StepRunWithLog> {
  return readStepRun(`${devopsUrl(issueId)}/run`, IssueRunKind.devops, 'devops');
}