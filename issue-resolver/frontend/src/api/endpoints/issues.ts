import type {
  CreateIssueRequest,
  Issue,
  IssueFile,
  JiraValidationResult,
} from '@issue-resolver/shared';
import { isRecord, isString } from '../guards';
import {
  API_BASE,
  requestJson,
  requestJsonOrNull,
  requestText,
  requestVoid,
} from './http';

export function getIssues(): Promise<Issue[]> {
  return requestJson<Issue[]>(`${API_BASE}/issues`);
}

export function getIssue(id: string): Promise<Issue> {
  return requestJson<Issue>(`${API_BASE}/issues/${id}`);
}

export function createIssue(request: CreateIssueRequest): Promise<Issue> {
  return requestJson<Issue>(`${API_BASE}/issues`, {
    method: 'POST',
    json: request,
  });
}

export function deleteIssue(id: string): Promise<void> {
  return requestVoid(`${API_BASE}/issues/${id}`, { method: 'DELETE' });
}

export function startIssue(
  issueId: string,
): Promise<{ ok: boolean; iterationId: string }> {
  return requestJson<{ ok: boolean; iterationId: string }>(
    `${API_BASE}/issues/${issueId}/start`,
    { method: 'POST' },
  );
}

export function validateJiraUrl(url: string): Promise<JiraValidationResult> {
  return requestJson<JiraValidationResult>(`${API_BASE}/issues/validate-jira`, {
    method: 'POST',
    json: { url },
  });
}

function isIssueFile(value: unknown): value is IssueFile {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.issue_id) &&
    isString(value.name)
  );
}

export async function getIssueFiles(issueId: string): Promise<IssueFile[]> {
  const data = await requestJsonOrNull<unknown>(
    `${API_BASE}/issues/${issueId}/files`,
  );
  return Array.isArray(data) ? data.filter(isIssueFile) : [];
}

export function getJiraPreview(issueId: string): Promise<string> {
  return requestText(`${API_BASE}/issues/${issueId}/jira-preview`);
}

export function deleteIssueFile(fileId: string): Promise<void> {
  return requestVoid(`${API_BASE}/files/${fileId}`, { method: 'DELETE' });
}