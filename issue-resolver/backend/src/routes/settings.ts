import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import {
  createRetroRun,
  getRetroRun,
  getRetroRunWithLog,
  listRetroRuns,
} from '../db/retro-runs.repo';
import { getSetting, setSetting } from '../db/settings.repo';
import {
  abortRetroRun,
  activeRetroRunId,
  runRetroSession,
  type RetroRunDeps,
} from '../retro/service';
import {
  formatZodError,
  startRetroRunRequestSchema,
  updateHostnameRequestSchema,
} from '../validation';

const API_PATH = '/issue-resolver/api/v1';
const HOSTNAME_KEY = 'hostname';
const HOSTNAME_PATH = `${API_PATH}/settings/hostname`;
const RETRO_PATH = `${API_PATH}/settings/retro`;

export async function settingsRoutes(
  app: FastifyInstance,
  db: Db,
  retro?: Omit<RetroRunDeps, 'db'>,
): Promise<void> {
  app.get(HOSTNAME_PATH, async () => ({
    hostname: getSetting(db, HOSTNAME_KEY) ?? '',
  }));

  app.put(HOSTNAME_PATH, async (request, reply) => {
    const parsed = updateHostnameRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }
    setSetting(db, HOSTNAME_KEY, parsed.data.hostname);
    return { hostname: parsed.data.hostname };
  });

  app.post(RETRO_PATH, async (request, reply) => {
    if (!retro) {
      return reply
        .status(503)
        .send({ error: 'запуск ретро не сконфигурирован' });
    }
    const parsed = startRetroRunRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }
    const active = activeRetroRunId();
    if (active) {
      return reply.status(409).send({ error: 'ретро уже идёт', id: active });
    }
    const run = createRetroRun(db, {
      model: parsed.data.model ?? null,
      thinkingLevel: parsed.data.thinking_level ?? null,
      instructions: parsed.data.instructions ?? null,
      sessionLimit: parsed.data.session_limit ?? null,
    });
    void runRetroSession(
      {
        ...retro,
        db,
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        ...(parsed.data.session_limit
          ? { sessionLimit: parsed.data.session_limit }
          : {}),
        ...(parsed.data.instructions
          ? { extraInstructions: parsed.data.instructions }
          : {}),
      },
      run.id,
    ).catch((error) => {
      console.error('retro run failed', { runId: run.id, error });
    });
    return reply.code(202).send(run);
  });

  app.get(RETRO_PATH, async () => ({ runs: listRetroRuns(db) }));

  app.post<{ Params: { id: string } }>(
    `${RETRO_PATH}/:id/abort`,
    async (request, reply) => {
      if (!retro) {
        return reply
          .status(503)
          .send({ error: 'запуск ретро не сконфигурирован' });
      }
      const run = getRetroRun(db, request.params.id);
      if (!run) {
        return reply.status(404).send({ error: 'прогон не найден' });
      }
      const result = abortRetroRun({ ...retro, db }, run.id);
      if (result === 'not_running') {
        return reply.status(409).send({ error: 'прогон уже завершён' });
      }
      if (result === 'unavailable') {
        return reply.status(503).send({ error: 'сессия недоступна' });
      }
      return reply.code(202).send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>(`${RETRO_PATH}/:id`, async (request, reply) => {
    const run = getRetroRunWithLog(db, request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'прогон не найден' });
    }
    return run;
  });
}