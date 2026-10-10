import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import { listAnsweredQuestionIds } from '../db/question-answers.repo';
import { iterations } from '../db/schema';
import { listStepRunsWithLog } from '../db/step-runs.repo';

const ROUTE_PATH = '/issue-resolver/api/v1/iterations';

export async function iterationsRoutes(
  app: FastifyInstance,
  db: Db,
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
}