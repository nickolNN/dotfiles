import type { WorkspaceFile } from '@issue-resolver/shared';
import { API_BASE, requestJson, requestText, send, withQuery } from './http';

export function fileContentUrl(fileId: string): string {
  return `${API_BASE}/files/${fileId}/content`;
}

function resultFilesUrl(issueId: string): string {
  return `${API_BASE}/issues/${issueId}/result/files`;
}

export function resultFileContentUrl(
  issueId: string,
  relPath: string,
): string {
  return withQuery(`${API_BASE}/issues/${issueId}/result/files/content`, {
    path: relPath,
  });
}

export function resultFilePreviewUrl(
  issueId: string,
  relPath: string,
): string {
  return withQuery(`${API_BASE}/issues/${issueId}/result/files/content`, {
    path: relPath,
    inline: 1,
  });
}

export function resultFilesArchiveUrl(issueId: string): string {
  return `${API_BASE}/issues/${issueId}/result/files/archive`;
}

export function getResultFiles(issueId: string): Promise<WorkspaceFile[]> {
  return requestJson<WorkspaceFile[]>(resultFilesUrl(issueId));
}

export interface ResultArtifactMeta {
  status: number;
  contentType: string;
  source: string | null;
  mtime: string | null;
}

export async function probeResultArtifact(
  issueId: string,
): Promise<ResultArtifactMeta | null> {
  try {
    const response = await send(`${API_BASE}/issues/${issueId}/result`, {
      method: 'HEAD',
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      source: response.headers.get('x-artifact-source'),
      mtime: response.headers.get('x-artifact-mtime'),
    };
  } catch {
    return null;
  }
}

export async function getResultMarkdown(issueId: string): Promise<string | null> {
  try {
    return await requestText(`${API_BASE}/issues/${issueId}/result`);
  } catch {
    return null;
  }
}

export function getResultFileText(
  issueId: string,
  relPath: string,
): Promise<string> {
  return requestText(resultFileContentUrl(issueId, relPath));
}
