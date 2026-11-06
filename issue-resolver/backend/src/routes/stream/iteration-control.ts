import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { StepRunStatus, TaskStatus } from '@issue-resolver/shared';
import type { Db } from '../../db/client';
import { recordQuestionAnswer } from '../../db/question-answers.repo';
import { issues, iterations, stepRuns } from '../../db/schema';
import type { UiResponsePayload } from '../../pi/session-registry';
import type { SseHub } from '../../sse/hub';
import { ITERATIONS_PATH, type StreamDeps } from './contracts';
import { badRequest, conflict, notFound } from '../params';
import { nowIso } from '../../db/rows';

const TERMINAL_ITERATION_STATUSES: ReadonlySet<string> = new Set([
  TaskStatus.completed,
  TaskStatus.failed,
  TaskStatus.cancelled,
]);

function markIterationAborted(
  db: Db,
  hub: SseHub,
  iterationId: string,
): boolean {
  const iteration = db
    .select()
    .from(iterations)
    .where(eq(iterations.id, iterationId))
    .get();
  if (!iteration) return false;
  if (TERMINAL_ITERATION_STATUSES.has(iteration.status)) return true;

  const now = nowIso();
  db.update(iterations)
    .set({ status: TaskStatus.cancelled, updated_at: now })
    .where(eq(iterations.id, iterationId))
    .run();
  db.update(issues)
    .set({ status: TaskStatus.cancelled, updated_at: now })
    .where(eq(issues.id, iteration.issue_id))
    .run();
  db.update(stepRuns)
    .set({ status: StepRunStatus.aborted, updated_at: now })
    .where(
      and(
        eq(stepRuns.iteration_id, iterationId),
        inArray(stepRuns.status, [
          StepRunStatus.running,
          StepRunStatus.pending,
        ]),
      ),
    )
    .run();

  hub.publish({
    type: 'iteration_status',
    issueId: iteration.issue_id,
    iterationId,
    data: JSON.stringify({
      iterationId,
      status: TaskStatus.cancelled,
      needsInput: false,
    }),
    ts: now,
  });

  return true;
}

export function registerIterationControls(
  app: FastifyInstance,
  { db, hub, control }: StreamDeps,
): void {
  app.post<{ Params: { id: string }; Body: { message?: unknown } }>(
    `${ITERATIONS_PATH}/:id/message`,
    async (request, reply) => {
      const message = request.body?.message;
      if (typeof message !== 'string' || message.trim().length === 0) {
        return badRequest(reply, 'message is required');
      }

      const ok = control.steerByIteration(request.params.id, message);
      if (!ok) {
        return conflict(reply, 'no active step session');
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ITERATIONS_PATH}/:id/abort`,
    async (request) => {
      const ok = control.abortByIteration(request.params.id);
      if (!ok) {
        markIterationAborted(db, hub, request.params.id);
      }
      return { ok: true };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      id?: unknown;
      value?: unknown;
      confirmed?: unknown;
      cancelled?: unknown;
    };
  }>(`${ITERATIONS_PATH}/:id/ui-response`, async (request, reply) => {
    const body = request.body ?? {};
    const questionId = body.id;
    if (typeof questionId !== 'string' || questionId.trim().length === 0) {
      return badRequest(reply, 'id is required');
    }

    const value = typeof body.value === 'string' ? body.value : undefined;
    const confirmed =
      typeof body.confirmed === 'boolean' ? body.confirmed : undefined;
    const cancelled =
      typeof body.cancelled === 'boolean' ? body.cancelled : undefined;
    if (
      value === undefined &&
      confirmed === undefined &&
      cancelled === undefined
    ) {
      return badRequest(reply, 'value, confirmed or cancelled is required');
    }

    const payload: UiResponsePayload = {
      id: questionId,
      ...(value !== undefined ? { value } : {}),
      ...(confirmed !== undefined ? { confirmed } : {}),
      ...(cancelled !== undefined ? { cancelled } : {}),
    };

    const iteration = db
      .select({
        id: iterations.id,
        issue_id: iterations.issue_id,
        status: iterations.status,
      })
      .from(iterations)
      .where(eq(iterations.id, request.params.id))
      .get();
    if (iteration) {
      await recordQuestionAnswer(db, {
        iterationId: request.params.id,
        questionId,
        ...(value !== undefined ? { value } : {}),
        ...(confirmed !== undefined ? { confirmed } : {}),
        ...(cancelled !== undefined ? { cancelled } : {}),
      });
      control.respondByIteration(request.params.id, payload);
      if (iteration.status === TaskStatus.running) {
        db.update(issues)
          .set({
            status: TaskStatus.running,
            updated_at: nowIso(),
          })
          .where(eq(issues.id, iteration.issue_id))
          .run();
      }
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>(
    `${ITERATIONS_PATH}/:id/agents`,
    async (request, reply) => {
      const iteration = db
        .select({ id: iterations.id })
        .from(iterations)
        .where(eq(iterations.id, request.params.id))
        .get();
      if (!iteration) {
        return notFound(reply, 'iteration not found');
      }
      return control.listAgents(request.params.id);
    },
  );
}