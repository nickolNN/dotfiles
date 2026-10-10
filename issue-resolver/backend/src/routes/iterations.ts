import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/client';
import { listAnsweredQuestionIds } from '../db/question-answers.repo';
import { issues, iterations } from '../db/schema';
import { listStepRunsWithLog } from '../db/step-runs.repo';
import type { IterationRunDeps } from '../workflow/run-iteration.service';
import {
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  resultArtifactFor,
} from '../workspace/paths';

const ROUTE_PATH = '/issue-resolver/api/v1/iterations';

export async function iterationsRoutes(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/step-runs`,
    async (request, reply) => {
      const { id } = request.params;

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const runs = await listStepRunsWithLog(db, id);
      // Canonical-порядок уже step-first (pipeline order, внутри шага attempt
      // ASC) — пересортировка не нужна, иначе ломается контракт.
      return runs;
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/question-answers`,
    async (request, reply) => {
      const { id } = request.params;

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const answered_ids = await listAnsweredQuestionIds(db, id);
      return { answered_ids };
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result`,
    async (request, reply) => {
      const { id } = request.params;

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const issue = db
        .select()
        .from(issues)
        .where(eq(issues.id, iteration.issue_id))
        .get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      if (!artifact) {
        return reply.status(404).send({ error: 'result not found' });
      }

      const dir = iterationResultDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        iteration.issue_id,
        iteration.id,
      );
      let body: string;
      try {
        body = await readFile(join(dir, artifact.filename), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'result not found' });
        }
        throw error;
      }

      return reply
        .type(artifact.contentType)
        .header('Content-Disposition', 'inline')
        .send(body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/download`,
    async (request, reply) => {
      const { id } = request.params;

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const issue = db
        .select()
        .from(issues)
        .where(eq(issues.id, iteration.issue_id))
        .get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      if (!artifact) {
        return reply.status(404).send({ error: 'result not found' });
      }

      const dir = iterationResultDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        iteration.issue_id,
        iteration.id,
      );
      let body: string;
      try {
        body = await readFile(join(dir, artifact.filename), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'result not found' });
        }
        throw error;
      }

      return reply
        .type(artifact.contentType)
        .header(
          'Content-Disposition',
          `attachment; filename="${artifact.filename}"`,
        )
        .send(body);
    },
  );
}