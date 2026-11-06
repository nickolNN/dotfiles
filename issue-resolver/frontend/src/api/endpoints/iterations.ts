import type {
  CreateIterationRequest,
  Iteration,
  StepRunWithLog,
} from '@issue-resolver/shared';
import { API_BASE, requestJson, requestVoid } from './http';

export function getIterations(issueId: string): Promise<Iteration[]> {
  return requestJson<Iteration[]>(`${API_BASE}/issues/${issueId}/iterations`);
}

export function createIteration(
  issueId: string,
  request: CreateIterationRequest,
): Promise<Iteration> {
  return requestJson<Iteration>(`${API_BASE}/issues/${issueId}/iterations`, {
    method: 'POST',
    json: request,
  });
}

export function getStepRuns(
  iterationId: string,
): Promise<StepRunWithLog[]> {
  return requestJson<StepRunWithLog[]>(
    `${API_BASE}/iterations/${iterationId}/step-runs`,
  );
}

export function repeatIteration(iterationId: string): Promise<Iteration> {
  return requestJson<Iteration>(
    `${API_BASE}/iterations/${iterationId}/repeat`,
    { method: 'POST' },
  );
}

export function queueIteration(iterationId: string): Promise<Iteration> {
  return requestJson<Iteration>(
    `${API_BASE}/iterations/${iterationId}/queue`,
    { method: 'POST' },
  );
}

export function updateIteration(
  iterationId: string,
  request: { context: string },
): Promise<Iteration> {
  return requestJson<Iteration>(`${API_BASE}/iterations/${iterationId}`, {
    method: 'PUT',
    json: request,
  });
}

export function abortIteration(iterationId: string): Promise<void> {
  return requestVoid(
    `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/abort`,
    { method: 'POST' },
  );
}