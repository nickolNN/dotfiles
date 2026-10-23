import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ContainerStatsPayload } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { recordQuestionAnswer } from '../db/question-answers.repo';
import { issues, iterations, stepRuns } from '../db/schema';
import type { ContainerController } from '../docker/controller';
import { toContainerStatsPayload } from '../docker/controller';
import type { StepSessionRegistry, UiResponsePayload } from '../pi/session-registry';
import type { SseHub } from '../sse/hub';
import { containerNameFor } from '../workspace/paths';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';
const MESSAGE_PATH = '/issue-resolver/api/v1/iterations';
const GLOBAL_STREAM_PATH = '/issue-resolver/api/v1/stream';

/** Интервал keepalive-комментариев в SSE-потоке статистики контейнера. */
const CONTAINER_STATS_HEARTBEAT_MS = 15_000;

/** Глобальный поток статистики контейнера — без привязки к задаче. */
const GLOBAL_CONTAINER_STATS_PATH =
  '/issue-resolver/api/v1/container-stats-stream';
/** Имя контейнера для глобального потока: сам хост/агентский контейнер. */
const GLOBAL_CONTAINER_STATS_CONTAINER = 'host';
/** issueId-псевдоним событий глобального потока (задачи у них нет). */
const GLOBAL_CONTAINER_STATS_ISSUE_ID = '__global__';

/**
 * Открывает SSE-ответ: заголовки + стартовый комментарий «: connected».
 *
 * Комментарий нужен не клиенту, а прокси (Vite dev-proxy, nginx): они держат
 * блок заголовков в буфере, пока не придёт первый байт тела. Стрим, который
 * сразу ничего не пишет, выглядит для `EventSource` незапустившимся: через
 * dev-прокси `container-stats-stream` открывался лишь на первом keepalive
 * (15 с), а поток без событий — никогда. Один байт после `flushHeaders()`
 * снимает буферизацию; через него открываются все SSE-ответы.
 */
function openSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders();
  reply.raw.write(': connected\n\n');
}

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
 * Отдаёт SSE-ответ `container-stats-stream`: заголовки, keepalive, построчный
 * разбор docker-stats NDJSON и публикация `container_stats` в шину под
 * переданным `issueId`. Метрики в сам ответ не пишутся — их доставляет
 * общий/по-задачный SSE-поток; ответ нужен лишь для управления жизненным
 * циклом docker-потока. Захватывает ответ (hijack), поэтому вызывается только
 * после успешного открытия `stream`.
 */
