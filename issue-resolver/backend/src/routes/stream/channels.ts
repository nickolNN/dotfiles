import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { issues } from '../../db/schema';
import { GLOBAL_STREAM_PATH, ISSUES_PATH, ITERATIONS_PATH, type StreamDeps } from './contracts';
import { openSse } from './sse';
import { badRequest, notFound } from '../params';

export function registerChannels(
  app: FastifyInstance,
  { db, hub }: StreamDeps,
): void {
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
    `${ISSUES_PATH}/:id/stream`,
    async (request, reply) => {
      const { id } = request.params;

      const issue = db.select().from(issues).where(eq(issues.id, id)).get();
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      openSse(reply);

      const unsubscribe = hub.subscribeByIssue(id, (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      request.raw.on('close', unsubscribe);

      reply.hijack();
      return reply;
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { agentId?: string };
  }>(`${ITERATIONS_PATH}/:id/agents/stream`, async (request, reply) => {
    const agentId = request.query.agentId;
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      return badRequest(reply, 'agentId is required');
    }

    openSse(reply);
    const unsubscribe = hub.subscribe(request.params.id, (event) => {
      if (event.agentId !== agentId) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on('close', unsubscribe);
    reply.hijack();
    return reply;
  });
}