import { and, asc, eq } from 'drizzle-orm';
import { TaskStatus } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { listIssueRepositories } from '../db/issue-repositories.repo';
import { issues, iterations } from '../db/schema';
import type { IterationRunDeps } from './service-contracts';
import { startIteration, startIterationIssue } from './start-iteration';

export async function startNextPendingIteration(
  db: Db,
  deps: IterationRunDeps,
  issueId: string,
): Promise<void> {
  const next = db
    .select()
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, issueId),
        eq(iterations.status, TaskStatus.pending),
      ),
    )
    .orderBy(asc(iterations.number))
    .get();

  if (!next) return;

  const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) return;

  const repositories = listIssueRepositories(db, issueId);

  console.error(
    `[queue] starting pending iteration ${next.id} (#${next.number}) for issue ${issueId}`,
  );

  startIteration(db, deps, {
    issue: startIterationIssue(issue),
    iteration: {
      id: next.id,
      issueId: issue.id,
      number: next.number,
      context: next.context,
      steps: next.steps,
      reviewContext: next.review_context ?? '',
      isReviewNeed: !!next.is_review_need,
      worker_count: next.worker_count ?? undefined,
    },
    models: {
      model: next.model ?? undefined,
      step_models: next.step_models ?? undefined,
      thinking_level: next.thinking_level ?? undefined,
      step_thinking_levels: next.step_thinking_levels ?? undefined,
    },
    repositories,
    devops: {
      devopsModel: deps.devopsModel,
      devopsThinkingLevel: deps.devopsThinkingLevel,
    },
  });
}