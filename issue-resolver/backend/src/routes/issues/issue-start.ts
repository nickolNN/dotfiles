import { randomUUID } from 'node:crypto';
import { TaskStatus } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import type { IssuesContext } from './context';
import { listIssueRepositories } from '../../db/issue-repositories.repo';
import { issues, iterations } from '../../db/schema';
import {
  startIteration,
  startIterationIssue,
} from '../../workflow/start-iteration';
import { ROUTE_PATH } from './paths';
import { resolvePipelineSteps } from './pipeline';
import { conflict, draftOnlyConflict, notFound } from '../params';
import { nowIso } from '../../db/rows';

export function registerIssueStart(ctx: IssuesContext): void {
  const { app, db, deps, service, config } = ctx;
  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/start`,
    async (request, reply) => {
      const { id } = request.params;

      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }
      if (issue.status !== TaskStatus.draft) {
        return conflict(reply, 'only draft issues can be started');
      }

      const claimed = draftOnlyConflict(reply, db, id);
      if (claimed) return claimed;

      const repositories = listIssueRepositories(db, id);

      const createMr = repositories.some(
        (repository) => repository.create_mr,
      );
      const pipelineSteps = resolvePipelineSteps(
        issue.pipeline_steps,
        createMr,
      );
      const now = nowIso();
      const iterationId = randomUUID();

      db.transaction((tx) => {
        tx.update(issues)
          .set({ status: TaskStatus.pending, updated_at: now })
          .where(eq(issues.id, id))
          .run();

        tx.insert(iterations)
          .values({
            id: iterationId,
            issue_id: id,
            number: 1,
            context: issue.description ?? '',
            review_context: '',
            is_review_need: false,
            steps: pipelineSteps,
            model: null,
            step_models: issue.step_models ?? null,
            thinking_level: issue.thinking_level ?? null,
            step_thinking_levels: issue.step_thinking_levels ?? null,
            status: TaskStatus.pending,
            created_at: now,
            updated_at: now,
          })
          .run();
      });

      startIteration(db, deps, {
        issue: startIterationIssue(issue, pipelineSteps),
        iteration: {
          id: iterationId,
          issueId: id,
          number: 1,
          context: issue.description ?? '',
          steps: pipelineSteps,
          reviewContext: '',
          isReviewNeed: false,
          worker_count: issue.worker_count ?? undefined,
        },
        models: {
          step_models: issue.step_models ?? undefined,
          thinking_level: issue.thinking_level ?? undefined,
          step_thinking_levels: issue.step_thinking_levels ?? undefined,
        },
        repositories,
        devops: {
          devopsModel: issue.devops_model ?? undefined,
          devopsThinkingLevel: issue.devops_thinking_level ?? undefined,
        },
        markIssueFailedOnPrepareError: true,
      });

      return { ok: true, iterationId };
    },
  );
}
