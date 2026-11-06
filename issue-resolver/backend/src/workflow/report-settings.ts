import { and, desc, eq } from 'drizzle-orm';
import { TaskStatus } from '@issue-resolver/shared';
import type { ThinkingLevel } from '@issue-resolver/shared';
import { issues, iterations } from '../db/schema';
import type { Db } from '../db/client';

export function reportModelFor(
  db: Db,
  issueId: string,
  iterationId?: string,
): string | undefined {
  const issue = db
    .select({ step_models: issues.step_models })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const explicit = issue?.step_models?.report;
  if (explicit) return explicit;

  const iteration = iterationId
    ? db
        .select({ model: iterations.model })
        .from(iterations)
        .where(eq(iterations.id, iterationId))
        .get()
    : db
        .select({ model: iterations.model })
        .from(iterations)
        .where(
          and(
            eq(iterations.issue_id, issueId),
            eq(iterations.status, TaskStatus.completed),
          ),
        )
        .orderBy(desc(iterations.number))
        .get();
  return iteration?.model ?? undefined;
}

export function reportThinkingLevelFor(
  db: Db,
  issueId: string,
): ThinkingLevel | undefined {
  const issue = db
    .select({ step_thinking_levels: issues.step_thinking_levels })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  return issue?.step_thinking_levels?.report;
}
