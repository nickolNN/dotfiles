import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { workspaceHostDirFor } from '../workspace/paths';
import { readTextFileOrNull } from '../util/files';
import { JSON_PARSE_FAILED, tryParseJson } from '../util/json-file';
import { asRecord } from '../util/records';
import { nowIso } from '../db/rows';

export async function upsertMergeRequestsFromResultJson(
  db: Db,
  workspaceRoot: string,
  issueId: string,
): Promise<void> {
  const resultPath = join(
    workspaceHostDirFor(workspaceRoot, issueId),
    'result.json',
  );
  const parsed = tryParseJson(readTextFileOrNull(resultPath));
  if (parsed === JSON_PARSE_FAILED) return;
  const list = asRecord(parsed)?.merge_requests;
  if (!Array.isArray(list) || list.length === 0) return;

  interface MrEntry {
    repository_url: string;
    url: string;
    title?: string;
    message?: string;
  }
  const newMrs: MrEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const mr = item as Record<string, unknown>;
    const url = typeof mr.url === 'string' ? mr.url.trim() : '';
    if (!url) continue;
    newMrs.push({
      repository_url: typeof mr.repository_url === 'string' ? mr.repository_url : '',
      url,
      ...(typeof mr.title === 'string' ? { title: mr.title } : {}),
      ...(typeof mr.message === 'string' ? { message: mr.message } : {}),
    });
  }
  if (newMrs.length === 0) return;

  const currentRow = db
    .select({ merge_requests: issues.merge_requests })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const existing: MrEntry[] = currentRow?.merge_requests ?? [];
  const byUrl = new Map<string, MrEntry>();
  for (const mr of existing) byUrl.set(mr.url ?? '', mr);
  for (const mr of newMrs) byUrl.set(mr.url ?? '', mr);

  db.update(issues)
    .set({ merge_requests: [...byUrl.values()], updated_at: nowIso() })
    .where(eq(issues.id, issueId))
    .run();
}
