import { and, eq } from 'drizzle-orm';
import type { IssuesContext } from './context';
import { listIssueRepositories } from '../../db/issue-repositories.repo';
import { issueRepositories, iterations } from '../../db/schema';
import { toIteration } from '../../issues/service';
import { createIterationRequestSchema } from '../../validation';
import {
  createNextIteration,
  startIterationIssue,
} from '../../workflow/start-iteration';
import { readRequestPayload } from '../multipart';
import { saveAttachments } from './attachments';
import { ROUTE_PATH } from './paths';
import { combineIterationSteps } from './pipeline';
import { badRequest, conflict, notFound } from '../params';
import { parseBody } from '../parse-body';
import { nowIso } from '../../db/rows';

export function registerIssueIterations(ctx: IssuesContext): void {
  const { app, db, deps, service, config } = ctx;
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/iterations`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }

      return db
        .select()
        .from(iterations)
        .where(eq(iterations.issue_id, id))
        .orderBy(iterations.number)
        .all()
        .map(toIteration);
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/iterations`,
    async (request, reply) => {
      const { id } = request.params;

      const requestPayload = await readRequestPayload(request);
      if (!requestPayload.ok) {
        return badRequest(reply, requestPayload.error);
      }

      const parsed = parseBody(
        reply,
        createIterationRequestSchema,
        requestPayload.body,
      );
      if (!parsed.ok) return parsed.reply;

      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const body = parsed.data;
      const isReviewNeed = body.is_review_need ?? false;
      const reviewContext = body.review_context ?? '';

      const repositories = listIssueRepositories(db, id);

      if (body.pr_repository_ids !== undefined) {
        const prIdSet = new Set(body.pr_repository_ids);
        db.update(issueRepositories)
          .set({ create_mr: false, updated_at: nowIso() })
          .where(eq(issueRepositories.issue_id, id))
          .run();
        for (const repoId of prIdSet) {
          db.update(issueRepositories)
            .set({ create_mr: true, updated_at: nowIso() })
            .where(
              and(
                eq(issueRepositories.issue_id, id),
                eq(issueRepositories.id, repoId),
              ),
            )
            .run();
        }
        repositories.length = 0;
        repositories.push(...listIssueRepositories(db, id));
      }

      const createMr = repositories.some((repository) => repository.create_mr);
      const steps = combineIterationSteps(
        body.steps ?? issue.pipeline_steps,
        createMr,
      );

      const created = await createNextIteration(db, deps, {
        issue: startIterationIssue(issue, steps),
        iteration: {
          issueId: id,
          context: body.context,
          reviewContext,
          isReviewNeed,
          steps,
          model: body.model ?? null,
          step_models: body.step_models,
          thinking_level: body.thinking_level ?? null,
          step_thinking_levels: body.step_thinking_levels,
          worker_count: body.worker_count,
        },
        repositories,
        devops: {
          devopsModel: body.devops_model,
          devopsThinkingLevel: body.devops_thinking_level,
        },
        afterCreate: (iteration) =>
          saveAttachments(
            db,
            deps,
            id,
            iteration.id,
            iteration.number,
            requestPayload.files,
          ),
      });
      if (!created.ok) return conflict(reply, created.error);

      return reply.status(201).send(created.iteration);
    },
  );
}
