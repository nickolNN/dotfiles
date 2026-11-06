import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { issues } from '../../db/schema';
import {
  toContainerStatsPayload,
} from '../../docker/controller';
import type { SseHub } from '../../sse/hub';
import type { ContainerStatsPayload } from '@issue-resolver/shared';
import { containerNameFor } from '../../workspace/paths';
import {
  GLOBAL_CONTAINER_STATS_PATH,
  ISSUES_PATH,
  type StreamDeps,
} from './contracts';
import { openSse } from './sse';
import { JSON_PARSE_FAILED, tryParseJson } from '../../util/json-file';
import { notFound } from '../params';
import { nowIso } from '../../db/rows';

const CONTAINER_STATS_HEARTBEAT_MS = 15_000;

const GLOBAL_CONTAINER_STATS_CONTAINER = 'host';
const GLOBAL_CONTAINER_STATS_ISSUE_ID = '__global__';

function attachContainerStatsStream(
  request: FastifyRequest,
  reply: FastifyReply,
  hub: SseHub,
  stream: NodeJS.ReadableStream,
  issueId: string,
): void {
  openSse(reply);

  const heartbeat = setInterval(() => {
    reply.raw.write(': keepalive\n\n');
  }, CONTAINER_STATS_HEARTBEAT_MS);
  const teardown = (): void => {
    clearInterval(heartbeat);
    (
      stream as NodeJS.ReadableStream & { destroy?: () => void }
    ).destroy?.();
  };

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
        const parsed = tryParseJson(trimmed);
        if (parsed === JSON_PARSE_FAILED) continue;
        payload = toContainerStatsPayload(parsed);
      } catch {
        continue;
      }
      hub.publish({
        type: 'container_stats',
        issueId,
        data: JSON.stringify(payload),
        ts: nowIso(),
      });
    }
  });
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

function issueExists(db: Db, id: string): boolean {
  return (
    db.select({ id: issues.id }).from(issues).where(eq(issues.id, id)).get() !==
    undefined
  );
}

export function registerContainerStats(
  app: FastifyInstance,
  { db, hub, container }: StreamDeps,
): void {
  app.get<{ Params: { id: string } }>(
    `${ISSUES_PATH}/:id/container-stats-stream`,
    async (request, reply) => {
      const { id } = request.params;
      if (!issueExists(db, id)) {
        return notFound(reply, 'issue not found');
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
}