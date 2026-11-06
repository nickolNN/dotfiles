import { API_BASE, requestJson } from './http';

export interface CleanupResult {
  orphaned_workspaces: number;
  killed_processes: number;
  deleted_dirs: number;
  deleted_rooms: number;
  errors: string[];
}

export function cleanupOrphans(): Promise<CleanupResult> {
  return requestJson<CleanupResult>(`${API_BASE}/admin/cleanup-orphans`, {
    method: 'POST',
  });
}