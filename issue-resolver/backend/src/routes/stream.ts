import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import { recordQuestionAnswer } from '../db/question-answers.repo';
import { issues, iterations, stepRuns } from '../db/schema';
import type { StepSessionRegistry, UiResponsePayload } from '../pi/session-registry';
import type { SseHub } from '../sse/hub';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';
const MESSAGE_PATH = '/issue-resolver/api/v1/iterations';

/** Терминальные статусы итерации: повторный abort — no-op. */
const TERMINAL_ITERATION_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Гарантированно переводит итерацию в терминальное `cancelled`, когда живой
 * pi-сессии уже нет (процесс погиб, движок не успел обновить статус).
 * Без этого abort отвечал 409 и итерация навсегда оставалась `running`.
 * Шаги помечаются собственным статусом `aborted` (не `failed`).
 */
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

  const now = new Date().toISOString();
  db.update(iterations)
    .set({ status: 'cancelled', updated_at: now })
    .where(eq(iterations.id, iterationId))
    .run();
  db.update(issues)
    .set({ status: 'cancelled', updated_at: now })
    .where(eq(issues.id, iteration.issue_id))
    .run();
  db.update(stepRuns)
    .set({ status: 'aborted', updated_at: now })
    .where(
      and(
        eq(stepRuns.iteration_id, iterationId),
        inArray(stepRuns.status, ['running', 'pending']),
      ),
    )
    .run();

  hub.publish({
    type: 'iteration_status',
    issueId: iteration.issue_id,
    iterationId,
    data: JSON.stringify({ iterationId, status: 'cancelled', needsInput: false }),
    ts: now,
  });

  return true;
}

/**
 * Live-view: SSE-стрим по задаче + steer/abort пользователя в живую
 * pi-сессию шага итерации (через реестр сессий).
 */
export async function streamRoutes(
  app: FastifyInstance,
  db: Db,
  hub: SseHub,
  control: StepSessionRegistry,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/stream`,
    async (request, reply) => {
      const { id } = request.params;

      const issue = db.select().from(issues).where(eq(issues.id, id)).get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Отправляем заголовки сразу, не дожидаясь первого события.
      reply.raw.flushHeaders();

      const unsubscribe = hub.subscribeByIssue(id, (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      request.raw.on('close', unsubscribe);

      // Отдаём управление Fastify: ответ уже пишется напрямую в сокет.
      reply.hijack();
      return reply;
    },
  );

  app.post<{ Params: { id: string }; Body: { message?: unknown } }>(
    `${MESSAGE_PATH}/:id/message`,
    async (request, reply) => {
      const message = request.body?.message;
      if (typeof message !== 'string' || message.trim().length === 0) {
        return reply.status(400).send({ error: 'message is required' });
      }

      const ok = control.steerByIteration(request.params.id, message);
      if (!ok) {
        return reply.status(409).send({ error: 'no active step session' });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    `${MESSAGE_PATH}/:id/abort`,
    async (request) => {
      const ok = control.abortByIteration(request.params.id);
      if (!ok) {
        // Сессии нет (пи погиб, движок не довёл статус) — не отвечаем 409,
        // а сами доводим итерацию до терминального `failed`.
        markIterationAborted(db, hub, request.params.id);
      }
      return { ok: true };
    },
  );

  // Ответ пользователя на интерактивный вопрос агента
  // (`extension_ui_request` → `extension_ui_response`).
  app.post<{
    Params: { id: string };
    Body: {
      id?: unknown;
      value?: unknown;
      confirmed?: unknown;
      cancelled?: unknown;
    };
  }>(`${MESSAGE_PATH}/:id/ui-response`, async (request, reply) => {
    const body = request.body ?? {};
    const questionId = body.id;
    if (typeof questionId !== 'string' || questionId.trim().length === 0) {
      return reply.status(400).send({ error: 'id is required' });
    }

    const value = typeof body.value === 'string' ? body.value : undefined;
    const confirmed =
      typeof body.confirmed === 'boolean' ? body.confirmed : undefined;
    const cancelled =
      typeof body.cancelled === 'boolean' ? body.cancelled : undefined;
    if (value === undefined && confirmed === undefined && cancelled === undefined) {
      return reply
        .status(400)
        .send({ error: 'value, confirmed or cancelled is required' });
    }

    const payload: UiResponsePayload = {
      id: questionId,
      ...(value !== undefined ? { value } : {}),
      ...(confirmed !== undefined ? { confirmed } : {}),
      ...(cancelled !== undefined ? { cancelled } : {}),
    };

    // Ответ сохраняется до пересылки: сессия могла уже умереть (рестарт
    // движка), но пользовательский выбор не должен потеряться. Ре-ответ
    // идемпотентен. Доставка в живую pi-сессию — best-effort. Если итерации
    // уже нет (её удалили в гонке), сохранять некуда (FK), но роут всё равно
    // отвечает 200 — фронт не должен спотыкаться об ответ на вопрос.
    const iteration = db
      .select({ id: iterations.id })
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
    }
    return { ok: true };
  });
}