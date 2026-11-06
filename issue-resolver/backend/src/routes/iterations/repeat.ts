import { isIterationActive, TaskStatus } from '@issue-resolver/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import { insertMany, listByIteration } from '../../db/issue-files.repo';
import { listIssueRepositories } from '../../db/issue-repositories.repo';
import { issues, iterations } from '../../db/schema';
import { getIssueRow } from '../../issues/queries';
import type { IterationRunDeps } from '../../workflow/run-iteration.service';
import {
  createNextIteration,
  startIterationIssue,
} from '../../workflow/start-iteration';
import { conflict, getIterationRow, notFound } from '../params';
import { nowIso } from '../../db/rows';

const ROUTE_PATH = '/issue-resolver/api/v1/iterations';

function findPendingIteration(db: Db, issueId: string) {
  return db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, issueId),
        eq(iterations.status, TaskStatus.pending),
      ),
    )
    .get();
}

async function copyIterationFiles(
  db: Db,
  issueId: string,
  sourceIterationId: string,
  iterationId: string,
): Promise<void> {
  const sourceFiles = await listByIteration(db, sourceIterationId);
  await insertMany(
    db,
    sourceFiles.map((file) => ({
      issueId,
      iterationId,
      name: file.name,
      relPath: file.rel_path,
      size: file.size,
      mimeType: file.mime_type,
    })),
  );
}

export async function iterationRepeatRoutes(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
): Promise<void> {
  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/repeat`,
    async (request, reply) => {
      const source = getIterationRow(db, request.params.id);
      if (!source) return notFound(reply, 'iteration not found');
      if (isIterationActive(source.status)) {
        return conflict(reply, 'cannot repeat an active iteration');
      }
      const issue = getIssueRow(db, source.issue_id);
      if (!issue) return notFound(reply, 'issue not found');
      const repositories = listIssueRepositories(db, issue.id);

      const created = await createNextIteration(db, deps, {
        issue: startIterationIssue(issue),
        iteration: {
          issueId: issue.id,
          context: source.context,
          reviewContext: source.review_context ?? '',
          isReviewNeed: !!source.is_review_need,
          steps: source.steps,
          model: source.model ?? null,
          step_models: source.step_models ?? undefined,
          thinking_level: source.thinking_level ?? null,
          step_thinking_levels: source.step_thinking_levels ?? undefined,
          worker_count: source.worker_count ?? undefined,
        },
        repositories,
        devops: {
          devopsModel: issue.devops_model ?? undefined,
          devopsThinkingLevel: issue.devops_thinking_level ?? undefined,
        },
        afterCreate: (iteration) =>
          copyIterationFiles(db, issue.id, source.id, iteration.id),
      });
      if (!created.ok) return conflict(reply, created.error);

      return reply.status(201).send(created.iteration);
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/queue`,
    async (request, reply) => {
      const it = getIterationRow(db, request.params.id);
      if (!it) return notFound(reply, 'iteration not found');
      if (it.status !== TaskStatus.draft) {
        return conflict(reply, 'only draft iterations can be queued');
      }
      if (findPendingIteration(db, it.issue_id)) {
        return conflict(reply, 'A pending iteration already exists');
      }
      const now = nowIso();
      db.update(iterations)
        .set({ status: TaskStatus.pending, updated_at: now })
        .where(eq(iterations.id, it.id))
        .run();

      const issue = db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, it.issue_id))
        .get();
      if (
        issue &&
        (issue.status === TaskStatus.completed || issue.status === TaskStatus.failed)
      ) {
        db.update(issues)
          .set({ status: TaskStatus.pending, updated_at: now })
          .where(eq(issues.id, it.issue_id))
          .run();
      }
      return reply.status(200).send({ ...it, status: TaskStatus.pending });
    },
  );
}