function attachContainerStatsStream(
  request: FastifyRequest,
  reply: FastifyReply,
  hub: SseHub,
  stream: NodeJS.ReadableStream,
  issueId: string,
): void {
  openSse(reply);

  // Комментарий-keepalive, чтобы прокси не рвали простаивающее соединение.
  const heartbeat = setInterval(() => {
    reply.raw.write(': keepalive\n\n');
  }, CONTAINER_STATS_HEARTBEAT_MS);
  const teardown = (): void => {
    clearInterval(heartbeat);
    (
      stream as NodeJS.ReadableStream & { destroy?: () => void }
    ).destroy?.();
  };

  // Docker стримит конкатенированные JSON-объекты без гарантии границы
  // на chunk — держим «хвост» и режем по строкам.
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: ContainerStatsPayload;
      try {
        payload = toContainerStatsPayload(JSON.parse(trimmed));
      } catch {
        continue;
      }
      hub.publish({
        type: 'container_stats',
        issueId,
        data: JSON.stringify(payload),
        ts: new Date().toISOString(),
      });
    }
  });
  // Обрыв/ошибка docker-потока завершает ответ, а не роняет процесс.
  stream.on('error', () => {
    teardown();
    reply.raw.end();
  });
  stream.on('end', () => {
    teardown();
    reply.raw.end();
  });
  request.raw.on('close', teardown);

  reply.hijack();
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
  container: ContainerController,
): Promise<void> {
  // Глобальный поток: все события шины без фильтра по задаче/итерации.
  // Нужен списку задач, который не слушает per-issue канал.
  app.get(GLOBAL_STREAM_PATH, async (request, reply) => {
    openSse(reply);
    const unsubscribe = hub.subscribeGlobal((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on('close', unsubscribe);
    reply.hijack();
    return reply;
  });

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/stream`,
    async (request, reply) => {
      const { id } = request.params;

      const issue = db.select().from(issues).where(eq(issues.id, id)).get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      openSse(reply);

      const unsubscribe = hub.subscribeByIssue(id, (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      request.raw.on('close', unsubscribe);

      // Отдаём управление Fastify: ответ уже пишется напрямую в сокет.
      reply.hijack();
      return reply;
    },
  );

  /**
   * Живой поток статистики контейнера задачи. Периодический поллинг заменён
   * на docker-stats `stream`: бэкенд открывает его, пока клиент держит это
   * SSE-соединение, и публикует каждую метрику событием `container_stats`
   * в общую шину. Доставляет его `/issues/:id/stream` — именно его слушает
   * фронтенд. Сам ответ здесь нужен лишь для управления жизненным циклом
   * docker-потока (и keepalive), метрики в него не пишутся.
   *
   * Задача/контейнер проверяются ДО hijack: 404 отдаётся обычным ответом.
   */
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/container-stats-stream`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, id))
        .get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const containerName = containerNameFor(id);
      let stream: NodeJS.ReadableStream;
      try {
        stream = await container.statsStream(containerName);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) {
          return reply
            .status(404)
            .send({ containerName, error: 'container_not_found' });
        }
        console.error('container stats stream failed', error);
        return reply
          .status(503)
          .send({ containerName, error: 'container_stats_unavailable' });
      }

      attachContainerStatsStream(request, reply, hub, stream, id);
      return reply;
    },
  );

  /**
   * Глобальный поток статистики контейнера (без `:id`): метрики самого
   * контейнера-хоста. Нужен страницам без выбранной задачи. События уходят в
   * шину с `issueId: '__global__'` и доставляются глобальным SSE-потоком
   * (`/issue-resolver/api/v1/stream`).
   */
  app.get(GLOBAL_CONTAINER_STATS_PATH, async (request, reply) => {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await container.statsStream(GLOBAL_CONTAINER_STATS_CONTAINER);
    } catch (error) {
      console.error('global container stats stream failed', error);
      return reply.status(503).send({ error: 'container_stats_unavailable' });
    }

    attachContainerStatsStream(
      request,
      reply,
      hub,
      stream,
      GLOBAL_CONTAINER_STATS_ISSUE_ID,
    );
    return reply;
  });

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
      // Ответ на вопрос возвращает задачу в работу. Только пока итерация
      // `running`: поздний ответ на уже завершённую/отменённую задачу не
      // должен воскрешать её статус.
      if (iteration.status === 'running') {
        db.update(issues)
          .set({ status: 'running', updated_at: new Date().toISOString() })
          .where(eq(issues.id, iteration.issue_id))
          .run();
      }
    }
    return { ok: true };
  });

  // Живые агенты комнаты resolve: роли/индексы/статусы для вкладок фронта.
  app.get<{ Params: { id: string } }>(
    `${MESSAGE_PATH}/:id/agents`,
    async (request, reply) => {
      const iteration = db
        .select({ id: iterations.id })
        .from(iterations)
        .where(eq(iterations.id, request.params.id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }
      return control.listAgents(request.params.id);
    },
  );

  // Поток событий ОДНОГО агента комнаты (`?agentId=<RoomAgent.id>`), чтобы
  // открыть сессию исполнителя отдельно. Контроль (steer/abort) остаётся
  // broadcast на всю комнату — здесь только чтение.
  app.get<{
    Params: { id: string };
    Querystring: { agentId?: string };
  }>(`${MESSAGE_PATH}/:id/agents/stream`, async (request, reply) => {
    const agentId = request.query.agentId;
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      return reply.status(400).send({ error: 'agentId is required' });
    }

    openSse(reply);
    const unsubscribe = hub.subscribe(request.params.id, (event) => {
      // agentId только у эмитов агентов комнаты; прочие — не наш поток.
      if (event.agentId !== agentId) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on('close', unsubscribe);
    reply.hijack();
    return reply;
  });
}