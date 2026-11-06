import type {
  CreateIssueRequest,
  CreateIterationRequest,
  Issue,
  Iteration,
} from '@issue-resolver/shared';
import { API_BASE, requestJson } from './http';

export function buildUploadFormData(
  request: CreateIssueRequest | CreateIterationRequest,
  files: File[],
): FormData {
  const form = new FormData();
  form.append('payload', JSON.stringify(request));
  for (const file of files) {
    form.append('files', file, file.name);
  }
  return form;
}

function postMultipart<T>(
  url: string,
  request: CreateIssueRequest | CreateIterationRequest,
  files: File[],
): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    form: buildUploadFormData(request, files),
  });
}

export function createIssueWithFiles(
  request: CreateIssueRequest,
  files: File[],
): Promise<Issue> {
  return postMultipart<Issue>(`${API_BASE}/issues`, request, files);
}

export function createIterationWithFiles(
  issueId: string,
  request: CreateIterationRequest,
  files: File[],
): Promise<Iteration> {
  return postMultipart<Iteration>(
    `${API_BASE}/issues/${issueId}/iterations`,
    request,
    files,
  );
}