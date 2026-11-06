import { TaskStatus } from '@issue-resolver/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues, iterations } from '../db/schema';

export function getIssueRow(
  db: Db,
  id: string,
): (typeof issues.$inferSelect) | undefined {
  return db.select().from(issues).where(eq(issues.id, id)).get();
}

export function latestCompletedIterationId(
  db: Db,
  issueId: string,
): string | null {
  const row = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, issueId),
        eq(iterations.status, TaskStatus.completed),
      ),
    )
    .orderBy(desc(iterations.number))
    .get();
  return row?.id ?? null;
}