import type { Issue } from '@issue-resolver/shared';
import { API_BASE, requestJson } from './http';

export function devServerPortOf(issue: Issue): number | null {
  return issue.dev_server_port ?? null;
}

export function stopDevServers(issueId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/stop-dev-servers`,
    { method: 'POST' },
  );
}
