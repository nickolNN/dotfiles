import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { MergeRequestRecord } from '@issue-resolver/shared';
import type { Db } from './client';
import { iterationMergeRequests, iterations } from './schema';

export function insertMergeRequest(
  db: Db,
  input: Omit<MergeRequestRecord, 'id'>,
): void {
  db.insert(iterationMergeRequests)
    .values({
      id: randomUUID(),
      iteration_id: input.iterationId,
      repository_url: input.repositoryUrl,
      mr_url: input.mrUrl,
      mr_id: input.mrId,
      mr_source: input.mrSource,
      head_branch: input.headBranch,
      created_at: input.createdAt,
    })
    .run();
}

/** Возвращает все MR одной итерации. */
export function listMergeRequestsByIteration(
  db: Db,
  iterationId: string,
): MergeRequestRecord[] {
  return db
    .select()
    .from(iterationMergeRequests)
    .where(eq(iterationMergeRequests.iteration_id, iterationId))
    .all()
    .map((row) => ({
      iterationId: row.iteration_id,
      repositoryUrl: row.repository_url,
      mrUrl: row.mr_url,
      mrId: row.mr_id,
      mrSource: row.mr_source,
      headBranch: row.head_branch,
      createdAt: row.created_at,
    }));
}

/** Возвращает все MR задачи (всех итераций), сортированные по дате (свежие раньше). */
export function listMergeRequestsByIssue(
  db: Db,
  issueId: string,
  limit?: number,
): MergeRequestRecord[] {
  // Получаем все итерации задачи
  const issueIterationIds = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(eq(iterations.issue_id, issueId))
    .all()
    .map((r) => r.id);

  if (issueIterationIds.length === 0) return [];

  // Фильтруем MR по iteration_id из этого списка
  const allMrs = db
    .select()
    .from(iterationMergeRequests)
    .all()
    .filter((row) => issueIterationIds.includes(row.iteration_id))
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

  const result: MergeRequestRecord[] = allMrs.map((row) => ({
    iterationId: row.iteration_id,
    repositoryUrl: row.repository_url,
    mrUrl: row.mr_url,
    mrId: row.mr_id,
    mrSource: row.mr_source,
    headBranch: row.head_branch,
    createdAt: row.created_at,
  }));

  return limit ? result.slice(0, limit) : result;
}